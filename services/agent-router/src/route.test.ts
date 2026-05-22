import { describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  errorHandlerPlugin,
  InMemoryAuditEmitter,
  type Principal,
  type Scope,
} from "@brain/shared";
import type { InternalAgentDefinition } from "@brain/schemas";
import { AgentRouter } from "./router.js";
import { registerAgentRouterRoutes } from "./route.js";
import { RulesIntentClassifier } from "./intent-classifier.js";
import { StaticEvidenceGatherer } from "./evidence-gatherer.js";

const COLLECTIONS: InternalAgentDefinition = {
  agent_key: "collections",
  provenance: "internal",
  category: "business",
  capabilities: ["collections_followup"],
  triggers: ["invoice.overdue"],
  intent_patterns: ["follow up overdue invoice"],
  readable_data: ["ledger:invoices"],
  risk_level: "medium",
  minimum_confidence: 0.75,
  required_evidence: [],
  default_authority: "propose",
  enabled_by_default: true,
};

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

async function buildApp(p: Principal | undefined): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  app.addHook("onRequest", async (req) => {
    if (p !== undefined) {
      req.principal = p;
    }
  });
  const router = new AgentRouter({
    catalog: () => [COLLECTIONS],
    classifier: new RulesIntentClassifier(),
    evidence: new StaticEvidenceGatherer([]),
    getScopedCapabilities: () => new Set(["collections_followup"]),
    audit: new InMemoryAuditEmitter(),
  });
  await registerAgentRouterRoutes(app, { router });
  return app;
}

describe("POST /agents/route", () => {
  it("returns the selected agent for a valid request", async () => {
    const app = await buildApp(principal(["execution:read"]));
    const res = await app.inject({
      method: "POST",
      url: "/agents/route",
      payload: { tenant_id: "tnt_acme", event: "invoice.overdue" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().selected_agent_id).toBe("collections");
  });

  it("rejects a missing tenant_id with 400", async () => {
    const app = await buildApp(principal(["execution:read"]));
    const res = await app.inject({
      method: "POST",
      url: "/agents/route",
      payload: { event: "invoice.overdue" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an insufficient scope with 403", async () => {
    const app = await buildApp(principal(["ledger:read"]));
    const res = await app.inject({
      method: "POST",
      url: "/agents/route",
      payload: { tenant_id: "tnt_acme", event: "invoice.overdue" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a cross-tenant request with 403", async () => {
    const app = await buildApp(principal(["execution:read"]));
    const res = await app.inject({
      method: "POST",
      url: "/agents/route",
      payload: { tenant_id: "tnt_other", event: "invoice.overdue" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("requires an event or intent", async () => {
    const app = await buildApp(principal(["execution:read"]));
    const res = await app.inject({
      method: "POST",
      url: "/agents/route",
      payload: { tenant_id: "tnt_acme" },
    });
    expect(res.statusCode).toBe(400);
  });
});
