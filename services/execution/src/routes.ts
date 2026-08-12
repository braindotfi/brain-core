/**
 * §Execution endpoints (proposal state machine §8.1, execution state machine
 * §8.2, agent registration §8.4). Despite the "v0.2" framing, most of this
 * surface is LIVE, not vestigial: `/execution/propose`, `/approve`,
 * `/escalate`, `/{execution_id}`, and `/agents*` are the generic action
 * proposal/approval API consumed by the published SDK `actions` resource and by
 * the Python reasoning agents (reconciliation / payment / anomaly call
 * `POST /v1/execution/propose`). Do not delete them without first providing a
 * v0.3 replacement and migrating both consumers.
 *
 * Two sub-routes ARE inert: `/execution/execute` is decommissioned (it bypassed
 * the §6 gate; money movement goes through `/payment-intents/*` /
 * `/actions/{id}/execute`), and `/execution/mcp` is a deprecated ping-only shim
 * superseded by `/v1/agents/mcp` (the real MCP server, services/mcp).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  KNOWN_AGENT_ROLES,
  MCP_UNATTESTED_SCOPES,
  scopesForAgentRole,
} from "@brain/internal-agents";
import {
  brainError,
  computeAgentScopeHash,
  extractRawBody,
  isBrainId,
  newAgentId,
  newProposalId,
  requireScope,
  singleHeaderValue,
  verifyServiceAuthSignatureV2,
  withTenantScope,
  type Scope,
} from "@brain/shared";
import {
  appendApproverSigned,
  findAgent,
  findExecution,
  findProposal,
  insertAgent,
  insertProposal,
  listAgents,
  transitionProposal,
  type ProposalRow,
} from "./repository.js";
import type { ExecutionDeps } from "./deps.js";

const PROPOSE: Scope = "execution:propose";
const WRITE: Scope = "execution:write";
const READ: Scope = "execution:read";
const ADMIN: Scope = "execution:admin";
const POLICY_WRITE: Scope = "policy:write";

/* RFC 0002 Phase C, increment 1: the three attestation_mode values a caller
 * may set on POST /execution/agents/register. Kept as a plain literal set
 * (not shared with services/mcp -- that would invert the mcp -> execution
 * dependency) mirroring the CHECK constraint in
 * services/execution/migrations/0031_agents_attestation_mode.sql. */
const VALID_ATTESTATION_MODES = new Set(["none", "tenant_signed", "onchain_custodial"]);

/* POST /agents (increment 2) accepts either execution:admin (member-role
 * admin, shared/src/auth/scopes.ts MEMBER_ROLE_SCOPES.admin) or policy:write
 * (tenant owner, services/api/src/onboarding/login.ts OWNER_SCOPES). Neither
 * vocabulary alone covers both callers this route must accept, and
 * execution:admin is deliberately NOT added to OWNER_SCOPES -- it also gates
 * member management, API-key mint/revoke, and agent halt/restore, none of
 * which a tenant owner token should gain as a side effect of this route. */
function requireAdminOrPolicyWrite(scopes: readonly string[]): void {
  if (!scopes.includes(ADMIN) && !scopes.includes(POLICY_WRITE)) {
    throw brainError("auth_scope_insufficient", `requires one of: ${ADMIN}, ${POLICY_WRITE}`, {
      details: { required_any_of: [ADMIN, POLICY_WRITE], held: scopes },
    });
  }
}

const AGENT_CREATE_FIELDS = new Set([
  "role",
  "display_name",
  "onchain_address",
  "attestation_mode",
]);

/** Rejects agent_id, scope_hash, state, or any other field the server must
 *  own -- the caller mints none of those on this route (the server mints
 *  agent_id and derives scope_hash; state is always server-computed). */
function rejectUnknownAgentCreateFields(body: Record<string, unknown>): void {
  const found = Object.keys(body).filter((key) => !AGENT_CREATE_FIELDS.has(key));
  if (found.length > 0) {
    throw brainError("request_body_invalid", "unknown_field", {
      details: { reason: "unknown_field", fields: found },
    });
  }
}

function proposedAgentId(principal: NonNullable<FastifyRequest["principal"]>, requested?: string) {
  if (requested !== undefined && principal.scopes.includes(ADMIN)) {
    return requested;
  }
  return principal.id;
}

