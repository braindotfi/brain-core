import type { ConversationReference } from "botbuilder";
import type { Pool, PoolClient } from "pg";
import {
  parseProposal,
  withContentHash,
  type ActorId,
  type Decision,
  type Proposal,
  type SlackTokenProvider,
  type SurfaceName,
} from "@brain/surfaces";
import {
  decryptCredentials,
  encryptCredentials,
  withTenantScope,
  type CredentialKey,
  type TenantScopedClient,
} from "@brain/shared";
import type { DecisionStore, ProposalStore, TenantIdentityStore } from "@brain/core";

type TerminalDecision = Exclude<Decision, "pending" | "expired">;

export class PostgresSurfaceIdentityStore implements TenantIdentityStore {
  public constructor(
    private readonly pool: Pool,
    private readonly userPool: Pool = pool,
  ) {}

  public async lookupActor(input: {
    tenantId: string;
    surface: SurfaceName;
    externalId: string;
  }): Promise<{ actorId: ActorId; roles: string[] } | null> {
    const link = await withTenantScope(this.pool, input.tenantId, async (c) => {
      const { rows } = await c.query<{
        actor_id: string;
        roles: string[];
      }>(
        `SELECT actor_id, roles
           FROM surface_external_identities
          WHERE tenant_id = $1 AND surface = $2 AND external_id = $3
          LIMIT 1`,
        [input.tenantId, input.surface, input.externalId],
      );
      return rows[0] ?? null;
    });
    if (link === null) return null;

    const role = await withTenantScope(this.userPool, input.tenantId, async (c) => {
      const { rows } = await c.query<{ role: string }>(
        `SELECT role FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [input.tenantId, link.actor_id],
      );
      return rows[0]?.role ?? null;
    });

    const roles = new Set(link.roles);
    if (role !== null) roles.add(role);
    return { actorId: link.actor_id as ActorId, roles: [...roles] };
  }
}

export class PostgresSurfaceProposalStore implements ProposalStore {
  public constructor(private readonly pool: Pool) {}

  public async save(input: { proposal: Proposal }): Promise<Proposal> {
    const proposal = input.proposal.contentHash ? input.proposal : withContentHash(input.proposal);
    await withTenantScope(this.pool, proposal.tenantId, async (c) => {
      await c.query(
        `INSERT INTO surface_proposals (tenant_id, proposal_id, proposal, content_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, proposal_id) DO UPDATE
           SET proposal = EXCLUDED.proposal,
               content_hash = EXCLUDED.content_hash`,
        [proposal.tenantId, proposal.id, JSON.stringify(proposal), proposal.contentHash ?? ""],
      );
    });
    return proposal;
  }

  public async load(input: { tenantId: string; proposalId: string }): Promise<Proposal | null> {
    return withTenantScope(this.pool, input.tenantId, async (c) => {
      const { rows } = await c.query<{ proposal: unknown; content_hash: string }>(
        `SELECT proposal, content_hash
           FROM surface_proposals
          WHERE tenant_id = $1 AND proposal_id = $2
          LIMIT 1`,
        [input.tenantId, input.proposalId],
      );
      const row = rows[0];
      if (row === undefined) return null;
      const parsed = parseProposal(row.proposal);
      return { ...parsed, contentHash: row.content_hash };
    });
  }

  public async saveDeliveredRef(input: {
    tenantId: string;
    proposalId: string;
    surface: SurfaceName;
    target: string;
    ref: string;
  }): Promise<void> {
    await withTenantScope(this.pool, input.tenantId, async (c) => {
      await c.query(
        `INSERT INTO surface_delivered_refs
           (tenant_id, proposal_id, surface, target, ref)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, proposal_id, surface, target) DO UPDATE
           SET ref = EXCLUDED.ref, updated_at = now()`,
        [input.tenantId, input.proposalId, input.surface, input.target, input.ref],
      );
    });
  }
}

export class PostgresSurfaceDecisionStore implements DecisionStore {
  public constructor(private readonly pool: Pool) {}

  public async claimTerminal(input: {
    tenantId: string;
    proposalId: string;
    decision: TerminalDecision;
    actorId: ActorId;
    decidedAt: string;
    approverRole?: string | undefined;
    context?: Record<string, string> | undefined;
  }): Promise<
    | { status: "claimed" }
    | {
        status: "already_decided";
        record: {
          tenantId: string;
          proposalId: string;
          decision: TerminalDecision;
          actorId: ActorId;
          decidedAt: string;
          approverRole?: string | undefined;
          applied: boolean;
          context?: Record<string, string> | undefined;
        };
      }
  > {
    return withTenantScope(this.pool, input.tenantId, async (c) => {
      const inserted = await c.query<{ proposal_id: string }>(
        `INSERT INTO surface_decisions
           (tenant_id, proposal_id, decision, actor_id, decided_at, approver_role, context, applied)
         VALUES ($1, $2, $3, $4, $5, $6, $7, false)
         ON CONFLICT (tenant_id, proposal_id) DO NOTHING
         RETURNING proposal_id`,
        [
          input.tenantId,
          input.proposalId,
          input.decision,
          input.actorId,
          input.decidedAt,
          input.approverRole ?? null,
          JSON.stringify(input.context ?? {}),
        ],
      );
      if (inserted.rows[0] !== undefined) return { status: "claimed" };

      const { rows } = await c.query<{
        tenant_id: string;
        proposal_id: string;
        decision: TerminalDecision;
        actor_id: string;
        decided_at: Date;
        approver_role: string | null;
        applied: boolean;
        context: Record<string, string>;
      }>(
        `SELECT tenant_id, proposal_id, decision, actor_id, decided_at, approver_role, applied, context
           FROM surface_decisions
          WHERE tenant_id = $1 AND proposal_id = $2
          LIMIT 1`,
        [input.tenantId, input.proposalId],
      );
      const row = rows[0];
      if (row === undefined) throw new Error("surface_decision_conflict_without_row");
      return {
        status: "already_decided",
        record: {
          tenantId: row.tenant_id,
          proposalId: row.proposal_id,
          decision: row.decision,
          actorId: row.actor_id as ActorId,
          decidedAt: row.decided_at.toISOString(),
          approverRole: row.approver_role ?? undefined,
          applied: row.applied,
          context: row.context,
        },
      };
    });
  }

  public async markTerminalApplied(input: {
    tenantId: string;
    proposalId: string;
    decision: TerminalDecision;
    actorId: ActorId;
    decidedAt: string;
    context?: Record<string, string> | undefined;
  }): Promise<void> {
    await withTenantScope(this.pool, input.tenantId, async (c) => {
      await c.query(
        `UPDATE surface_decisions
            SET applied = true, updated_at = now()
          WHERE tenant_id = $1
            AND proposal_id = $2
            AND decision = $3
            AND actor_id = $4
            AND decided_at = $5`,
        [input.tenantId, input.proposalId, input.decision, input.actorId, input.decidedAt],
      );
    });
  }
}

export class PostgresSlackRetryStore {
  public constructor(private readonly pool: Pool) {}

  public async claim(retryKey: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ retry_key: string }>(
      `INSERT INTO surface_slack_retries (retry_key)
       VALUES ($1)
       ON CONFLICT (retry_key) DO NOTHING
       RETURNING retry_key`,
      [retryKey],
    );
    return rows[0] !== undefined;
  }
}

export interface SlackInstallationSummary {
  tenantId: string;
  teamId: string;
  botUserId: string;
  scopes: string[];
  installedBy: string;
  installedAt: string;
  status: "active" | "revoked";
}

interface SlackInstallationRow {
  tenant_id: string;
  team_id: string;
  bot_token_encrypted: Buffer;
  credential_key_id: string;
  bot_user_id: string;
  scopes: string[];
  installed_by: string;
  installed_at: Date;
  status: "active" | "revoked";
}

interface SlackTokenPayload {
  bot_token: string;
}

export class PostgresSlackInstallationStore {
  public constructor(
    private readonly pool: Pool,
    private readonly credentialKey?: CredentialKey | undefined,
  ) {}

  public async upsertInstallation(input: {
    tenantId: string;
    teamId: string;
    botToken: string;
    botUserId: string;
    scopes: string[];
    installedBy: string;
  }): Promise<void> {
    const credential = this.requiredCredential();
    const encrypted = encryptCredentials(
      { bot_token: input.botToken },
      credential.key,
      credential.keyId,
    );
    await withTenantScope(this.pool, input.tenantId, async (c) => {
      await c.query(
        `INSERT INTO surface_slack_installations
           (tenant_id, team_id, bot_token_encrypted, credential_key_id, bot_user_id,
            scopes, installed_by, status, installed_at, revoked_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', now(), NULL, now())
         ON CONFLICT (tenant_id, team_id) DO UPDATE
           SET bot_token_encrypted = EXCLUDED.bot_token_encrypted,
               credential_key_id = EXCLUDED.credential_key_id,
               bot_user_id = EXCLUDED.bot_user_id,
               scopes = EXCLUDED.scopes,
               installed_by = EXCLUDED.installed_by,
               status = 'active',
               revoked_at = NULL,
               updated_at = now()`,
        [
          input.tenantId,
          input.teamId,
          encrypted.ciphertext,
          encrypted.keyId,
          input.botUserId,
          input.scopes,
          input.installedBy,
        ],
      );
    });
  }

  public async getTokenForTenant(tenantId: string): Promise<string | null> {
    const row = await withTenantScope(this.pool, tenantId, async (c) => {
      const { rows } = await c.query<SlackInstallationRow>(
        `SELECT tenant_id, team_id, bot_token_encrypted, credential_key_id, bot_user_id,
                scopes, installed_by, installed_at, status
           FROM surface_slack_installations
          WHERE tenant_id = $1 AND status = 'active'
          ORDER BY installed_at DESC
          LIMIT 1`,
        [tenantId],
      );
      return rows[0] ?? null;
    });
    if (row === null) return null;
    return this.decryptToken(row);
  }

  public async getInstallationForTenantTeam(input: {
    tenantId: string;
    teamId: string;
  }): Promise<SlackInstallationSummary | null> {
    return withTenantScope(this.pool, input.tenantId, async (c) => {
      const { rows } = await c.query<SlackInstallationRow>(
        `SELECT tenant_id, team_id, bot_token_encrypted, credential_key_id, bot_user_id,
                scopes, installed_by, installed_at, status
           FROM surface_slack_installations
          WHERE tenant_id = $1 AND team_id = $2 AND status = 'active'
          LIMIT 1`,
        [input.tenantId, input.teamId],
      );
      return rows[0] === undefined ? null : toSlackInstallationSummary(rows[0]);
    });
  }

  public async getInstallationByTeam(teamId: string): Promise<SlackInstallationSummary | null> {
    return withSlackTeamScope(this.pool, teamId, async (c) => {
      const { rows } = await c.query<SlackInstallationRow>(
        `SELECT tenant_id, team_id, bot_token_encrypted, credential_key_id, bot_user_id,
                scopes, installed_by, installed_at, status
           FROM surface_slack_installations
          WHERE team_id = $1
          LIMIT 1`,
        [teamId],
      );
      return rows[0] === undefined ? null : toSlackInstallationSummary(rows[0]);
    });
  }

  public async revoke(teamId: string): Promise<void> {
    await withSlackTeamScope(this.pool, teamId, async (c) => {
      await c.query(
        `UPDATE surface_slack_installations
            SET status = 'revoked',
                revoked_at = COALESCE(revoked_at, now()),
                updated_at = now()
          WHERE team_id = $1`,
        [teamId],
      );
    });
  }

  public async createInstallNonce(input: {
    tenantId: string;
    nonce: string;
    installedBy: string;
    expiresAt: Date;
  }): Promise<void> {
    await withTenantScope(this.pool, input.tenantId, async (c) => {
      await c.query(
        `INSERT INTO surface_slack_install_nonces
           (tenant_id, nonce, installed_by, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [input.tenantId, input.nonce, input.installedBy, input.expiresAt],
      );
    });
  }

  public async consumeInstallNonce(input: {
    tenantId: string;
    nonce: string;
    now: Date;
  }): Promise<boolean> {
    return withTenantScope(this.pool, input.tenantId, async (c) => {
      const { rows } = await c.query<{ nonce: string }>(
        `UPDATE surface_slack_install_nonces
            SET consumed_at = $3
          WHERE tenant_id = $1
            AND nonce = $2
            AND consumed_at IS NULL
            AND expires_at > $3
          RETURNING nonce`,
        [input.tenantId, input.nonce, input.now],
      );
      return rows[0] !== undefined;
    });
  }

  private decryptToken(row: SlackInstallationRow): string {
    const credential = this.requiredCredential();
    const decrypted = decryptCredentials(row.bot_token_encrypted, credential.key);
    if (!isSlackTokenPayload(decrypted)) throw new Error("slack_token_payload_invalid");
    return decrypted.bot_token;
  }

  private requiredCredential(): CredentialKey {
    if (this.credentialKey === undefined) {
      throw new Error("slack_installation_credential_key_required");
    }
    return this.credentialKey;
  }
}

export class SlackInstallationTokenProvider implements SlackTokenProvider {
  public constructor(
    private readonly installations: { getTokenForTenant(tenantId: string): Promise<string | null> },
    private readonly fallbackToken?: string | undefined,
  ) {}

