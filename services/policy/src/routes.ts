/**
 * Policy routes: 6 endpoints per Brain_API_Specification.yaml §Policy.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { verifyTypedData } from "viem";
import {
  brainError,
  isBrainId,
  newPolicyId,
  requireScope,
  withTenantScope,
  type Scope,
} from "@brain/shared";
import { contentHash, type PolicyDocument } from "./dsl.js";
import { buildTypedData } from "./signing.js";
import {
  getActive,
  getByVersion,
  insertPolicy,
  listVersions,
  setSigners,
  transition,
  type PolicyRow,
} from "./repository.js";
import { evaluate, type Action } from "./vm.js";
import { simulateHistorical, type ReplayAction } from "./simulator.js";
import { lintPolicy } from "./linter.js";
import { diffPolicies } from "./policy-diff.js";
import type { PolicyDeps } from "./deps.js";

const READ: Scope = "policy:read";
const WRITE: Scope = "policy:write";
const SIGN: Scope = "policy:sign";

export async function registerPolicyRoutes(app: FastifyInstance, deps: PolicyDeps): Promise<void> {
  // GET /policy/:tenant_id
  app.get(
    "/policy/:tenant_id",
    async (request: FastifyRequest<{ Params: { tenant_id: string } }>, reply) => {
      const tenant = assertTenantAccess(request, request.params.tenant_id, READ);
      const row = await withTenantScope(deps.pool, tenant, (c) => getActive(c));
      if (row === null) {
        throw brainError("policy_not_found", "no active policy for tenant");
      }
      reply.status(200);
      return serialize(row);
    },
  );

  // GET /policy/:tenant_id/versions
  app.get(
    "/policy/:tenant_id/versions",
    async (request: FastifyRequest<{ Params: { tenant_id: string } }>, reply) => {
      const tenant = assertTenantAccess(request, request.params.tenant_id, READ);
      const rows = await withTenantScope(deps.pool, tenant, (c) => listVersions(c));
      reply.status(200);
      return { versions: rows.map(serialize) };
    },
  );

  // POST /policy/:tenant_id/compose
  // Accepts a draft PolicyDocument; returns the EIP-712 signing payload and
  // records the row in `draft` state.
  app.post(
    "/policy/:tenant_id/compose",
    async (
      request: FastifyRequest<{
        Params: { tenant_id: string };
        Body: { content?: PolicyDocument; quorum_required?: number };
      }>,
      reply,
    ) => {
      const tenant = assertTenantAccess(request, request.params.tenant_id, WRITE);
      const content = request.body?.content;
      if (
        content === undefined ||
        !Array.isArray(content.rules) ||
        typeof content.version !== "number"
      ) {
        throw brainError("policy_rule_invalid", "content must be { version, rules[] }");
      }
      const quorum = request.body?.quorum_required ?? 1;

      const id = newPolicyId();
      const hash = contentHash(content);

      const row = await withTenantScope(deps.pool, tenant, async (c) => {
        const inserted = await insertPolicy(c, {
          id,
          tenantId: tenant,
          version: content.version,
          content,
          contentHash: hash,
          quorumRequired: quorum,
          createdBy: request.principal!.id,
          state: "draft",
        });
        return transition(c, inserted.id, "draft", "pending_signatures");
      });

      const typed = buildTypedData({
        tenantId: tenant,
        version: content.version,
        policyHashHex: hash.toString("hex"),
        chainId: deps.chainId,
        verifyingContract: deps.policyRegistryAddress,
      });

      await deps.audit.emit({
        tenantId: tenant,
        layer: "policy",
        actor: request.principal!.id,
        action: "policy.compose",
        inputs: { version: content.version, policy_hash: hash.toString("hex") },
        outputs: { policy_id: row.id, state: row.state },
      });

      reply.status(200);
      return { policy_id: row.id, state: row.state, signing_payload: typed };
    },
  );

  // POST /policy/:tenant_id/sign
  app.post(
    "/policy/:tenant_id/sign",
    async (
      request: FastifyRequest<{
        Params: { tenant_id: string };
        Body: {
          policy_id?: string;
          signatures?: Array<{ address: `0x${string}`; signature: `0x${string}` }>;
        };
      }>,
      reply,
    ) => {
      const tenant = assertTenantAccess(request, request.params.tenant_id, SIGN);
      const body = request.body ?? {};
      if (body.policy_id === undefined || !Array.isArray(body.signatures)) {
        throw brainError("policy_signature_invalid", "policy_id and signatures[] required");
      }

      const { row, activated } = await withTenantScope(deps.pool, tenant, async (c) => {
        const existing = await c.query<PolicyRow>(`SELECT * FROM policies WHERE id = $1 LIMIT 1`, [
          body.policy_id,
        ]);
        const r = existing.rows[0];
        if (r === undefined) throw brainError("policy_not_found", "policy not found");
        if (r.state !== "pending_signatures") {
          throw brainError("policy_quorum_not_met", "policy is not awaiting signatures");
        }

        const typed = buildTypedData({
          tenantId: tenant,
          version: r.version,
          policyHashHex: Buffer.from(r.content_hash).toString("hex"),
          chainId: deps.chainId,
          verifyingContract: deps.policyRegistryAddress,
        });

        // A valid signature alone never counts toward quorum. Each signer must
        // also be DISTINCT and a pre-authorized tenant signer on the on-chain
        // BrainPolicyRegistry allowlist — mirroring registerPolicy's
        // DuplicateSigner / NotTenantSigner guards. Without this, quorum is
        // forgeable with N self-generated keypairs (or one key repeated N times).
        const seen = new Set<string>();
        for (const sig of body.signatures!) {
          // PolicyTypedData["types"] uses Array<{name;type}> which satisfies the
          // runtime contract but doesn't match viem's strict generic inference.
          type VerifyArgs = Parameters<typeof verifyTypedData>[0];
          const ok = await verifyTypedData({
            address: sig.address,
            domain: typed.domain as VerifyArgs["domain"],
            types: typed.types as unknown as VerifyArgs["types"],
            primaryType: typed.primaryType,
            message: typed.message as VerifyArgs["message"],
            signature: sig.signature,
          });
          if (!ok) {
            throw brainError("policy_signature_invalid", "signature did not verify", {
              details: { address: sig.address },
            });
          }

          const addr = sig.address.toLowerCase();
          if (seen.has(addr)) {
            throw brainError("policy_signature_invalid", "duplicate signer", {
              details: { address: sig.address },
            });
          }
          seen.add(addr);

          if (!(await deps.isAuthorizedSigner(tenant, sig.address))) {
            throw brainError(
              "policy_signature_invalid",
              "signer is not an authorized tenant signer",
              { details: { address: sig.address } },
            );
          }
        }

        await setSigners(c, r.id, body.signatures!);

        let activatedRow: PolicyRow = r;
        if (body.signatures!.length >= r.quorum_required) {
          activatedRow = await transition(c, r.id, "pending_signatures", "active");
        }
        return { row: activatedRow, activated: activatedRow.state === "active" };
      });

      await deps.audit.emit({
        tenantId: tenant,
        layer: "policy",
        actor: request.principal!.id,
        action: activated ? "policy.activate" : "policy.sign",
        inputs: { policy_id: row.id, signer_count: body.signatures!.length },
        outputs: { state: row.state },
      });

      reply.status(200);
      return { policy: serialize(row), activated };
    },
  );

  // POST /policy/:tenant_id/evaluate
  app.post(
    "/policy/:tenant_id/evaluate",
    async (
      request: FastifyRequest<{
        Params: { tenant_id: string };
        Body: { action?: Record<string, unknown> };
      }>,
      reply,
    ) => {
      const tenant = assertTenantAccess(request, request.params.tenant_id, READ);
      const action = parseAction(request.body?.action);
      const active = await withTenantScope(deps.pool, tenant, (c) => getActive(c));
      if (active === null) {
        throw brainError("policy_not_found", "no active policy");
      }
      const decision = evaluate(active.content, action);
      await deps.audit.emit({
        tenantId: tenant,
        layer: "policy",
        actor: request.principal!.id,
        action: "policy.evaluate",
        inputs: { action_kind: action.kind, policy_version: active.version },
        outputs: { decision: decision.outcome, matched_rule_id: decision.matched_rule_id },
      });
      reply.status(200);
      return decision;
    },
  );

  // POST /policy/:tenant_id/simulate
  app.post(
    "/policy/:tenant_id/simulate",
    async (
      request: FastifyRequest<{
        Params: { tenant_id: string };
        Body: { action?: Record<string, unknown>; version?: number };
      }>,
      reply,
    ) => {
      const tenant = assertTenantAccess(request, request.params.tenant_id, READ);
      if (typeof request.body?.version !== "number") {
        throw brainError("request_body_invalid", "version required");
      }
      const target = await withTenantScope(deps.pool, tenant, (c) =>
        getByVersion(c, request.body!.version!),
      );
      if (target === null) {
        throw brainError("policy_not_found", "no such policy version");
      }
      const action = parseAction(request.body.action);
      const decision = evaluate(target.content, action);
      reply.status(200);
      return { decision, policy_version: target.version };
    },
  );

  // POST /policy/:tenant_id/lint — static analysis of a candidate policy (H-18).
  app.post(
    "/policy/:tenant_id/lint",
    async (
      request: FastifyRequest<{
        Params: { tenant_id: string };
        Body: { policy_content?: unknown };
      }>,
      reply,
    ) => {
      const tenant = assertTenantAccess(request, request.params.tenant_id, READ);
      const content = parsePolicyContent(request.body?.policy_content);
      const findings = lintPolicy(content);
      reply.status(200);
      return {
        tenant_id: tenant,
        findings,
        errors: findings.filter((f) => f.severity === "ERROR").length,
        warnings: findings.filter((f) => f.severity === "WARN").length,
      };
    },
  );

  // POST /policy/:tenant_id/diff — semantic diff between two versions (H-18).
  app.post(
    "/policy/:tenant_id/diff",
    async (
      request: FastifyRequest<{
        Params: { tenant_id: string };
        Body: { from_version?: number; to_version?: number };
      }>,
      reply,
    ) => {
      const tenant = assertTenantAccess(request, request.params.tenant_id, READ);
      const { from_version, to_version } = request.body ?? {};
      if (typeof from_version !== "number" || typeof to_version !== "number") {
        throw brainError("request_body_invalid", "from_version and to_version required");
      }
      const result = await withTenantScope(deps.pool, tenant, async (c) => {
        const from = await getByVersion(c, from_version);
        const to = await getByVersion(c, to_version);
        if (from === null || to === null) return null;
        return diffPolicies(from.content, to.content);
      });
      if (result === null) {
        throw brainError("policy_not_found", "one or both versions not found");
      }
      reply.status(200);
      return { from_version, to_version, ...result };
    },
  );

  // POST /policy/:tenant_id/simulate-historical — replay the period's actions
  // against a candidate policy (H-18). DB fetch of historical actions; the
  // replay math itself is the pure simulateHistorical (unit-tested).
  app.post(
    "/policy/:tenant_id/simulate-historical",
    async (
      request: FastifyRequest<{
        Params: { tenant_id: string };
        Body: { policy_content?: unknown; period_start?: string; period_end?: string };
      }>,
      reply,
    ) => {
      const tenant = assertTenantAccess(request, request.params.tenant_id, READ);
      const candidate = parsePolicyContent(request.body?.policy_content);
      const start = new Date(request.body?.period_start ?? "");
      const end = new Date(request.body?.period_end ?? "");
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw brainError("request_body_invalid", "period_start and period_end must be ISO dates");
      }

      const { actions, active } = await withTenantScope(deps.pool, tenant, async (c) => {
        // Policy reads Ledger state (sanctioned §6 read; never Wiki). RLS scopes it.
        const { rows } = await c.query<{
          id: string;
          action_type: string;
          amount: string;
          currency: string;
          destination_counterparty_id: string;
          created_at: Date;
        }>(
          `SELECT id, action_type, amount, currency, destination_counterparty_id, created_at
             FROM ledger_payment_intents
            WHERE created_at >= $1 AND created_at <= $2
            ORDER BY created_at ASC`,
          [start, end],
        );
        const activeRow = await getActive(c);
        const replay: ReplayAction[] = rows.map((r) => ({
          id: r.id,
          action: {
            kind: railKindForActionType(r.action_type),
            counterparty_id: r.destination_counterparty_id,
            amount: { currency: r.currency, value: r.amount },
            agent_role: null,
            timestamp: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
          },
        }));
        return { actions: replay, active: activeRow?.content ?? null };
      });

      const result = simulateHistorical(candidate, active, actions);
      await deps.audit.emit({
        tenantId: tenant,
        layer: "policy",
        actor: request.principal!.id,
        action: "policy.simulate_historical",
        inputs: {
          period_start: start.toISOString(),
          period_end: end.toISOString(),
          replayed: actions.length,
        },
        outputs: { would_allow: result.would_allow, would_reject: result.would_reject },
      });
      reply.status(200);
      return result;
    },
  );
}

/** Map a PaymentIntent action_type to the policy DSL applies_to kind. */
function railKindForActionType(actionType: string): Action["kind"] {
  if (actionType === "onchain_transfer") return "onchain_tx";
  if (actionType === "ach_inbound") return "inbound_payment";
  if (actionType === "erp_writeback") return "ledger_write";
  return "outbound_payment"; // ach_outbound | wire | card_payment | other
}