/**
 * Resolve which tenant a proposal (and its execution.propose audit event)
 * should land in. Same trust model and v2 HMAC scheme as Raw's
 * resolveWriteAuthorization (services/raw/src/routes/parsed.ts, the same
 * @brain/shared primitives): defaults to the JWT principal's own tenant, and
 * only honors a caller-supplied X-Brain-Write-Tenant header when
 * deps.crossTenantServiceSecret is configured AND the request carries a
 * verified v2 X-Brain-Service-Auth HMAC (body + timestamp + write-tenant,
 * within the bounded replay window) over the raw request body. Any missing
 * configuration or signature/timestamp/tenant-binding mismatch falls back to
 * the principal's tenant (RFC F2 back-compat for every caller except propose
 * itself, which the Python client refuses to call at all without a working
 * signature -- see brain_agents.client.BrainApiClient.propose).
 */
function resolveProposeTenant(
  request: FastifyRequest,
  principalTenantId: string,
  crossTenantServiceSecret: string | undefined,
): string {
  if (crossTenantServiceSecret === undefined || crossTenantServiceSecret.length === 0) {
    return principalTenantId;
  }
  const signatureHeader = singleHeaderValue(request.headers["x-brain-service-auth"]);
  const timestampHeader = singleHeaderValue(request.headers["x-brain-service-timestamp"]);
  const targetTenantHeader = singleHeaderValue(request.headers["x-brain-write-tenant"]);
  // The empty string is itself the signed value for "no redirect requested"
  // -- see resolveWriteAuthorization in parsed.ts for the same reasoning.
  const signedWriteTenant = targetTenantHeader ?? "";
  const rawBody = extractRawBody(request.body);
  if (
    !verifyServiceAuthSignatureV2(
      rawBody,
      signatureHeader,
      timestampHeader,
      signedWriteTenant,
      crossTenantServiceSecret,
    )
  ) {
    return principalTenantId;
  }
  return signedWriteTenant.length > 0 ? signedWriteTenant : principalTenantId;
}

