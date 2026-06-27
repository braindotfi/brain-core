import type { ConversationReference } from "botbuilder";
import type { Pool } from "pg";
import {
  parseProposal,
  withContentHash,
  type ActorId,
  type Decision,
  type Proposal,
  type SurfaceName,
} from "@brain/surfaces";
import { withTenantScope } from "@brain/shared";
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
          applied: boolean;
          context?: Record<string, string> | undefined;
        };
      }
  > {
    return withTenantScope(this.pool, input.tenantId, async (c) => {
      const inserted = await c.query<{ proposal_id: string }>(
        `INSERT INTO surface_decisions
           (tenant_id, proposal_id, decision, actor_id, decided_at, context, applied)
         VALUES ($1, $2, $3, $4, $5, $6, false)
         ON CONFLICT (tenant_id, proposal_id) DO NOTHING
         RETURNING proposal_id`,
        [
          input.tenantId,
          input.proposalId,
          input.decision,
          input.actorId,
          input.decidedAt,
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
        applied: boolean;
        context: Record<string, string>;
      }>(
        `SELECT tenant_id, proposal_id, decision, actor_id, decided_at, applied, context
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

function parseConversationRefKey(to: string): { tenantId: string; conversationRef: string } | null {
  const separator = to.indexOf(":");
  if (separator <= 0 || separator === to.length - 1) return null;
  return { tenantId: to.slice(0, separator), conversationRef: to.slice(separator + 1) };
}
