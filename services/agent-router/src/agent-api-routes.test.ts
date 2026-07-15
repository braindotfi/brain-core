/**
 * agent-api route branch-coverage tests.
 *
 * Mirrors the agent-run-history.test.ts harness (minimal Fastify app +
 * injected principal + fake AgentApiDeps) but targets the branches that file
 * leaves uncovered: the GET /agents filter combinations, the various 404
 * throws (agent_not_found / agent_run_not_found / proof_not_found /
 * action_not_found / execution_agent_not_registered), the runHistory
 * present-vs-absent branches, releaseAgentQuarantine present/absent,
 * halt-category valid vs invalid, and toRoutingInput's "one of event or intent"
 * 400.
 */

import { describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { errorHandlerPlugin, type Principal, type Scope } from "@brain/shared";
import type { InternalAgentDefinition } from "@brain/schemas";
import { registerAgentApiRoutes, type AgentApiDeps } from "./agent-api.js";

const ALL_SCOPES: Scope[] = ["execution:read", "payment_intent:propose", "payment_intent:approve"];

function principal(scopes: Scope[] = ALL_SCOPES): Principal {
  return {
    id: "user_1",
    type: "user",
    tenantId: "tnt_acme",
    scopes,
    tokenId: "jti_1",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

const PAYMENT: InternalAgentDefinition = {
  agent_key: "payment",
  display_name: "Payment",
  provenance: "internal",
  category: "business",
  capabilities: ["pay_invoice"],
  triggers: ["invoice.approved"],
  intent_patterns: ["pay the invoice"],
  readable_data: ["ledger:read"],
  risk_level: "high",
  minimum_confidence: 0.85,
  required_evidence: ["invoice"],
  default_authority: "execute",
  enabled_by_default: true,
};

const SUBSCRIPTIONS: InternalAgentDefinition = {
  agent_key: "subscriptions",
  display_name: "Subscriptions",
  provenance: "external",
  category: "consumer",
  capabilities: ["cancel_subscription"],
  triggers: ["subscription.renewed"],
  intent_patterns: ["cancel the subscription"],
  readable_data: ["ledger:read"],
  risk_level: "low",
  minimum_confidence: 0.6,
  required_evidence: ["subscription"],
  default_authority: "propose",
  enabled_by_default: false,
};

const CATALOG: readonly InternalAgentDefinition[] = [PAYMENT, SUBSCRIPTIONS];

const RUN = {
  id: "agnr_1",
  tenant_id: "tnt_acme",
  agent_id: "payment",
  status: "executed",
  event_type: "invoice.approved",
  action: "pay_invoice",
  confidence: 0.9,
  evidence_score: 0.8,
  payment_intent_id: "pi_1",
  reason: { risk_level: "high", agent_key: "payment" },
  created_at: new Date("2026-01-01T00:00:00Z"),
  completed_at: new Date("2026-01-01T00:01:00Z"),
};

function makeDeps(over: Partial<AgentApiDeps> = {}): AgentApiDeps {
  const runHistory: NonNullable<AgentApiDeps["runHistory"]> = {
    evidenceCount: vi.fn(async () => 3),
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
      selected_agent_id: "payment",
      fallback_agent_ids: ["alt"],
      reason: { score: 0.9 },
    })),
  };
  return {
    catalog: () => CATALOG,
    router: {
      route: vi.fn(async () => ({ decision: "routed" })),
    } as unknown as AgentApiDeps["router"],
    runService: {
      run: vi.fn(async () => ({ run_id: "agnr_1", status: "executed" })),
    } as unknown as AgentApiDeps["runService"],
    reads: {
      listRuns: vi.fn(async () => [RUN]),
      findRun: vi.fn(async () => RUN),
      findRoutingDecision: vi.fn(async () => ({ id: "rd_1", selected_agent_id: "payment" })),
    },
    enqueueRouteJob: vi.fn(async () => ({ jobId: "job_1" })),
    haltAgent: vi.fn(async () => ({ paused: ["pi_1"], quarantined: true })),
    restoreAgent: vi.fn(async () => ({ restored: true as const })),
    isShadowed: (id: string) => id !== "payment",
    releaseAgentQuarantine: vi.fn(async () => true),
    runHistory,
    ...over,
  };
}

