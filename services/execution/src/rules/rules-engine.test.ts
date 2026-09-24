import { describe, expect, it } from "vitest";
import { newTenantId, newUserId, type ServiceCallContext } from "@brain/shared";
import type { Pool } from "pg";
import { RulesEngineService, evaluateJsonLogic } from "./rules-engine.js";

const TENANT = newTenantId();
const USER = newUserId();

function ctx(): ServiceCallContext {
  return { tenantId: TENANT, actor: USER, scopes: ["execution:admin"] };
}

describe("RulesEngineService", () => {
  it("evaluates JSON Logic conditions", () => {
    expect(evaluateJsonLogic({ ">=": [{ var: "amount" }, 5000] }, { amount: 6000 })).toBe(true);
    expect(evaluateJsonLogic({ "==": [{ var: "currency" }, "USD"] }, { currency: "AED" })).toBe(
      false,
    );
    expect(
      evaluateJsonLogic(
        { and: [{ ">": [{ var: "confidence" }, 0.95] }, { "==": [{ var: "type" }, "match"] }] },
        { confidence: 0.98, type: "match" },
      ),
    ).toBe(true);
  });

  it("returns propose when no rule matches", async () => {
    const service = new RulesEngineService(fakePool([]));

    await expect(service.evaluate(ctx(), "treasury", { amount: 10 })).resolves.toEqual({
      authority: "propose",
      decision: null,
      rule_id: null,
      matched: false,
    });
  });

  it("chooses the highest priority matching authority", async () => {
    const service = new RulesEngineService(
      fakePool([
        rule({ authority: "propose", priority: 10, decision: "approve" }),
        rule({ authority: "auto", priority: 20, decision: "confirm_all_matches" }),
      ]),
    );

    await expect(
      service.evaluate(ctx(), "reconciliation", { confidence: 0.99 }),
    ).resolves.toMatchObject({
      authority: "auto",
      decision: "confirm_all_matches",
      rule_id: "00000000-0000-4000-8000-000000000002",
      matched: true,
    });
  });

  it("rejects destructive auto authority at create time", async () => {
    const service = new RulesEngineService(fakePool([]));

    await expect(
      service.create(ctx(), {
        agent: "fraud_anomaly",
        decision: "freeze_card",
        condition: {},
        authority: "auto",
      }),
    ).rejects.toMatchObject({ code: "request_body_invalid" });
  });

  it("rejects destructive auto authority at startup", async () => {
    const service = new RulesEngineService(
      fakePool([rule({ authority: "auto", decision: "freeze_card" })]),
    );

    await expect(service.validateStartupRules()).rejects.toMatchObject({
      code: "request_body_invalid",
    });
  });
});

function rule(input: {
  authority: "auto" | "propose" | "deny";
  decision: string;
  priority?: number;
}) {
  const suffix = input.authority === "auto" ? "2" : "1";
  return {
    id: `00000000-0000-4000-8000-00000000000${suffix}`,
    tenant_id: TENANT,
    agent: "reconciliation",
    decision: input.decision,
    condition: { ">": [{ var: "confidence" }, 0.95] },
    authority: input.authority,
    priority: input.priority ?? 1,
    created_by: USER,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_by: USER,
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    enabled: true,
  };
}

function fakePool(rows: ReturnType<typeof rule>[]): Pool {
  let tenant: string | null = null;
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK")
        return { rows: [], rowCount: 0 };
      if (sql.startsWith("SELECT set_config")) {
        tenant = values[0] as string;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("authority = 'auto'")) {
        return {
          rows: rows.filter((row) => row.authority === "auto" && row.decision === "freeze_card"),
          rowCount: 1,
        };
      }
      if (tenant !== TENANT) throw new Error("tenant scope missing");
      if (sql.includes("FROM agent_authority_rules")) {
        return {
          rows: [...rows].sort((a, b) => b.priority - a.priority),
          rowCount: rows.length,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return { connect: async () => client, query: client.query } as unknown as Pool;
}