  public async tokenForTenant(tenantId: string): Promise<string> {
    const installed = await this.installations.getTokenForTenant(tenantId);
    if (installed !== null) return installed;
    if (this.fallbackToken !== undefined) return this.fallbackToken;
    throw new Error("slack_installation_not_found");
  }
}

export class PostgresTeamsConversationReferenceStore {
  public constructor(private readonly pool: Pool) {}

  public async get(to: string): Promise<Partial<ConversationReference> | null> {
    const parsed = parseConversationRefKey(to);
    if (parsed === null) return null;
    return withTenantScope(this.pool, parsed.tenantId, async (c) => {
      const { rows } = await c.query<{ reference: Partial<ConversationReference> }>(
        `SELECT reference
           FROM surface_teams_conversation_refs
          WHERE tenant_id = $1 AND conversation_ref = $2
          LIMIT 1`,
        [parsed.tenantId, parsed.conversationRef],
      );
      return rows[0]?.reference ?? null;
    });
  }

  public async set(to: string, reference: Partial<ConversationReference>): Promise<void> {
    const parsed = parseConversationRefKey(to);
    if (parsed === null) return;
    await withTenantScope(this.pool, parsed.tenantId, async (c) => {
      await c.query(
        `INSERT INTO surface_teams_conversation_refs (tenant_id, conversation_ref, reference)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, conversation_ref) DO UPDATE
           SET reference = EXCLUDED.reference, updated_at = now()`,
        [parsed.tenantId, parsed.conversationRef, JSON.stringify(reference)],
      );
    });
  }
}

export interface TeamsInstallationSummary {
  brainTenantId: string;
  aadTenantId: string;
  serviceUrl?: string | undefined;
  installedBy: string;
  installedAt: string;
  status: "active" | "revoked";
}

interface TeamsInstallationRow {
  brain_tenant_id: string;
  aad_tenant_id: string;
  service_url: string | null;
  installed_by: string;
  installed_at: Date;
  status: "active" | "revoked";
}

export class PostgresTeamsInstallationStore {
  public constructor(private readonly pool: Pool) {}

