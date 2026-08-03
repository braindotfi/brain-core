/**
 * POST /v1/demo/policy/activate: investor / demo-operator policy activation
 * shortcut. Inserts a policy document as the tenant's active signed-path
 * policy, bypassing the EIP-712 signing ceremony (POST
 * /policy/:tenant_id/compose + /sign) so a demo operator can activate one
 * with a single curl. Only registered when BRAIN_DEMO_MODE is on (main.ts
 * gates registration; this file has no opinion on that).
 *
 * Runs the SAME two gates POST /policy/:tenant_id/sign runs before writing
 * state='active': validatePolicyDocument (structural shape, services/policy/
 * src/validate.ts) and runActivationLintGate (the H-18 lint gate,
 * services/policy/src/linter.ts). Before this file existed the route only
 * checked `typeof content.version === "number" && Array.isArray(content.rules)`,
 * so a caller holding policy:write could activate an unbounded
 * auto-executing `{"applies_to":["any"],"when":{},"execute":"auto"}` rule
 * directly on this route, skipping the hardening PR #377 added to
 * compose/sign. See the "Policy activation blocks on every linter ERROR
 * finding" entry in CLAUDE.md.
 */

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AuditEmitter, Logger } from "@brain/shared";
import { brainError, newPolicyId, withTenantScope } from "@brain/shared";
import {
  contentHash,
  runActivationLintGate,
  validatePolicyDocument,
  type PolicyDocument,
} from "@brain/policy";
import type { PolicyRegistrar } from "../policyRegistrar.js";

/**
 * Demo policy used when the request body carries no `content`. Every auto
 * money-mover rule here must independently be lint-clean under
 * runActivationLintGate (auto_no_amount_cap, auto_no_counterparty_constraint,
 * auto_no_verified_counterparty, no_approval_path_high_value,
 * auto_no_risk_bound, broad_any_auto) or activation below throws. This route
 * has no seeded counterparty data to scope an `outbound_payment` /
 * `onchain_tx` auto rule's counterparty.in allowlist to, so those rules
 * require confirmation instead of auto-executing -- the same tradeoff
 * onboarding/provision.ts's buildDefaultPolicyDocument makes for the same
 * reason. `agent_action` is not a money-mover applies_to value, so it stays
 * auto without tripping the gate.
 */
export const DEMO_POLICY: PolicyDocument = {
  version: 1,
  rules: [
    {
      id: "confirm-small-payment",
      applies_to: ["outbound_payment"],
      when: { "amount.lte": { currency: "USD", value: "1000.00" } },
      ach_autonomous_max_amount: { currency: "USD", value: "1000.00" },
      require: "owner_approval",
      execute: "confirm",
    },
    {
      id: "reject-excessive-payment",
      applies_to: ["outbound_payment"],
      when: { "amount.gt": { currency: "USD", value: "10000.00" } },
      execute: "reject",
    },
    {
      id: "confirm-mid-payment",
      applies_to: ["outbound_payment"],
      when: {
        "amount.gt": { currency: "USD", value: "1000.00" },
        "amount.lte": { currency: "USD", value: "10000.00" },
      },
      require: "owner_approval",
      execute: "confirm",
    },
    { id: "auto-agent-action", applies_to: ["agent_action"], when: {}, execute: "auto" },
    {
      id: "confirm-onchain-tx",
      applies_to: ["onchain_tx"],
      when: {},
      require: "owner_approval",
      execute: "confirm",
    },
  ],
};

export interface DemoPolicyActivateRouteDeps {
  pool: Pool;
  audit: AuditEmitter;
  log: Logger;
  policyRegistrar: PolicyRegistrar | undefined;
  /** Sourced from cfg.BRAIN_POLICY_LINT_REJECT (default true). */
  lintReject: boolean | undefined;
  /** Sourced from cfg.BRAIN_POLICY_CONFIDENCE_FLOOR_REJECT (default false). */
  confidenceFloorReject: boolean | undefined;
}

