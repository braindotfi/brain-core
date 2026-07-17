import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  errorHandlerPlugin,
  newAgentId,
  newPaymentIntentId,
  newProposalId,
  newTenantId,
  requestIdPlugin,
  type PaymentIntent,
  type Principal,
  type Scope,
} from "@brain/shared";
import type { Pool } from "pg";
import { registerPaymentIntentRoutes } from "../payment-intents/routes.js";
import type { PaymentIntentService } from "../payment-intents/PaymentIntentService.js";
import { getPaymentIntentAgent } from "./read-model.js";
import { registerProposalReadRoutes } from "./routes.js";
import { ProposalDecisionService } from "./decision-service.js";

const TENANT_A = newTenantId();
const TENANT_B = newTenantId();
const AGENT_PAYMENT = newAgentId();
const AGENT_VENDOR = newAgentId();
const PI_ID = newPaymentIntentId();
const PROP_1 = newProposalId();
const PROP_2 = newProposalId();
const PROP_3 = newProposalId();
const ENT_RESOLVES = "ent_01H00000000000000000000000";
const ENT_MISSING = "ent_01H00000000000000000000001";

interface RawProposalFixture {
  id: string;
  source_kind: "payment_intent" | "proposal";
  type: string | null;
  created_at: Date;
  status: string;
  risk_band: string | null;
  confidence: number | null;
  mode: "propose" | "notify_only";
  narrative: string | null;
  action: Record<string, unknown> | null;
  evidence_ids: string[] | null;
  agent_id: string | null;
  agent_kind: string | null;
  agent_display_name: string | null;
  payment_intent_id: string | null;
  action_type: string | null;
}

function principal(tenantId: string, scopes: Scope[] = ["execution:read"]): Principal {
  return {
    id: "user_01TEST0000000000000000000",
    type: "user",
    tenantId,
    scopes,
    tokenId: "tok_01TEST0000000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

async function buildApp(pool: Pool, p: Principal): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request) => {
    request.principal = p;
  });
  await registerProposalReadRoutes(app, { pool });
  return app;
}

function proposalRow(input: Partial<RawProposalFixture> & { id: string }): RawProposalFixture {
  return {
    id: input.id,
    source_kind: input.source_kind ?? "proposal",
    type: input.type ?? "vendor_risk",
    created_at: input.created_at ?? new Date("2026-01-01T00:00:00.000Z"),
    status: input.status ?? "pending",
    risk_band: input.risk_band ?? "elevated",
    confidence: input.confidence ?? 0.72,
    mode: input.mode ?? "propose",
    narrative: input.narrative ?? "Vendor risk increased after invoice anomaly.",
    action: input.action ?? {
      type: input.type ?? "vendor_risk",
      evidence_refs: [
        { kind: "invoice", ref: "inv_1" },
        { kind: "wiki_entity", ref: ENT_RESOLVES },
        { kind: "wiki_entity", ref: ENT_MISSING },
        "legacy_ref",
      ],
    },
    evidence_ids: input.evidence_ids ?? [],
    agent_id: input.agent_id ?? AGENT_VENDOR,
    agent_kind: input.agent_kind ?? "internal",
    agent_display_name: input.agent_display_name ?? "Vendor Risk Agent",
    payment_intent_id: input.payment_intent_id ?? null,
    action_type: input.action_type ?? null,
  };
}

function paymentIntentRecord(): PaymentIntent {
  const now = "2026-01-02T00:00:00.000Z";
  return {
    id: PI_ID,
    owner_id: TENANT_A,
    created_by_agent_id: AGENT_PAYMENT,
    action_type: "ach_outbound",
    source_account_id: "acct_01TEST0000000000000000000",
    destination_counterparty_id: "cp_01TEST00000000000000000000",
    amount: "10.00",
    currency: "USD",
    obligation_id: null,
    invoice_id: null,
    status: "approved",
    policy_decision_id: "pd_01TEST00000000000000000000",
    approval_ids: [],
    execution_receipt_ids: [],
    source_ids: [],
    evidence_ids: [ENT_RESOLVES],
    provenance: "agent_contributed",
    confidence: 0.91,
    created_at: now,
    updated_at: now,
  };
}

function fakePool(rowsByTenant: Record<string, RawProposalFixture[]>): Pool {
  let tenant: string | null = null;
  const wikiEntitiesByTenant: Record<string, Set<string>> = {
    [TENANT_A]: new Set([ENT_RESOLVES]),
    [TENANT_B]: new Set(),
  };

  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT set_config")) {
        tenant = values[0] as string;
        return { rows: [], rowCount: 0 };
      }
      if (tenant === null) throw new Error("tenant scope was not set");

      if (sql.includes("SELECT id FROM wiki_entities")) {
        const ids = values[0] as string[];
        const visible = wikiEntitiesByTenant[tenant] ?? new Set<string>();
        return { rows: ids.filter((id) => visible.has(id)).map((id) => ({ id })), rowCount: 1 };
      }

      if (sql.includes("ledger_payment_intents") && sql.includes("FROM proposals p")) {
        const allRows = [...(rowsByTenant[tenant] ?? [])].sort(compareRows);
        const idFilter = sql.includes("id = $")
          ? values.find((value) => typeof value === "string" && isFixtureId(value))
          : undefined;
        let filtered =
          idFilter !== undefined ? allRows.filter((row) => row.id === idFilter) : allRows;

        const cursorId = values.find(
          (value) =>
            typeof value === "string" &&
            filtered.some((row) => row.id !== value) &&
            allRows.some((row) => row.id === value),
        );
        const cursorCreatedAt = values.find(
          (value) =>
            typeof value === "string" &&
            value.includes("T") &&
            !Number.isNaN(new Date(value).getTime()),
        );
        if (typeof cursorId === "string" && typeof cursorCreatedAt === "string") {
          filtered = filtered.filter(
            (row) =>
              row.created_at.toISOString() < cursorCreatedAt ||
              (row.created_at.toISOString() === cursorCreatedAt && row.id < cursorId),
          );
        }

        const limit = values.at(-1) as number;
        return { rows: filtered.slice(0, limit), rowCount: filtered.length };
      }

      if (sql.includes("JOIN agents a ON a.id = pi.created_by_agent_id")) {
        if (tenant !== TENANT_A || values[0] !== PI_ID) return { rows: [], rowCount: 0 };
        return {
          rows: [{ id: AGENT_PAYMENT, kind: "internal", display_name: "Payment Agent" }],
          rowCount: 1,
        };
      }

      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return { connect: async () => client } as unknown as Pool;
}

