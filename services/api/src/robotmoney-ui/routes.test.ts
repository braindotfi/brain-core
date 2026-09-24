import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { errorHandlerPlugin, newAccountId, newTenantId } from "@brain/shared";
import { registerRobotMoneyUiRoutes } from "./routes.js";

const TENANT = newTenantId();
const ACCOUNT = newAccountId();

function makePool(rowsFor: (sql: string, values: unknown[]) => unknown[]): Pool {
  const client = {
    query: vi.fn((sql: string, values: unknown[] = []) => {
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      const rows = rowsFor(sql, values);
      return Promise.resolve({ rows, rowCount: rows.length });
    }),
    release: vi.fn(),
  };
  return { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool;
}

async function buildApp(pool: Pool) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request) => {
    request.principal = {
      id: "user_1",
      type: "user",
      tenantId: TENANT,
      scopes: [
        "execution:read",
        "execution:admin",
        "ledger:read",
        "ledger:write",
        "payment_intent:propose",
      ],
      tokenId: "tok_1",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  });
  await registerRobotMoneyUiRoutes(app, { pool });
  return app;
}

describe("RobotMoney UI routes", () => {
  it("upserts the business profile contract", async () => {
    const pool = makePool((sql) =>
      sql.includes("INSERT INTO tenant_profiles")
        ? [
            {
              tenant_id: TENANT,
              legal_name: "Acme Inc",
              tax_id: "12-3456789",
              accountant: { name: "Sam Lee", org: "Ledger CPA", email: "sam@example.com" },
              operating_account_id: ACCOUNT,
              net_burn_per_day: "10.00",
            },
          ]
        : [],
    );
    const app = await buildApp(pool);
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/tenant/profile",
        payload: {
          legal_name: "Acme Inc",
          ein: "12-3456789",
          accountant: { name: "Sam Lee", org: "Ledger CPA", email: "sam@example.com" },
          operating_account_id: ACCOUNT,
          net_burn_per_day: "10.00",
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        tenant_id: TENANT,
        legal_name: "Acme Inc",
        tax_id: "12-3456789",
        accountant: { name: "Sam Lee", org: "Ledger CPA", email: "sam@example.com" },
        operating_account_id: ACCOUNT,
        net_burn_per_day: "10.00",
      });
    } finally {
      await app.close();
    }
  });

  it("creates an exchange quote contract", async () => {
    const pool = makePool(() => []);
    const app = await buildApp(pool);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/exchange/quote",
        payload: { source_currency: "USD", destination_currency: "ETH", amount: "1000" },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json() as {
        rate_lock_reference: string;
        destination_currency: string;
        rate: string;
      };
      expect(body.rate_lock_reference).toBeTruthy();
      expect(body.destination_currency).toBe("ETH");
      expect(body.rate).toBe("0.000300000000");
    } finally {
      await app.close();
    }
  });

  it("returns the 12 agent overview rows", async () => {
    const pool = makePool((sql) => {
      if (sql.includes("FROM agent_authority_rules")) {
        return [
          { agent: "treasury", id: "rule_1", decision: "sweep", authority: "auto", condition: {} },
          {
            agent: "treasury",
            id: "rule_2",
            decision: "hold",
            authority: "propose",
            condition: {},
          },
        ];
      }
      if (sql.includes("FROM user_agent_authority")) {
        return [{ agent: "treasury", per_user_overrides_count: 1 }];
      }
      if (sql.includes("FROM proposals")) {
        return [
          {
            agent: "treasury",
            weekly_decision_count: 3,
            last_activity_at: new Date("2026-09-21T00:00:00Z"),
          },
        ];
      }
      if (sql.includes("FROM audit_events")) return [];
      return [];
    });
    const app = await buildApp(pool);
    try {
      const response = await app.inject({ method: "GET", url: "/agents/overview" });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        agents: Array<{
          agent_key: string;
          active_rules_count: number;
          authority_summary: { per_user_overrides_count: number };
        }>;
      };
      expect(body.agents).toHaveLength(12);
      expect(body.agents.find((agent) => agent.agent_key === "treasury")).toMatchObject({
        active_rules_count: 2,
        authority_summary: { per_user_overrides_count: 1 },
      });
    } finally {
      await app.close();
    }
  });

  it("returns an account with paged transactions", async () => {
    const pool = makePool((sql) => {
      if (sql.includes("FROM ledger_accounts")) {
        return [
          {
            id: ACCOUNT,
            account_type: "bank_checking",
            name: "Operating",
            institution: "Brain Bank",
            available_balance: "1200.00",
            current_balance: "1200.00",
            currency: "USD",
            updated_at: new Date("2026-09-21T00:00:00Z"),
          },
        ];
      }
      if (sql.includes("FROM ledger_transactions")) {
        return [
          {
            id: "tx_01TESTTX000000000000000",
            amount: "25.00",
            currency: "USD",
            direction: "outflow",
            transaction_date: new Date("2026-09-20T00:00:00Z"),
            posted_date: null,
            status: "posted",
          },
        ];
      }
      return [];
    });
    const app = await buildApp(pool);
    try {
      const response = await app.inject({
        method: "GET",
        url: `/accounts/${ACCOUNT}?limit=1`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { account: { type: string }; transactions: unknown[] };
      expect(body.account.type).toBe("checking");
      expect(body.transactions).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("returns account trends and only Operating safety floor", async () => {
    const savings = "acct_01TESTSAVINGS0000000000";
    const pool = makePool((sql) => {
      if (sql.includes("FROM ledger_accounts")) {
        return [
          {
            id: ACCOUNT,
            account_type: "bank_checking",
            name: "Operating",
            institution: "Brain Bank",
            available_balance: "1200.00",
            current_balance: "1200.00",
            currency: "USD",
            updated_at: new Date("2026-09-21T00:00:00Z"),
          },
          {
            id: savings,
            account_type: "bank_savings",
            name: "Reserve",
            institution: "Brain Bank",
            available_balance: "5000.00",
            current_balance: "5000.00",
            currency: "USD",
            updated_at: new Date("2026-09-21T00:00:00Z"),
          },
        ];
      }
      if (sql.includes("FROM tenant_profiles")) {
        return [{ operating_account_id: ACCOUNT, net_burn_per_day: "10.00" }];
      }
      if (sql.includes("WITH account_scope")) {
        return [
          {
            account_id: ACCOUNT,
            delta_amount: "48.00",
            flagged_count: 1,
            sparkline: ["0", "10", "-5", "12", "9", "8", "14"],
          },
          {
            account_id: savings,
            delta_amount: "0.00",
            flagged_count: 0,
            sparkline: ["0", "0", "0", "0", "0", "0", "0"],
          },
        ];
      }
      if (sql.includes("date_trunc('year'")) {
        return [{ account_id: savings, ytd_yield: "56.00" }];
      }
      return [];
    });
    const app = await buildApp(pool);
    try {
      const response = await app.inject({ method: "GET", url: "/accounts" });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        accounts: Array<{
          id: string;
          trend: { delta_amount: number; direction: string; sparkline: number[]; note: string };
          safety_floor: null | { label: string; floor_amount: number; state: string };
        }>;
      };
      expect(body.accounts).toHaveLength(2);
      expect(body.accounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: ACCOUNT,
            trend: expect.objectContaining({
              delta_amount: 48,
              direction: "up",
              note: "1 flagged",
              sparkline: [0, 10, -5, 12, 9, 8, 14],
            }),
            safety_floor: {
              label: "90-day burn floor",
              current_amount: 1200,
              floor_amount: 900,
              headroom_amount: 300,
              headroom_display: "$300 above",
              state: "above",
            },
          }),
          expect.objectContaining({
            id: savings,
            trend: expect.objectContaining({
              delta_amount: 56,
              direction: "up",
              window: "this year",
            }),
            safety_floor: null,
          }),
        ]),
      );
    } finally {
      await app.close();
    }
  });

  it("returns the demo Operating account with a seeded safety floor", async () => {
    const operating = "acct_brainsaas_operating";
    const reserve = "acct_brainsaas_reserve";
    const pool = makePool((sql) => {
      if (sql.includes("FROM ledger_accounts")) {
        return [
          {
            id: operating,
            account_type: "bank_checking",
            name: "Operating",
            institution: "First Meridian Bank",
            available_balance: "2900000.00",
            current_balance: "2900000.00",
            currency: "USD",
            updated_at: new Date("2026-09-21T00:00:00Z"),
          },
          {
            id: reserve,
            account_type: "bank_savings",
            name: "Reserve",
            institution: "First Meridian Bank",
            available_balance: "650000.00",
            current_balance: "650000.00",
            currency: "USD",
            updated_at: new Date("2026-09-21T00:00:00Z"),
          },
        ];
      }
      if (sql.includes("FROM tenant_profiles")) {
        return [{ operating_account_id: operating, net_burn_per_day: "4900.00" }];
      }
      return [];
    });
    const app = await buildApp(pool);
    try {
      const response = await app.inject({ method: "GET", url: "/accounts" });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        accounts: Array<{
          id: string;
          name: string;
          safety_floor: null | {
            label: string;
            current_amount: number;
            floor_amount: number;
            headroom_amount: number;
            state: string;
          };
        }>;
      };
      expect(body.accounts.find((account) => account.id === operating)).toMatchObject({
        name: "Operating",
        safety_floor: {
          label: "90-day burn floor",
          current_amount: 2900000,
          floor_amount: 441000,
          headroom_amount: 2459000,
          state: "above",
        },
      });
      expect(body.accounts.find((account) => account.id === reserve)?.safety_floor).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("creates and returns a contact contract", async () => {
    const pool = makePool((sql) =>
      sql.includes("INSERT INTO ledger_counterparties")
        ? [{ id: "cp_01TESTCONTACT000000000000", name: "Acme", type: "vendor", status: "active" }]
        : [],
    );
    const app = await buildApp(pool);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/contacts",
        payload: { name: "Acme", type: "vendor" },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ name: "Acme", type: "vendor", status: "active" });
    } finally {
      await app.close();
    }
  });

  it("searches with the query field and counterparty kind", async () => {
    const pool = makePool((sql) =>
      sql.includes("FROM ledger_counterparties")
        ? [{ id: "cp_01TESTCONTACT000000000000", name: "Acme", type: "vendor" }]
        : [],
    );
    const app = await buildApp(pool);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/search",
        payload: { query: "Acme", kinds: ["counterparty"], limit: 5 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        expect.objectContaining({ kind: "counterparty", title: "Acme" }),
      ]);
    } finally {
      await app.close();
    }
  });
});