  public async upsertInstallation(input: {
    brainTenantId: string;
    aadTenantId: string;
    serviceUrl?: string | undefined;
    installedBy: string;
  }): Promise<void> {
    await withTenantScope(this.pool, input.brainTenantId, async (c) => {
      await c.query(
        `INSERT INTO surface_teams_installations
           (brain_tenant_id, aad_tenant_id, service_url, installed_by, status,
            installed_at, revoked_at, updated_at)
         VALUES ($1, $2, $3, $4, 'active', now(), NULL, now())
         ON CONFLICT (aad_tenant_id) DO UPDATE
           SET brain_tenant_id = EXCLUDED.brain_tenant_id,
               service_url = COALESCE(EXCLUDED.service_url, surface_teams_installations.service_url),
               installed_by = EXCLUDED.installed_by,
               status = 'active',
               revoked_at = NULL,
               updated_at = now()`,
        [input.brainTenantId, input.aadTenantId, input.serviceUrl ?? null, input.installedBy],
      );
    });
  }

  public async resolveBrainTenant(aadTenantId: string): Promise<TeamsInstallationSummary | null> {
    return withTeamsAadScope(this.pool, aadTenantId, async (c) => {
      const { rows } = await c.query<TeamsInstallationRow>(
        `SELECT brain_tenant_id, aad_tenant_id, service_url, installed_by, installed_at, status
           FROM surface_teams_installations
          WHERE aad_tenant_id = $1
          LIMIT 1`,
        [aadTenantId],
      );
      return rows[0] === undefined ? null : toTeamsInstallationSummary(rows[0]);
    });
  }