function compareRows(a: RawProposalFixture, b: RawProposalFixture): number {
  const byDate = b.created_at.getTime() - a.created_at.getTime();
  return byDate !== 0 ? byDate : b.id.localeCompare(a.id);
}

function isFixtureId(value: string): boolean {
  return value === PI_ID || value === PROP_1 || value === PROP_2 || value === PROP_3;
}

describe("GET /proposals", () => {
  it("cursor-paginates a unified proposal list", async () => {
    const pool = fakePool({
      [TENANT_A]: [
        proposalRow({ id: PROP_1, created_at: new Date("2026-01-03T00:00:00.000Z") }),
        proposalRow({ id: PROP_2, created_at: new Date("2026-01-02T00:00:00.000Z") }),
        proposalRow({ id: PROP_3, created_at: new Date("2026-01-01T00:00:00.000Z") }),
      ],
    });
    const app = await buildApp(pool, principal(TENANT_A));

    const first = await app.inject({ method: "GET", url: "/proposals?limit=2" });
    expect(first.statusCode).toBe(200);
    expect(first.json().proposals.map((p: { id: string }) => p.id)).toEqual([PROP_1, PROP_2]);
    expect(first.json().next_cursor).toEqual(expect.any(String));

    const second = await app.inject({
      method: "GET",
      url: `/proposals?limit=2&cursor=${encodeURIComponent(first.json().next_cursor)}`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().proposals.map((p: { id: string }) => p.id)).toEqual([PROP_3]);
    expect(second.json().next_cursor).toBeNull();

    await app.close();
  });

  it("does not read proposals across tenants", async () => {
    const pool = fakePool({
      [TENANT_A]: [proposalRow({ id: PROP_1 })],
      [TENANT_B]: [],
    });
    const tenantAApp = await buildApp(pool, principal(TENANT_A));
    const tenantBApp = await buildApp(pool, principal(TENANT_B));

    expect(
      (await tenantAApp.inject({ method: "GET", url: `/proposals/${PROP_1}` })).statusCode,
    ).toBe(200);
    const blocked = await tenantBApp.inject({ method: "GET", url: `/proposals/${PROP_1}` });
    expect(blocked.statusCode).toBe(404);
    expect(blocked.json().error.code).toBe("execution_proposal_not_found");

    await tenantAApp.close();
    await tenantBApp.close();
  });

  it("returns typed evidence refs and marks only live Wiki entities resolvable", async () => {
    const pool = fakePool({ [TENANT_A]: [proposalRow({ id: PROP_1 })] });
    const app = await buildApp(pool, principal(TENANT_A));

    const res = await app.inject({ method: "GET", url: `/proposals/${PROP_1}` });

    expect(res.statusCode).toBe(200);
    expect(res.json().evidence).toEqual([
      { kind: "invoice", ref: "inv_1", resolvable: false },
      { kind: "wiki_entity", ref: ENT_RESOLVES, resolvable: true },
      { kind: "wiki_entity", ref: ENT_MISSING, resolvable: false },
      { kind: "unknown", ref: "legacy_ref", resolvable: false },
    ]);
    await app.close();
  });
});

describe("GET /payment-intents/:id?expand=agent", () => {
  it("returns the agent provenance block from the stored agent row", async () => {
    const pool = fakePool({ [TENANT_A]: [] });
    const app = Fastify();
    await app.register(requestIdPlugin);
    await app.register(errorHandlerPlugin);
    app.addHook("preHandler", async (request) => {
      request.principal = principal(TENANT_A);
    });
    const service = {
      get: vi.fn(async () => paymentIntentRecord()),
    } as unknown as PaymentIntentService;
    await registerPaymentIntentRoutes(app, service, undefined, (ctx, id) =>
      getPaymentIntentAgent(pool, ctx, id),
    );

    const res = await app.inject({ method: "GET", url: `/payment-intents/${PI_ID}?expand=agent` });

    expect(res.statusCode).toBe(200);
    expect(res.json().agent).toEqual({
      id: AGENT_PAYMENT,
      kind: "internal",
      display_name: "Payment Agent",
    });
    await app.close();
  });
});

describe("POST /proposals/:id/decide", () => {
  it("requires a relevant scope before invoking the decision service", async () => {
    const pool = fakePool({ [TENANT_A]: [] });
    const app = Fastify();
    await app.register(requestIdPlugin);
    await app.register(errorHandlerPlugin);
    app.addHook("preHandler", async (request) => {
      request.principal = principal(TENANT_A, []);
    });
    const decisions = Object.create(ProposalDecisionService.prototype) as ProposalDecisionService;
    decisions.decide = vi.fn();
    await registerProposalReadRoutes(app, { pool, decisions });

    const res = await app.inject({
      method: "POST",
      url: `/proposals/${PROP_1}/decide`,
      payload: { decision: "acknowledge" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("auth_scope_insufficient");
    expect(decisions.decide).not.toHaveBeenCalled();
    await app.close();
  });
});
