/**
 * H-25 Agent Run History route tests. Builds a minimal Fastify app with an
 * injected principal + fake AgentApiDeps (incl. the runHistory loaders), and
 * exercises the run summary, /why, /evidence, /gate-trace, /proof sub-resources
 * — happy paths, tenant-isolation 404s, shadow + failed runs.
 */

import { describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { errorHandlerPlugin, type Principal, type Scope } from "@brain/shared";
import { registerAgentApiRoutes, type AgentApiDeps } from "./agent-api.js";

function principal(scopes: Scope[]): Principal {
  return {
    id: "user_1",
    type: "user",
    tenantId: "tnt_acme",
    scopes,
    tokenId: "jti_1",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

const RUN = {
  id: "agnr_1",
  tenant_id: "tnt_acme",
  agent_id: "agent_pay",
  status: "executed",
  event_type: "invoice.received",
  action: "pay_invoice",
  confidence: 0.9,
  evidence_score: 0.8,
  payment_intent_id: "pi_1",
  reason: { risk_level: "medium", agent_key: "payment" },
  created_at: new Date("2026-01-01T00:00:00Z"),
  completed_at: new Date("2026-01-01T00:01:00Z"),
};

function makeDeps(over: Partial<AgentApiDeps> = {}): AgentApiDeps {
  const noopRunHistory: NonNullable<AgentApiDeps["runHistory"]> = {
    evidenceCount: vi.fn(async () => 2),
    evidence: vi.fn(async () => [
      {
        id: "agev_1",
        kind: "invoice",
        ref: "inv_1",
        source_system: "ledger",
        object_type: "invoice",
        object_id: "inv_1",
        confidence: 0.9,
        hash: "ab",
        stale: false,
        required: true,
      },
    ]),
    gateTrace: vi.fn(async () => ({
      run_id: "agnr_1",
      payment_intent_id: "pi_1",
      gate_checks: [{ index: 1, name: "agent_identity_verified", passed: true }],
    })),
    proof: vi.fn(async () => ({ action_id: "pi_1", outcome: "executed" })),
    behaviorHash: vi.fn(async () => "0xbehavior"),
    routingDecisionForRun: vi.fn(async () => ({
      selected_agent_id: "agent_pay",
      fallback_agent_ids: ["agent_alt"],
      reason: { score: 0.9 },
    })),
  };
  return {
    catalog: () => [],
    router: {} as AgentApiDeps["router"],
    runService: {} as AgentApiDeps["runService"],
    reads: {
      listRuns: vi.fn(async () => []),
      findRun: vi.fn(async () => RUN),
      findRoutingDecision: vi.fn(async () => null),
    },
    enqueueRouteJob: vi.fn(async () => ({ jobId: "job_1" })),
    haltAgent: vi.fn(async () => ({ paused: [], quarantined: false })),
    restoreAgent: vi.fn(async () => ({ restored: true as const })),
    isShadowed: () => false,
    runHistory: noopRunHistory,
    ...over,
  };
}

async function buildApp(deps: AgentApiDeps): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  app.addHook("onRequest", async (req) => {
    req.principal = principal(["execution:read"]);
  });
  await registerAgentApiRoutes(app, deps);
  return app;
}

describe("H-25 GET /v1/agents/runs/{run_id}", () => {
  it("returns the AgentRunSummary", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({ method: "GET", url: "/agents/runs/agnr_1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.run_id).toBe("agnr_1");
    expect(body.status).toBe("completed");
    expect(body.evidence_count).toBe(2);
    expect(body.outcome.payment_intent_id).toBe("pi_1");
  });

  it("404s when the run is not visible to the tenant", async () => {
    const app = await buildApp(
      makeDeps({
        reads: {
          listRuns: vi.fn(async () => []),
          findRun: vi.fn(async () => null),
          findRoutingDecision: vi.fn(async () => null),
        },
      }),
    );
    const res = await app.inject({ method: "GET", url: "/agents/runs/agnr_other" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("agent_run_not_found");
  });

  it("reports a shadow run as shadow_completed", async () => {
    const app = await buildApp(
      makeDeps({
        reads: {
          listRuns: vi.fn(async () => []),
          findRun: vi.fn(async () => ({ ...RUN, status: "shadow_completed" })),
          findRoutingDecision: vi.fn(async () => null),
        },
      }),
    );
    const res = await app.inject({ method: "GET", url: "/agents/runs/agnr_1" });
    expect(res.json().status).toBe("shadow_completed");
  });
});

describe("H-25 run sub-resources", () => {
  it("/why returns candidates + behavior hash", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({ method: "GET", url: "/agents/runs/agnr_1/why" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.candidate_agent_ids).toEqual(["agent_pay", "agent_alt"]);
    expect(body.behavior_hash).toBe("0xbehavior");
  });

  it("/evidence returns the evidence chain", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({ method: "GET", url: "/agents/runs/agnr_1/evidence" });
    expect(res.statusCode).toBe(200);
    expect(res.json().evidence[0].kind).toBe("invoice");
  });

  it("/evidence 404s when the run is absent", async () => {
    const deps = makeDeps();
    deps.runHistory!.evidence = vi.fn(async () => null);
    const app = await buildApp(deps);
    const res = await app.inject({ method: "GET", url: "/agents/runs/missing/evidence" });
    expect(res.statusCode).toBe(404);
  });

  it("/gate-trace shows the §6 checks", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({ method: "GET", url: "/agents/runs/agnr_1/gate-trace" });
    expect(res.statusCode).toBe(200);
    expect(res.json().gate_checks[0].name).toBe("agent_identity_verified");
  });

  it("/gate-trace surfaces a failing check for a failed run", async () => {
    const deps = makeDeps();
    deps.runHistory!.gateTrace = vi.fn(async () => ({
      run_id: "agnr_1",
      payment_intent_id: "pi_1",
      gate_checks: [{ index: 8, name: "available_balance_sufficient", passed: false }],
    }));
    const app = await buildApp(deps);
    const res = await app.inject({ method: "GET", url: "/agents/runs/agnr_1/gate-trace" });
    expect(res.json().gate_checks[0].passed).toBe(false);
  });

  it("/proof proxies H-07", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({ method: "GET", url: "/agents/runs/agnr_1/proof" });
    expect(res.statusCode).toBe(200);
    expect(res.json().action_id).toBe("pi_1");
  });

  it("/proof 404s when the run produced no on-ledger action", async () => {
    const deps = makeDeps();
    deps.runHistory!.proof = vi.fn(async () => null);
    const app = await buildApp(deps);
    const res = await app.inject({ method: "GET", url: "/agents/runs/agnr_1/proof" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("proof_not_found");
  });
});