export async function registerExecutionRoutes(
  app: FastifyInstance,
  deps: ExecutionDeps,
): Promise<void> {
  // POST /execution/propose. Registered in its own encapsulated child so the
  // raw-body-capturing content-type parser below (needed to verify
  // X-Brain-Service-Auth, RFC F2) never touches any other execution route's
  // body parsing, regardless of whether the caller mounts this on the api
  // monolith's shared app or the standalone execution server's own app.
  await app.register(async (child) => {
    child.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_req: unknown, body: Buffer, done: (err: Error | null, body?: unknown) => void) => {
        try {
          const parsed =
            body.length > 0 ? (JSON.parse(body.toString("utf8")) as Record<string, unknown>) : {};
          parsed["__rawBody"] = body;
          done(null, parsed);
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );

    child.post(
      "/execution/propose",
      async (
        request: FastifyRequest<{ Body: { action?: Record<string, unknown>; agent_id?: string } }>,
        reply,
      ) => {
        const principal = requirePrincipal(request);
        requireScope(principal.scopes, PROPOSE);

        const action = request.body?.action;
        if (action === undefined) {
          throw brainError("request_body_invalid", "action required");
        }
        const tenantId = resolveProposeTenant(
          request,
          principal.tenantId,
          deps.crossTenantServiceSecret,
        );
        const decision = await deps.evaluatePolicy(tenantId, action);
        const proposingAgent = proposedAgentId(principal, request.body?.agent_id);

        const row = await withTenantScope(deps.pool, tenantId, (c) =>
          insertProposal(c, {
            id: newProposalId(),
            tenantId,
            proposingAgent,
            action,
            policyVersion: decision.policy_version,
            policyDecision: decision.outcome,
            policyTrace: decision.trace as ProposalRow["policy_trace"],
            requiredApprovers: decision.required_approvers,
            status:
              decision.outcome === "reject"
                ? "rejected"
                : decision.outcome === "allow"
                  ? "approved"
                  : "pending",
          }),
        );

        await deps.audit.emit({
          tenantId,
          layer: "execution",
          actor: principal.id,
          action: "execution.propose",
          inputs: { action_kind: String(action.kind ?? "unknown"), agent: proposingAgent },
          outputs: {
            proposal_id: row.id,
            decision: decision.outcome,
            policy_version: decision.policy_version,
          },
          policyVersion: decision.policy_version,
        });

        reply.status(201);
        return serializeProposal(row);
      },
    );
  });

  // POST /execution/execute
  //
  // DECOMMISSIONED money path. This legacy v0.2 route dispatched a proposal
  // through a payment rail with NO §6 pre-execution gate — no policy decision,
  // no sanctions / balance / amount-limit checks, and no audit before/after
  // pair. Standards §6 ("no execution path may bypass the gate") and §9.5
  // ("financial actions use PaymentIntent, not Proposal") forbid that. Money
  // movement must go through POST /actions/{id}/execute (or the deprecated
  // /payment-intents/{id}/execute), both of which run the gate. We refuse here
  // rather than reproduce the boundary violation in new code (§14 rule 3).
  app.post(
    "/execution/execute",
    async (request: FastifyRequest<{ Body: { proposal_id?: string; rail?: string } }>) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, WRITE);
      throw brainError(
        "gate_no_policy_decision",
        "the legacy /execution/execute route is disabled because it bypasses the §6 pre-execution gate; execute money movement via POST /actions/{id}/execute, which runs the gate",
      );
    },
  );

  // GET /execution/{execution_id}
  app.get(
    "/execution/:execution_id",
    async (request: FastifyRequest<{ Params: { execution_id: string } }>, reply) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, READ);
      const id = request.params.execution_id;
      if (!isBrainId(id, "exec")) {
        throw brainError("request_params_invalid", "malformed execution_id");
      }
      const row = await withTenantScope(deps.pool, principal.tenantId, (c) => findExecution(c, id));
      if (row === null) throw brainError("execution_proposal_not_found", "no such execution");
      reply.status(200);
      return serializeExecution(row);
    },
  );

  // POST /execution/approve
  app.post(
    "/execution/approve",
    async (request: FastifyRequest<{ Body: { proposal_id?: string } }>, reply) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, WRITE);
      const proposalId = request.body?.proposal_id;
      if (proposalId === undefined)
        throw brainError("request_body_invalid", "proposal_id required");

      const row = await withTenantScope(deps.pool, principal.tenantId, async (c) => {
        const proposal = await findProposal(c, proposalId);
        if (proposal === null) throw brainError("execution_proposal_not_found", "no such proposal");
        if (proposal.status !== "pending") {
          throw brainError("execution_proposal_invalid_state", "proposal is not pending approval");
        }
        const updated = await appendApproverSigned(c, proposalId, principal.id);
        if (updated === null) {
          // already signed — return the existing proposal.
          return proposal;
        }
        const signed = new Set(updated.approvers_signed);
        const required = new Set(updated.required_approvers);
        // Legacy v0.2 approval is satisfied by approver-id signature presence.
        // This path has no org-role membership model; tenant org roles + quorum
        // live in the PaymentIntent / ApprovalService path (the v0.3 approval
        // surface). New integrations approve via /payment-intents/*.
        const allSigned = Array.from(required).every((r) => signed.has(r));
        if (allSigned) {
          return transitionProposal(c, proposalId, "pending", "approved");
        }
        return updated;
      });

      await deps.audit.emit({
        tenantId: principal.tenantId,
        layer: "execution",
        actor: principal.id,
        action: "execution.approve",
        inputs: { proposal_id: proposalId },
        outputs: { status: row.status, approvers_signed: row.approvers_signed },
      });

      reply.status(200);
      return serializeProposal(row);
    },
  );

  // POST /execution/escalate
  app.post(
    "/execution/escalate",
    async (request: FastifyRequest<{ Body: { proposal_id?: string; note?: string } }>, reply) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, PROPOSE);
      const proposalId = request.body?.proposal_id;
      if (proposalId === undefined)
        throw brainError("request_body_invalid", "proposal_id required");
      await deps.audit.emit({
        tenantId: principal.tenantId,
        layer: "execution",
        actor: principal.id,
        action: "execution.escalate",
        inputs: { proposal_id: proposalId, note: (request.body?.note ?? "").slice(0, 200) },
        outputs: {},
      });
      reply.status(202);
      return { escalated: true, proposal_id: proposalId };
    },
  );

  // GET /execution/agents
  app.get("/execution/agents", async (request, reply) => {
    const principal = requirePrincipal(request);
    requireScope(principal.scopes, READ);
    const agents = await withTenantScope(deps.pool, principal.tenantId, (c) => listAgents(c));
    reply.status(200);
    return { agents: agents.map(serializeAgent) };
  });

  // POST /execution/agents/register
  app.post(
    "/execution/agents/register",
    async (
      request: FastifyRequest<{
        Body: {
          agent_id?: string;
          role?: string;
          display_name?: string;
          scope_hash?: string;
          onchain_address?: string;
          registered_tx?: string;
          attestation_mode?: string;
        };
      }>,
      reply,
    ) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, ADMIN);
      const b = request.body ?? {};
      if (b.agent_id === undefined || b.role === undefined || b.display_name === undefined) {
        throw brainError("request_body_invalid", "agent_id, role, display_name required");
      }
      // Defaults to the pre-existing behavior ("onchain_custodial"): every
      // agent still requires BrainMCPAgentRegistry confirmation unless a
      // caller explicitly opts a read-only agent into the tier-1 unattested
      // path. Increment 2 (POST /v1/agents) is the intended primary caller of
      // "none"; this route accepting it too keeps the one insert path.
      const attestationMode = b.attestation_mode ?? "onchain_custodial";
      if (!VALID_ATTESTATION_MODES.has(attestationMode)) {
        throw brainError(
          "request_body_invalid",
          "attestation_mode must be one of: " + Array.from(VALID_ATTESTATION_MODES).join(", "),
          { details: { attestation_mode: attestationMode } },
        );
      }
      const isUnattested = attestationMode === "none";
      // A caller-supplied scope_hash must be the canonical derivation for the
      // supplied role, or a bare insert here could plant a non-canonical hash
      // (the same class of bug the seed-golden-path seeder had). An omitted
      // scope_hash still stores null, unchanged from the prior contract.
      if (b.scope_hash !== undefined) {
        const canonical = computeAgentScopeHash(scopesForAgentRole(b.role!)).slice(2);
        if (b.scope_hash.toLowerCase() !== canonical.toLowerCase()) {
          throw brainError(
            "agent_scope_hash_mismatch",
            "scope_hash is not the canonical derivation for role " + b.role!,
            { details: { role: b.role!, supplied_hash: b.scope_hash!, canonical_hash: canonical } },
          );
        }
      }
      const row = await withTenantScope(deps.pool, principal.tenantId, (c) =>
        insertAgent(c, {
          id: b.agent_id!,
          tenant_id: principal.tenantId,
          kind: "external",
          role: b.role!,
          display_name: b.display_name!,
          scope_hash: b.scope_hash !== undefined ? Buffer.from(b.scope_hash, "hex") : null,
          onchain_address: b.onchain_address ?? null,
          state: isUnattested ? "active" : "pending_onchain",
          // Tier-1 has no on-chain confirmation to record; ignore any
          // caller-supplied registered_tx rather than storing a value that
          // implies a registration that never happened.
          registered_tx: isUnattested ? null : (b.registered_tx ?? null),
          attestation_mode: attestationMode,
          ...(isUnattested ? { registeredAt: new Date() } : {}),
        }),
      );
      await deps.audit.emit({
        tenantId: principal.tenantId,
        layer: "execution",
        actor: principal.id,
        action: "execution.agent.register",
        inputs: { agent_id: row.id, role: row.role, attestation_mode: row.attestation_mode },
        outputs: { state: row.state },
      });
      reply.status(201);
      return serializeAgent(row);
    },
  );

  // POST /agents (RFC 0002 Phase C, increment 2) -- self-serve agent
  // registration. Distinct from POST /execution/agents/register above: this
  // route MINTS agent_id and DERIVES scope_hash from role rather than
  // accepting either as caller-supplied input, so a caller cannot plant a
  // non-canonical hash or collide an id. Accepts execution:admin OR
  // policy:write (see requireAdminOrPolicyWrite) so both a member-role admin
  // and a self-serve tenant owner can call it.
  app.post(
    "/agents",
    { config: { idempotent: true } },
    async (
      request: FastifyRequest<{
        Body: {
          role?: string;
          display_name?: string;
          onchain_address?: string;
          attestation_mode?: string;
        };
      }>,
      reply,
    ) => {
      const principal = requirePrincipal(request);
      requireAdminOrPolicyWrite(principal.scopes);

      const rawBody = request.body;
      if (
        rawBody === undefined ||
        rawBody === null ||
        typeof rawBody !== "object" ||
        Array.isArray(rawBody)
      ) {
        throw brainError("request_body_invalid", "body must be an object");
      }
      const body = rawBody as Record<string, unknown>;
      rejectUnknownAgentCreateFields(body);

      const role = body["role"];
      const displayName = body["display_name"];
      const onchainAddress = body["onchain_address"];
      const attestationMode = body["attestation_mode"];
      if (
        typeof role !== "string" ||
        role.length === 0 ||
        typeof displayName !== "string" ||
        displayName.length === 0 ||
        typeof attestationMode !== "string"
      ) {
        throw brainError("request_body_invalid", "role, display_name, attestation_mode required");
      }
      if (!VALID_ATTESTATION_MODES.has(attestationMode)) {
        throw brainError(
          "request_body_invalid",
          "attestation_mode must be one of: " + Array.from(VALID_ATTESTATION_MODES).join(", "),
          { details: { attestation_mode: attestationMode } },
        );
      }

      // Clause 1: role must be a known role. scopesForAgentRole silently
      // falls through to a read-heavy default for anything else, so an
      // unrecognized role must be rejected here rather than trusting that
      // function to fail on a typo.
      if (!KNOWN_AGENT_ROLES.includes(role)) {
        throw brainError("request_body_invalid", "unknown role", {
          details: { role, known_roles: KNOWN_AGENT_ROLES },
        });
      }
      const roleScopes = scopesForAgentRole(role);
      const isUnattested = attestationMode === "none";

      if (isUnattested) {
        // Clause 2: "none" (tier-1 unattested) is only valid for a role whose
        // full scope set is read-only and contained in MCP_UNATTESTED_SCOPES
        // -- the identical predicate McpAuthVerifier.verify
        // (services/mcp/src/auth.ts) enforces at request time, imported from
        // the same constant so the two can never drift apart. A caller must
        // not be able to self-declare tier 1 for a money-path role.
        const eligible =
          roleScopes.length > 0 && roleScopes.every((s) => MCP_UNATTESTED_SCOPES.has(s));
        if (!eligible) {
          throw brainError(
            "request_body_invalid",
            "attestation_mode none requires a role whose scopes are a subset of the unattested read-only scopes",
            { details: { role, role_scopes: roleScopes } },
          );
        }
      } else {
        // Clause 3: any attested mode needs an on-chain address to attest.
        if (typeof onchainAddress !== "string" || onchainAddress.length === 0) {
          throw brainError(
            "request_body_invalid",
            `onchain_address required for attestation_mode ${attestationMode}`,
          );
        }
        // Clause 4: the on-chain registration relayer that would submit this
        // attestation is not built until RFC 0002 Phase C increments 3/4 --
        // same error AgentService.confirmRegistration returns when no relayer
        // is configured, rather than pretending the mode works today.
        throw brainError(
          "agent_rail_unavailable",
          `attestation_mode ${attestationMode} requires the on-chain registration relayer, which is not yet available`,
          { details: { attestation_mode: attestationMode } },
        );
      }

      const scopeHash = computeAgentScopeHash(roleScopes).slice(2);
      const agentId = newAgentId();
      const row = await withTenantScope(deps.pool, principal.tenantId, (c) =>
        insertAgent(c, {
          id: agentId,
          tenant_id: principal.tenantId,
          kind: "external",
          role,
          display_name: displayName,
          scope_hash: Buffer.from(scopeHash, "hex"),
          onchain_address: typeof onchainAddress === "string" ? onchainAddress : null,
          state: isUnattested ? "active" : "pending_onchain",
          registered_tx: null,
          attestation_mode: attestationMode,
          ...(isUnattested ? { registeredAt: new Date() } : {}),
        }),
      );

      // Only attestationMode === "none" ever reaches this line today --
      // the else branch above always throws agent_rail_unavailable for
      // tenant_signed/onchain_custodial, so custodial is always false until
      // increments 3/4 wire the relayer and remove that throw. Written as a
      // literal comparison rather than hardcoded false so it self-corrects
      // once that branch stops always throwing.
      const custodial: boolean = (attestationMode as string) === "onchain_custodial";
      await deps.audit.emit({
        tenantId: principal.tenantId,
        layer: "execution",
        actor: principal.id,
        action: "agent.registered",
        inputs: { role, attestation_mode: attestationMode },
        outputs: { state: row.state, custodial },
      });

      reply.status(201);
      return { ...serializeAgent(row), custodial };
    },
  );

  // GET /execution/agents/{agent_id}
  app.get(
    "/execution/agents/:agent_id",
    async (request: FastifyRequest<{ Params: { agent_id: string } }>, reply) => {
      const principal = requirePrincipal(request);
      requireScope(principal.scopes, READ);
      const row = await withTenantScope(deps.pool, principal.tenantId, (c) =>
        findAgent(c, request.params.agent_id),
      );
      if (row === null) throw brainError("execution_agent_not_registered", "no such agent");
      reply.status(200);
      return serializeAgent(row);
    },
  );

  // POST /execution/mcp — DEPRECATED v0.2 back-compat shim.
  // The live MCP surface is POST /v1/agents/mcp (services/mcp): a JSON-RPC 2.0
  // server with 12 tools, 7 resource URIs, and 5 prompts. This legacy route
  // only ever answered `ping`; it is retained for the v0.3 transition window
  // (Brain_MVP_Architecture.md "Backward-compat note") and points callers at
  // the real surface rather than returning a bare "not implemented".
  app.post(
    "/execution/mcp",
    async (
      request: FastifyRequest<{ Body: { method?: string; params?: Record<string, unknown> } }>,
      reply,
    ) => {
      const principal = requirePrincipal(request);
      if (principal.type !== "agent") {
        throw brainError(
          "auth_scope_insufficient",
          "MCP surface accepts principal_type=agent only",
        );
      }
      const method = request.body?.method;
      if (method === undefined) {
        throw brainError("request_body_invalid", "method required");
      }
      if (method === "ping") {
        return reply.status(200).send({ ok: true });
      }
      throw brainError(
        "execution_agent_not_registered",
        `the /execution/mcp shim is deprecated and only retains 'ping'; ` +
          `use POST /v1/agents/mcp for the full MCP surface (requested method: ${method})`,
        { statusOverride: 501 },
      );
    },
  );
}