  public async recordActivity(input: {
    brainTenantId: string;
    aadTenantId: string;
    serviceUrl?: string | undefined;
  }): Promise<void> {
    await withTenantScope(this.pool, input.brainTenantId, async (c) => {
      await c.query(
        `UPDATE surface_teams_installations
            SET service_url = COALESCE($3, service_url),
                last_activity_at = now(),
                updated_at = now()
          WHERE brain_tenant_id = $1
            AND aad_tenant_id = $2
            AND status = 'active'`,
        [input.brainTenantId, input.aadTenantId, input.serviceUrl ?? null],
      );
    });
  }

  public async revoke(aadTenantId: string): Promise<void> {
    await withTeamsAadScope(this.pool, aadTenantId, async (c) => {
      await c.query(
        `UPDATE surface_teams_installations
            SET status = 'revoked',
                revoked_at = COALESCE(revoked_at, now()),
                updated_at = now()
          WHERE aad_tenant_id = $1`,
        [aadTenantId],
      );
    });
  }

  public async isActiveForTenant(brainTenantId: string): Promise<boolean> {
    return withTenantScope(this.pool, brainTenantId, async (c) => {
      const { rows } = await c.query<{ found: number }>(
        `SELECT 1 AS found
           FROM surface_teams_installations
          WHERE brain_tenant_id = $1
            AND status = 'active'
          LIMIT 1`,
        [brainTenantId],
      );
      return rows[0] !== undefined;
    });
  }
}

async function withSlackTeamScope<T>(
  pool: Pool,
  teamId: string,
  fn: (client: TenantScopedClient) => Promise<T>,
): Promise<T> {
  const client: PoolClient = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.slack_team_id', $1, true)", [teamId]);
    const scoped: TenantScopedClient = {
      query: (text, values) =>
        client.query(text, values as unknown as unknown[]) as Promise<{
          rows: never[];
          rowCount: number | null;
        }>,
    };
    const result = await fn(scoped);
    await client.query("COMMIT");
    committed = true;
    return result;
  } catch (err) {
    if (!committed) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

async function withTeamsAadScope<T>(
  pool: Pool,
  aadTenantId: string,
  fn: (client: TenantScopedClient) => Promise<T>,
): Promise<T> {
  const client: PoolClient = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.teams_aad_tenant_id', $1, true)", [aadTenantId]);
    const scoped: TenantScopedClient = {
      query: (text, values) =>
        client.query(text, values as unknown as unknown[]) as Promise<{
          rows: never[];
          rowCount: number | null;
        }>,
    };
    const result = await fn(scoped);
    await client.query("COMMIT");
    committed = true;
    return result;
  } catch (err) {
    if (!committed) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

function toSlackInstallationSummary(row: SlackInstallationRow): SlackInstallationSummary {
  return {
    tenantId: row.tenant_id,
    teamId: row.team_id,
    botUserId: row.bot_user_id,
    scopes: row.scopes,
    installedBy: row.installed_by,
    installedAt: row.installed_at.toISOString(),
    status: row.status,
  };
}

function toTeamsInstallationSummary(row: TeamsInstallationRow): TeamsInstallationSummary {
  return {
    brainTenantId: row.brain_tenant_id,
    aadTenantId: row.aad_tenant_id,
    ...(row.service_url !== null ? { serviceUrl: row.service_url } : {}),
    installedBy: row.installed_by,
    installedAt: row.installed_at.toISOString(),
    status: row.status,
  };
}

function isSlackTokenPayload(value: object): value is SlackTokenPayload {
  return (
    "bot_token" in value &&
    typeof (value as { bot_token?: unknown }).bot_token === "string" &&
    (value as { bot_token: string }).bot_token.length > 0
  );
}

function parseConversationRefKey(to: string): { tenantId: string; conversationRef: string } | null {
  const separator = to.indexOf(":");
  if (separator <= 0 || separator === to.length - 1) return null;
  return { tenantId: to.slice(0, separator), conversationRef: to.slice(separator + 1) };
}