async function findTenantKind(pool: Pool, tenantId: string): Promise<"production" | "demo" | null> {
  return withTenantScope(pool, tenantId, async (c) => {
    const { rows } = await c.query<{ kind: "production" | "demo" }>(
      `SELECT kind FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId],
    );
    return rows[0]?.kind ?? null;
  });
}

export async function registerDemoPolicyActivateRoute(
  app: FastifyInstance,
  deps: DemoPolicyActivateRouteDeps,
): Promise<void> {
  app.post("/demo/policy/activate", { config: { skipAuth: false } }, async (req, reply) => {
    if (req.principal === undefined) {
      throw brainError("auth_token_missing", "principal required");
    }
    if (!req.principal.scopes.includes("policy:write")) {
      throw brainError("auth_scope_insufficient", "policy:write required");
    }
    const tenantId = req.principal.tenantId;
    const actorId = req.principal.id;

    const body = req.body as { content?: PolicyDocument } | undefined;
    // validatePolicyDocument throws policy_rule_invalid (400) on the first
    // structural problem, same as POST /policy/:tenant_id/compose -- see the
    // comment there. Replaces the previous shallow
    // `typeof version === "number" && Array.isArray(rules)` check, which let
    // a malformed rule shape through to throw deep inside vm.ts on first
    // evaluation instead of failing here with a normal 400.
    const content = validatePolicyDocument(body?.content ?? DEMO_POLICY);
    const hash = contentHash(content);

    // -- H-18 lint gate: identical enforcement to POST /policy/:tenant_id/sign --
    // This was the one activation path PR #377's hardening missed: without
    // this block, a caller holding policy:write could activate an unbounded
    // auto-executing "any" money-movement rule that /compose and /sign
    // already reject.
    const tenantKind = await findTenantKind(deps.pool, tenantId);
    const lintEnforce = deps.lintReject === true || tenantKind === "production";
    const confidenceEnforce = deps.confidenceFloorReject === true || tenantKind === "production";
    const gate = runActivationLintGate(content, { lintEnforce, confidenceEnforce });
    if (gate.blocking.length > 0) {
      throw brainError("policy_rule_invalid", "policy failed activation lint", {
        statusOverride: 422,
        details: { findings: gate.blocking },
      });
    }

    // -- Idempotency: same content hash already active and on-chain --
    type ExistingRow = {
      id: string;
      version: number;
      onchain_tx: string;
      onchain_version: number;
    };
    const existingReg = await withTenantScope(deps.pool, tenantId, async (c) => {
      const res = await c.query<ExistingRow>(
        `SELECT id, version, onchain_tx, onchain_version FROM policies
       WHERE state = 'active' AND content_hash = $1 AND onchain_tx IS NOT NULL
       LIMIT 1`,
        [hash],
      );
      return res.rows[0] ?? null;
    });

    if (existingReg !== null) {
      reply.status(200);
      return {
        policy_id: existingReg.id,
        state: "active",
        version: content.version,
        rules: content.rules,
        onchain_policy_tx: existingReg.onchain_tx,
        onchain_policy_version: existingReg.onchain_version,
        chain: "base-sepolia",
      };
    }

    const id = newPolicyId();

    await withTenantScope(deps.pool, tenantId, async (c) => {
      await c.query(
        `UPDATE policies SET state = 'deactivated', deactivated_at = now() WHERE state = 'active'`,
      );
      const versionRes = await c.query<{ next_version: number }>(
        `SELECT COALESCE(MAX(version) + 1, 1) AS next_version FROM policies WHERE tenant_id = $1`,
        [tenantId],
      );
      const nextVersion = versionRes.rows[0]?.next_version ?? 1;
      await c.query(
        `INSERT INTO policies
         (id, tenant_id, version, content, content_hash, quorum_required,
          state, created_by, activated_at)
       VALUES ($1,$2,$3,$4,$5,1,'active',$6,now())`,
        [id, tenantId, nextVersion, JSON.stringify(content), hash, actorId],
      );
    });

    // -- On-chain policy registration (best-effort) --
    let onchainPolicyTx: string | undefined;
    let onchainPolicyVersion: number | undefined;
    if (deps.policyRegistrar !== undefined) {
      try {
        const reg = await deps.policyRegistrar.registerPolicy(tenantId, hash);
        onchainPolicyTx = reg.tx_hash;
        onchainPolicyVersion = reg.version;
        await withTenantScope(deps.pool, tenantId, async (c) => {
          await c.query(`UPDATE policies SET onchain_tx = $1, onchain_version = $2 WHERE id = $3`, [
            onchainPolicyTx,
            onchainPolicyVersion ?? null,
            id,
          ]);
        });
      } catch (err) {
        deps.log.warn({ err }, "on-chain policy registration failed, demo continues off-chain");
      }
    }

    await deps.audit.emit({
      tenantId,
      layer: "policy",
      actor: actorId,
      action: "policy.activate",
      inputs: {
        version: content.version,
        policy_hash: hash.toString("hex"),
        demo_bypass: true,
        onchain_tx: onchainPolicyTx ?? null,
      },
      outputs: { policy_id: id, state: "active" },
    });

    reply.status(200);
    return {
      policy_id: id,
      state: "active",
      version: content.version,
      rules: content.rules,
      ...(onchainPolicyTx !== undefined && {
        onchain_policy_tx: onchainPolicyTx,
        onchain_policy_version: onchainPolicyVersion,
        chain: "base-sepolia",
      }),
    };
  });
}