async function buildApp(
  deps: AgentApiDeps,
  scopes: Scope[] = ALL_SCOPES,
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  app.addHook("onRequest", async (req) => {
    req.principal = principal(scopes);
  });
  await registerAgentApiRoutes(app, deps);
  return app;
}

// ---------------------------------------------------------------------------
// GET /v1/agents — list + filters
// ---------------------------------------------------------------------------

describe("GET /v1/agents list filters", () => {
  it("returns the full catalog with shadow_mode annotated when no filter", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({ method: "GET", url: "/agents" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agents).toHaveLength(2);
    const payment = body.agents.find((a: { agent_key: string }) => a.agent_key === "payment");
    expect(payment.shadow_mode).toBe(false);
    const subs = body.agents.find((a: { agent_key: string }) => a.agent_key === "subscriptions");
    expect(subs.shadow_mode).toBe(true);
  });

  it("filters by kind (provenance)", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({ method: "GET", url: "/agents?kind=external" });
    const body = res.json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].agent_key).toBe("subscriptions");
  });

  it("filters by capability", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({ method: "GET", url: "/agents?capability=pay_invoice" });
    const body = res.json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].agent_key).toBe("payment");
  });

  it("filters by category", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({ method: "GET", url: "/agents?category=consumer" });
    const body = res.json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].agent_key).toBe("subscriptions");
  });

  it("filters by state=enabled", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({ method: "GET", url: "/agents?state=enabled" });
    const body = res.json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].agent_key).toBe("payment");
  });

  it("filters by state=disabled", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({ method: "GET", url: "/agents?state=disabled" });
    const body = res.json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].agent_key).toBe("subscriptions");
  });

  it("returns empty when capability matches nothing", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({ method: "GET", url: "/agents?capability=nope" });
    expect(res.json().agents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/agents/{agent_id}
// ---------------------------------------------------------------------------

describe("GET /v1/agents/{agent_id}", () => {
  it("returns the definition + null registration", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({ method: "GET", url: "/agents/payment" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.definition.agent_key).toBe("payment");
    expect(body.definition.shadow_mode).toBe(false);
    expect(body.registration).toBeNull();
  });

  it("404s with agent_not_found when the agent is unknown", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({ method: "GET", url: "/agents/ghost" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("agent_not_found");
  });
});

// ---------------------------------------------------------------------------
// POST /v1/agents/route + /run + /events (toRoutingInput branches)
// ---------------------------------------------------------------------------

describe("POST /v1/agents/route", () => {
  it("routes when an event is present", async () => {
    const deps = makeDeps();
    const app = await buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/agents/route",
      payload: { event: "invoice.approved" },
    });
    expect(res.statusCode).toBe(200);
    expect(deps.router.route).toHaveBeenCalled();
  });

  it("routes when only an intent is present", async () => {
    const deps = makeDeps();
    const app = await buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/agents/route",
      payload: { intent: "pay the invoice", context: { invoice_id: "inv_1" } },
    });
    expect(res.statusCode).toBe(200);
  });

  it("400s when neither event nor intent is supplied", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({ method: "POST", url: "/agents/route", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request_body_invalid");
  });

  it("400s when the body is omitted entirely", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({ method: "POST", url: "/agents/route" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request_body_invalid");
  });
});

describe("POST /v1/agents/run", () => {
  it("runs when an event is present", async () => {
    const deps = makeDeps();
    const app = await buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/agents/run",
      payload: { event: "invoice.approved" },
    });
    expect(res.statusCode).toBe(200);
    expect(deps.runService.run).toHaveBeenCalled();
  });

  it("400s when neither event nor intent is supplied", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({ method: "POST", url: "/agents/run", payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /v1/agents/events", () => {
  it("enqueues and returns 202 with a job id (event)", async () => {
    const deps = makeDeps();
    const app = await buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/agents/events",
      payload: { event: "invoice.approved", context: { x: 1 } },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ job_id: "job_1", status: "queued" });
    expect(deps.enqueueRouteJob).toHaveBeenCalled();
  });

  it("enqueues with only an intent", async () => {
    const deps = makeDeps();
    const app = await buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/agents/events",
      payload: { intent: "pay the invoice" },
    });
    expect(res.statusCode).toBe(202);
  });

  it("400s when neither event nor intent is supplied", async () => {
    const deps = makeDeps();
    const app = await buildApp(deps);
    const res = await app.inject({ method: "POST", url: "/agents/events", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request_body_invalid");
    expect(deps.enqueueRouteJob).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/agents/{agent_id}/halt
// ---------------------------------------------------------------------------

describe("POST /v1/agents/{agent_id}/halt", () => {
  it("halts the agent and echoes the agent id", async () => {
    const deps = makeDeps();
    const app = await buildApp(deps);
    const res = await app.inject({ method: "POST", url: "/agents/payment/halt" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agent_id).toBe("payment");
    expect(body.paused).toEqual(["pi_1"]);
    expect(body.quarantined).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/agents/{agent_id}/restore
// ---------------------------------------------------------------------------

describe("POST /v1/agents/{agent_id}/restore", () => {
  it("restores the agent and echoes the agent id", async () => {
    const deps = makeDeps();
    const app = await buildApp(deps);
    const res = await app.inject({ method: "POST", url: "/agents/payment/restore" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ agent_id: "payment", restored: true });
    expect(deps.restoreAgent).toHaveBeenCalledWith(expect.anything(), "payment");
  });

  it("requires the operator halt scope", async () => {
    const deps = makeDeps();
    const app = await buildApp(deps, ["execution:read"]);
    const res = await app.inject({ method: "POST", url: "/agents/payment/restore" });
    expect(res.statusCode).toBe(403);
    expect(deps.restoreAgent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/agents/{agent_id}/quarantine/release (releaseAgentQuarantine branch)
// ---------------------------------------------------------------------------

describe("POST /v1/agents/{agent_id}/quarantine/release", () => {
  it("releases when the loader returns true", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({
      method: "POST",
      url: "/agents/payment/quarantine/release",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ agent_id: "payment", quarantine_released: true });
  });

  it("404s when the loader returns false (agent not visible)", async () => {
    const app = await buildApp(makeDeps({ releaseAgentQuarantine: vi.fn(async () => false) }));
    const res = await app.inject({
      method: "POST",
      url: "/agents/payment/quarantine/release",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("execution_agent_not_registered");
  });

  it("404s when the loader is not wired at all", async () => {
    const { releaseAgentQuarantine: _omit, ...rest } = makeDeps();
    void _omit;
    const app = await buildApp(rest);
    const res = await app.inject({
      method: "POST",
      url: "/agents/payment/quarantine/release",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("execution_agent_not_registered");
  });
});

// ---------------------------------------------------------------------------
// POST /v1/agents/halt-category
// ---------------------------------------------------------------------------

describe("POST /v1/agents/halt-category", () => {
  it("halts every agent in a valid category", async () => {
    const deps = makeDeps();
    const app = await buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/agents/halt-category",
      payload: { category: "business" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.category).toBe("business");
    expect(body.halted).toHaveLength(1);
    expect(body.halted[0].agent_id).toBe("payment");
    expect(deps.haltAgent).toHaveBeenCalledTimes(1);
  });

  it("halts consumer agents", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({
      method: "POST",
      url: "/agents/halt-category",
      payload: { category: "consumer" },
    });
    expect(res.json().halted[0].agent_id).toBe("subscriptions");
  });

  it("accepts the agnostic category (empty halted set)", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({
      method: "POST",
      url: "/agents/halt-category",
      payload: { category: "agnostic" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().halted).toHaveLength(0);
  });

  it("400s on an invalid category", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({
      method: "POST",
      url: "/agents/halt-category",
      payload: { category: "nonsense" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request_body_invalid");
  });

  it("400s when the category is omitted", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({
      method: "POST",
      url: "/agents/halt-category",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/agents/runs — list filters
// ---------------------------------------------------------------------------

describe("GET /v1/agents/runs", () => {
  it("lists with no filter", async () => {
    const deps = makeDeps();
    const app = await buildApp(deps);
    const res = await app.inject({ method: "GET", url: "/agents/runs" });
    expect(res.statusCode).toBe(200);
    expect(res.json().runs).toHaveLength(1);
    expect(deps.reads.listRuns).toHaveBeenCalledWith(expect.anything(), {});
  });

  it("forwards all filters (agent_id, status, category, limit)", async () => {
    const deps = makeDeps();
    const app = await buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/agents/runs?agent_id=payment&status=executed&category=business&limit=5",
    });
    expect(res.statusCode).toBe(200);
    expect(deps.reads.listRuns).toHaveBeenCalledWith(expect.anything(), {
      agentId: "payment",
      status: "executed",
      category: "business",
      limit: 5,
    });
  });
});

// ---------------------------------------------------------------------------
// Run sub-resources: runHistory ABSENT branches (the present branches are
// covered by agent-run-history.test.ts).
// ---------------------------------------------------------------------------

describe("run sub-resources with runHistory absent", () => {
  function depsNoHistory(): AgentApiDeps {
    const { runHistory: _omit, ...rest } = makeDeps();
    void _omit;
    return rest;
  }

  it("GET /runs/{id} returns evidence_count 0 when runHistory is absent", async () => {
    const app = await buildApp(depsNoHistory());
    const res = await app.inject({ method: "GET", url: "/agents/runs/agnr_1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().evidence_count).toBe(0);
  });

  it("GET /runs/{id} 404s when the run is absent (findRun null)", async () => {
    const deps = makeDeps({
      reads: {
        listRuns: vi.fn(async () => []),
        findRun: vi.fn(async () => null),
        findRoutingDecision: vi.fn(async () => null),
      },
    });
    const app = await buildApp(deps);
    const res = await app.inject({ method: "GET", url: "/agents/runs/missing" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("agent_run_not_found");
  });

  it("GET /runs/{id}/why returns null routing + behavior hash when runHistory absent", async () => {
    const app = await buildApp(depsNoHistory());
    const res = await app.inject({ method: "GET", url: "/agents/runs/agnr_1/why" });
    expect(res.statusCode).toBe(200);
    expect(res.json().behavior_hash).toBeNull();
  });

  it("GET /runs/{id}/why 404s when the run is absent", async () => {
    const deps = makeDeps({
      reads: {
        listRuns: vi.fn(async () => []),
        findRun: vi.fn(async () => null),
        findRoutingDecision: vi.fn(async () => null),
      },
    });
    const app = await buildApp(deps);
    const res = await app.inject({ method: "GET", url: "/agents/runs/missing/why" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /runs/{id}/evidence 404s when runHistory is absent", async () => {
    const app = await buildApp(depsNoHistory());
    const res = await app.inject({ method: "GET", url: "/agents/runs/agnr_1/evidence" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("agent_run_not_found");
  });

  it("GET /runs/{id}/gate-trace 404s when runHistory is absent", async () => {
    const app = await buildApp(depsNoHistory());
    const res = await app.inject({ method: "GET", url: "/agents/runs/agnr_1/gate-trace" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("agent_run_not_found");
  });

  it("GET /runs/{id}/gate-trace 404s when the loader returns null", async () => {
    const deps = makeDeps();
    deps.runHistory!.gateTrace = vi.fn(async () => null);
    const app = await buildApp(deps);
    const res = await app.inject({ method: "GET", url: "/agents/runs/agnr_1/gate-trace" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /runs/{id}/proof 404s when runHistory is absent", async () => {
    const app = await buildApp(depsNoHistory());
    const res = await app.inject({ method: "GET", url: "/agents/runs/agnr_1/proof" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("proof_not_found");
  });
});

// ---------------------------------------------------------------------------
// GET /v1/agents/routing-decisions/{id}
// ---------------------------------------------------------------------------

describe("GET /v1/agents/routing-decisions/{id}", () => {
  it("returns the decision when found", async () => {
    const app = await buildApp(makeDeps());
    const res = await app.inject({ method: "GET", url: "/agents/routing-decisions/rd_1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("rd_1");
  });

  it("404s with action_not_found when the decision is absent", async () => {
    const deps = makeDeps({
      reads: {
        listRuns: vi.fn(async () => []),
        findRun: vi.fn(async () => RUN),
        findRoutingDecision: vi.fn(async () => null),
      },
    });
    const app = await buildApp(deps);
    const res = await app.inject({ method: "GET", url: "/agents/routing-decisions/missing" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("action_not_found");
  });
});

// ---------------------------------------------------------------------------
// assertCtx: missing principal -> auth_token_missing
// ---------------------------------------------------------------------------

describe("assertCtx guard", () => {
  it("rejects when no principal is attached to the request", async () => {
    const app = Fastify();
    await app.register(errorHandlerPlugin);
    // No onRequest hook attaching a principal.
    await registerAgentApiRoutes(app, makeDeps());
    const res = await app.inject({ method: "GET", url: "/agents" });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error.code).toBe("auth_token_missing");
  });
});