function requirePrincipal(request: FastifyRequest) {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  return request.principal;
}

function serializeProposal(row: ProposalRow): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    action: row.action,
    policy_version: row.policy_version,
    policy_decision: row.policy_decision,
    required_approvers: row.required_approvers,
    approvers_signed: row.approvers_signed,
    proposing_agent: row.proposing_agent,
    created_at: row.created_at.toISOString(),
  };
}

function serializeExecution(row: {
  id: string;
  proposal_id: string;
  rail: string;
  rail_receipt: Record<string, unknown> | null;
  status: string;
  started_at: Date;
  completed_at: Date | null;
}): Record<string, unknown> {
  return {
    id: row.id,
    proposal_id: row.proposal_id,
    rail: row.rail,
    rail_receipt: row.rail_receipt,
    status: row.status,
    started_at: row.started_at.toISOString(),
    completed_at: row.completed_at?.toISOString() ?? null,
  };
}

function serializeAgent(row: {
  id: string;
  kind: string;
  role: string;
  display_name: string;
  scope_hash: Buffer | null;
  onchain_address: string | null;
  state: string;
  registered_tx: string | null;
  registered_at: Date | null;
  attestation_mode: string;
}): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    role: row.role,
    display_name: row.display_name,
    scope_hash: row.scope_hash === null ? null : row.scope_hash.toString("hex"),
    onchain_address: row.onchain_address,
    state: row.state,
    registered_tx: row.registered_tx,
    registered_at: row.registered_at?.toISOString() ?? null,
    attestation_mode: row.attestation_mode,
  };
}
