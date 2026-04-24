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
} from "@brain/api/shared";
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
      if (content === undefined || !Array.isArray(content.rules) || typeof content.version !== "number") {
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
        const existing = await c.query<PolicyRow>(
          `SELECT * FROM policies WHERE id = $1 LIMIT 1`,
          [body.policy_id],
        );
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

        for (const sig of body.signatures!) {
          const ok = await verifyTypedData({
            address: sig.address,
            domain: typed.domain,
            types: typed.types,
            primaryType: typed.primaryType,
            message: typed.message,
            signature: sig.signature,
          });
          if (!ok) {
            throw brainError("policy_signature_invalid", "signature did not verify", {
              details: { address: sig.address },
            });
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
    kind !== "onchain_tx"
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
