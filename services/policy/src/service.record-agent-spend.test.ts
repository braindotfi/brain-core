/**
 * PolicyService.recordAgentSpend — the R-21 writer that makes
 * agent.spend_in_window / agent.tx_count_in_window actually accumulate.
 *
 * No Postgres: a fake TenantScopedClient answers the `getActive` SELECT with a
 * canned active-policy row and captures the policy_spend_counters INSERTs, so
 * we assert WHICH windows get incremented (union of the policy's spend + tx
 * windows) and that each carries the intent's tenant / agent / amount /
 * currency. The upsert "sum within the bucket" behaviour is incrementSpendCounter's
 * SQL (ON CONFLICT DO UPDATE) and is covered by the migration/integration path.
 */

import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { AuditEmitter, TenantScopedClient } from "@brain/shared";
import { PolicyService } from "./service.js";
import type { PolicyDocument, PolicyRule } from "./dsl.js";

function policyDoc(rules: PolicyRule[]): PolicyDocument {
  return { version: 1, rules };
}

function activeRow(content: PolicyDocument): Record<string, unknown> {
  return {
    id: "pol_1",
    tenant_id: "tnt_1",
    version: 1,
    content,
    content_hash: Buffer.from(""),
    signers: null,
    state: "active",
    quorum_required: 1,
    activated_at: null,
    deactivated_at: null,
    created_by: "user_1",
    created_at: new Date(0),
  };
}

interface CapturedInsert {
  tenantId: unknown;
  agentId: unknown;
  window: unknown;
  amount: unknown;
  currency: unknown;
}

function fakeClient(active: Record<string, unknown> | null): {
  client: TenantScopedClient;
  inserts: CapturedInsert[];
} {
  const inserts: CapturedInsert[] = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("FROM policies") && sql.includes("state = 'active'")) {
        return { rows: active === null ? [] : [active], rowCount: active === null ? 0 : 1 };
      }
      if (sql.includes("INSERT INTO policy_spend_counters")) {
        // incrementSpendCounter params: [id, tenantId, agentId, window, bucketStart, amount, currency]
        inserts.push({
          tenantId: params[1],
          agentId: params[2],
          window: params[3],
          amount: params[5],
          currency: params[6],
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as TenantScopedClient;
  return { client, inserts };
}

const deps = { pool: {} as Pool, audit: { emit: vi.fn() } as unknown as AuditEmitter };

function rule(when: PolicyRule["when"]): PolicyRule {
  return { id: "r1", applies_to: ["outbound_payment"], when, execute: "auto" };
}

const SPEND = "24h";

describe("PolicyService.recordAgentSpend", () => {
  it("increments the union of the policy's spend and tx windows", async () => {
    const doc = policyDoc([
      rule({ "agent.spend_in_window": { window: "24h", lte: { currency: "USD", value: "1000" } } }),
      rule({ "agent.tx_count_in_window": { window: "1h", lte: 5 } }),
    ]);
    const { client, inserts } = fakeClient(activeRow(doc));
    const svc = new PolicyService(deps);

    await svc.recordAgentSpend(client, {
      tenantId: "tnt_1",
      agentId: "agent_x",
      amount: "42.00",
      currency: "USD",
    });

    expect(inserts.map((i) => i.window).sort()).toEqual(["1h", "24h"]);
    for (const i of inserts) {
      expect(i).toMatchObject({
        tenantId: "tnt_1",
        agentId: "agent_x",
        amount: "42.00",
        currency: "USD",
      });
    }
  });

  it("dedupes a window referenced by multiple rules", async () => {
    const doc = policyDoc([
      rule({ "agent.spend_in_window": { window: SPEND, lte: { currency: "USD", value: "1000" } } }),
      rule({ "agent.spend_in_window": { window: SPEND, lte: { currency: "USD", value: "2000" } } }),
    ]);
    const { client, inserts } = fakeClient(activeRow(doc));
    const svc = new PolicyService(deps);

    await svc.recordAgentSpend(client, {
      tenantId: "tnt_1",
      agentId: "agent_x",
      amount: "10",
      currency: "USD",
    });

    expect(inserts.map((i) => i.window)).toEqual(["24h"]);
  });

  it("is a no-op when the tenant has no active policy", async () => {
    const { client, inserts } = fakeClient(null);
    const svc = new PolicyService(deps);
    await svc.recordAgentSpend(client, {
      tenantId: "tnt_1",
      agentId: "agent_x",
      amount: "10",
      currency: "USD",
    });
    expect(inserts).toEqual([]);
  });

  it("is a no-op when the active policy declares no spend/tx windows", async () => {
    const doc = policyDoc([rule({ "amount.lte": { currency: "USD", value: "500" } })]);
    const { client, inserts } = fakeClient(activeRow(doc));
    const svc = new PolicyService(deps);
    await svc.recordAgentSpend(client, {
      tenantId: "tnt_1",
      agentId: "agent_x",
      amount: "10",
      currency: "USD",
    });
    expect(inserts).toEqual([]);
  });
});
