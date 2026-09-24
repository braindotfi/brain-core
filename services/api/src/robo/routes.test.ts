import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { InMemoryAuditEmitter, errorHandlerPlugin, newTenantId } from "@brain/shared";
import { registerRoboRoutes } from "./routes.js";
import { RoboService } from "./service.js";
import type { DecisionAuditLogEntry } from "@brain/execution";
import type { Pool } from "pg";

const TENANT = newTenantId();

describe("Robo routes", () => {
  it("returns the overnight action contract", async () => {
    const app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin);
    app.addHook("preHandler", async (request) => {
      request.principal = {
        id: "user_1",
        type: "user",
        tenantId: TENANT,
        scopes: ["wiki:read"],
        tokenId: "tok_1",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    });
    await registerRoboRoutes(app, {
      pool: {} as never,
      audit: {} as never,
      askWiki: async () => {
        throw new Error("not used");
      },
      recordDeterministicIntentUsage: async () => undefined,
      wikiDeps: {} as never,
      questionModel: "test",
      service: {
        getOvernight: async () => ({
          window: {
            start: "2026-09-20T20:00:00.000Z",
            end: "2026-09-21T08:00:00.000Z",
          },
          action_count: 1,
          actions: [
            {
              agent: "Reconciliation",
              summary: "Reconciliation completed daily matching.",
              related_proposal_ids: ["prop_01K5P89Y9S1TF48WWGKG7JKW8B"],
              occurred_at: "2026-09-21T02:00:00.000Z",
            },
          ],
        }),
      } as unknown as RoboService,
    });
    try {
      const response = await app.inject({ method: "GET", url: "/robo/overnight" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        window: {
          start: "2026-09-20T20:00:00.000Z",
          end: "2026-09-21T08:00:00.000Z",
        },
        action_count: 1,
        actions: [
          {
            agent: "Reconciliation",
            summary: "Reconciliation completed daily matching.",
            related_proposal_ids: ["prop_01K5P89Y9S1TF48WWGKG7JKW8B"],
            occurred_at: "2026-09-21T02:00:00.000Z",
          },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it("returns demo overnight actions when the audit log has entries", async () => {
    const app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin);
    app.addHook("preHandler", async (request) => {
      request.principal = {
        id: "user_1",
        type: "user",
        tenantId: TENANT,
        scopes: ["wiki:read"],
        tokenId: "tok_1",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    });
    const entries: DecisionAuditLogEntry[] = [
      auditEntry("reconciliation", "prop_demo_recon", "2026-09-22T02:00:00.000Z", {
        matched_count: 203,
        period: "August",
        exception_count: 2,
      }),
      auditEntry("cash_forecast", "prop_demo_cash", "2026-09-22T03:00:00.000Z", {
        change_word: "steady",
        months: 11,
      }),
      auditEntry("fraud_anomaly", "prop_demo_fraud", "2026-09-22T01:00:00.000Z", {
        amount: 4200,
        currency: "USD",
        card_last4: "4242",
        reason_hint: "outside normal region",
      }),
    ];
    const service = new RoboService({
      pool: overnightPool() as Pool,
      audit: new InMemoryAuditEmitter(),
      askWiki: async () => {
        throw new Error("not used");
      },
      recordDeterministicIntentUsage: async () => undefined,
      wikiDeps: {} as never,
      questionModel: "test",
      auditLog: { list: async () => ({ entries, next_cursor: null }) },
      now: () => new Date("2026-09-22T08:00:00.000Z"),
    });
    await registerRoboRoutes(app, {
      pool: overnightPool() as Pool,
      audit: new InMemoryAuditEmitter(),
      askWiki: async () => {
        throw new Error("not used");
      },
      recordDeterministicIntentUsage: async () => undefined,
      wikiDeps: {} as never,
      questionModel: "test",
      service,
    });
    try {
      const response = await app.inject({ method: "GET", url: "/robo/overnight" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        action_count: 3,
        actions: [
          {
            agent: "Cash",
            summary: "Refreshed cash forecast · runway steady at 11 months",
            related_proposal_ids: ["prop_demo_cash"],
          },
          {
            agent: "Reconciliation",
            summary: "Matched 203 August bank items to invoices and bills · 2 exceptions queued",
            related_proposal_ids: ["prop_demo_recon"],
          },
          {
            agent: "Fraud",
            summary: "Flagged unusual $4,200 charge on the 4242 card · outside normal region",
            related_proposal_ids: ["prop_demo_fraud"],
          },
        ],
      });
    } finally {
      await app.close();
    }
  });
});

function overnightPool(): Pool {
  return {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK")
          return { rows: [], rowCount: 0 };
        if (sql.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 };
        if (sql.includes("FROM audit_events")) {
          return { rows: [{ created_at: new Date("2026-09-21T20:00:00.000Z") }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    }),
  } as unknown as Pool;
}

function auditEntry(
  agent: string,
  proposalId: string,
  occurredAt: string,
  details: Record<string, unknown>,
): DecisionAuditLogEntry {
  return {
    id: `00000000-0000-4000-8000-${proposalId.slice(-12).padStart(12, "0")}`,
    tenant_id: TENANT,
    occurred_at: occurredAt,
    actor: { type: "agent", id: `agent_${agent}`, display_name: null },
    proposal_id: proposalId,
    agent,
    decision: "approve",
    outcome: { status: "recorded", details },
    policy_context: {},
    payload_snapshot_id: "00000000-0000-4000-8000-000000000201",
    event_id: `evt_${proposalId}`,
    event_action: "decision.executed",
    archived_at: null,
    cold_storage_uri: null,
    created_at: occurredAt,
  };
}
