/**
 * H-25 Agent Run History loaders (composition root).
 *
 * Implements the cross-cutting reads the /v1/agents/runs/{run_id}/* sub-resources
 * need but that @brain/agent-router must not reach for directly: the evidence
 * chain (agent_evidence_refs), the §6 gate trace (the run's PaymentIntent →
 * execute.before audit event, the same source H-07 uses), the H-07 Proof
 * (proxied via the injected proof builder), and the routing decision + behavior
 * hash for /why. All reads are RLS-scoped via withTenantScope.
 *
 * SANDBOX NOTE: the SQL shape + mapping is unit-tested with a fake client; the
 * live joins/RLS need Postgres (blocked here — see the H-25 summary).
 */

import {
  withTenantScope,
  type AgentRunEvidenceItem,
  type AgentRunGateTrace,
  type Proof,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";

type Client = Pick<TenantScopedClient, "query">;

function hex(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v.toString("hex");
  return String(v);
}

/** Look up a run's id/agent/pi/routing-decision; null if not visible. */
async function findRunRefs(
  c: Client,
  runId: string,
): Promise<{
  payment_intent_id: string | null;
  agent_id: string | null;
  routing_decision_id: string | null;
} | null> {
  const { rows } = await c.query<{
    payment_intent_id: string | null;
    agent_id: string | null;
    routing_decision_id: string | null;
  }>(
    `SELECT payment_intent_id, agent_id, routing_decision_id
       FROM agent_runs WHERE id = $1 LIMIT 1`,
    [runId],
  );
  return rows[0] ?? null;
}

export interface RunHistoryLoaders {
  evidenceCount(ctx: ServiceCallContext, runId: string): Promise<number>;
  evidence(ctx: ServiceCallContext, runId: string): Promise<AgentRunEvidenceItem[] | null>;
  gateTrace(ctx: ServiceCallContext, runId: string): Promise<AgentRunGateTrace | null>;
  proof(ctx: ServiceCallContext, runId: string): Promise<unknown | null>;
  behaviorHash(ctx: ServiceCallContext, runId: string): Promise<string | null>;
  routingDecisionForRun(ctx: ServiceCallContext, runId: string): Promise<unknown | null>;
}

export function makeRunLoaders(
  pool: Pool,
  buildProof: (tenantId: string, actionId: string) => Promise<Proof | null>,
): RunHistoryLoaders {
  return {
    async evidenceCount(ctx, runId) {
      return withTenantScope(pool, ctx.tenantId, async (c) => {
        const { rows } = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM agent_evidence_refs WHERE run_id = $1`,
          [runId],
        );
        return Number(rows[0]?.n ?? "0");
      });
    },

    async evidence(ctx, runId) {
      return withTenantScope(pool, ctx.tenantId, async (c) => {
        const refs = await findRunRefs(c, runId);
        if (refs === null) return null; // run not visible → 404 upstream
        const { rows } = await c.query<{
          id: string;
          kind: string;
          ref: string;
          source_system: string | null;
          object_type: string | null;
          object_id: string | null;
          confidence: number | null;
          hash: Buffer | string | null;
          stale: boolean;
          required: boolean | null;
        }>(
          `SELECT id, kind, ref, source_system, object_type, object_id, confidence, hash, stale, required
             FROM agent_evidence_refs WHERE run_id = $1 ORDER BY created_at ASC`,
          [runId],
        );
        return rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          ref: r.ref,
          source_system: r.source_system,
          object_type: r.object_type,
          object_id: r.object_id,
          confidence: r.confidence,
          hash: hex(r.hash),
          stale: r.stale,
          required: r.required,
        }));
      });
    },

    async gateTrace(ctx, runId) {
      return withTenantScope(pool, ctx.tenantId, async (c) => {
        const refs = await findRunRefs(c, runId);
        if (refs === null) return null;
        if (refs.payment_intent_id === null) {
          return { run_id: runId, payment_intent_id: null, gate_checks: [] };
        }
        const { rows } = await c.query<{ outputs: Record<string, unknown> | null }>(
          `SELECT outputs FROM audit_events
            WHERE action = 'payment_intent.execute.before'
              AND inputs->>'payment_intent_id' = $1
            ORDER BY created_at DESC LIMIT 1`,
          [refs.payment_intent_id],
        );
        const checks = (rows[0]?.outputs?.gate_checks ?? []) as AgentRunGateTrace["gate_checks"];
        return { run_id: runId, payment_intent_id: refs.payment_intent_id, gate_checks: checks };
      });
    },

    async proof(ctx, runId) {
      const pi = await withTenantScope(pool, ctx.tenantId, async (c) => {
        const refs = await findRunRefs(c, runId);
        return refs?.payment_intent_id ?? null;
      });
      if (pi === null) return null;
      return buildProof(ctx.tenantId, pi);
    },

    async behaviorHash(ctx, runId) {
      return withTenantScope(pool, ctx.tenantId, async (c) => {
        const refs = await findRunRefs(c, runId);
        if (refs === null || refs.agent_id === null) return null;
        const { rows } = await c.query<{ scope_hash: Buffer | string | null }>(
          `SELECT scope_hash FROM agents WHERE id = $1 LIMIT 1`,
          [refs.agent_id],
        );
        return hex(rows[0]?.scope_hash ?? null);
      });
    },

    async routingDecisionForRun(ctx, runId) {
      return withTenantScope(pool, ctx.tenantId, async (c) => {
        const refs = await findRunRefs(c, runId);
        if (refs === null || refs.routing_decision_id === null) return null;
        const { rows } = await c.query<Record<string, unknown>>(
          `SELECT * FROM agent_routing_decisions WHERE id = $1 LIMIT 1`,
          [refs.routing_decision_id],
        );
        return rows[0] ?? null;
      });
    },
  };
}