/** Validate a candidate policy document from a request body. */
function parsePolicyContent(raw: unknown): PolicyDocument {
  if (
    raw === null ||
    typeof raw !== "object" ||
    !Array.isArray((raw as PolicyDocument).rules) ||
    typeof (raw as PolicyDocument).version !== "number"
  ) {
    throw brainError("policy_rule_invalid", "policy_content must be { version, rules[] }");
  }
  return raw as PolicyDocument;
}

function assertTenantAccess(request: FastifyRequest, pathTenant: string, scope: Scope): string {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  if (!isBrainId(pathTenant, "tnt")) {
    throw brainError("request_params_invalid", "malformed tenant_id");
  }
  if (request.principal.tenantId !== pathTenant) {
    throw brainError("auth_tenant_mismatch", "tenant mismatch");
  }
  requireScope(request.principal.scopes, scope);
  return pathTenant;
}

function parseAction(raw: unknown): Action {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    throw brainError("request_body_invalid", "action required");
  }
  const a = raw as Record<string, unknown>;
  const kind = a.kind;
  if (
    kind !== "outbound_payment" &&
    kind !== "inbound_payment" &&
    kind !== "ledger_write" &&
    kind !== "onchain_tx" &&
    kind !== "agent_action"
  ) {
    throw brainError("request_body_invalid", "action.kind invalid");
  }
  return {
    kind,
    counterparty_id: typeof a.counterparty_id === "string" ? a.counterparty_id : null,
    amount:
      typeof a.amount === "object" && a.amount !== null
        ? (a.amount as { currency: string; value: string })
        : null,
    agent_role: typeof a.agent_role === "string" ? a.agent_role : null,
    timestamp: typeof a.timestamp === "string" ? new Date(a.timestamp) : new Date(),
  };
}

function serialize(row: PolicyRow): Record<string, unknown> {
  return {
    id: row.id,
    version: row.version,
    state: row.state,
    content: row.content,
    content_hash: Buffer.from(row.content_hash).toString("hex"),
    signers: row.signers,
    quorum_required: row.quorum_required,
    activated_at: row.activated_at?.toISOString() ?? null,
    deactivated_at: row.deactivated_at?.toISOString() ?? null,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
  };
}
