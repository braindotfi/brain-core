import { describe, expect, it, vi } from "vitest";
import type { TenantScopedClient } from "@brain/shared";
import {
  SUPPORTED_AUDIT_ENTITY_TYPES,
  findEventsByEntity,
  findEvent,
  findLatestAnchor,
  findAnchorByRoot,
  insertAnchor,
  listEventsForAnchor,
  queryEvents,
  setAnchorTxHash,
} from "./repository.js";

/**
 * Repository unit tests for the v0.3 entity-history endpoint helper.
 * Covers the type-map gate, predicate construction (hits BOTH inputs and
 * outputs), and the payment_intent special case (also matches by
 * policy_decision_id).
 */

function fakeClient(rows: unknown[] = []): {
  client: TenantScopedClient;
  log: { sql: string; values: unknown[] }[];
} {
  const log: { sql: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
      log.push({ sql, values: Array.from(values ?? []) });
      return { rows: [...rows], rowCount: rows.length };
    }),
  };
  return { client: client as unknown as TenantScopedClient, log };
}

describe("SUPPORTED_AUDIT_ENTITY_TYPES", () => {
  it("includes all v0.3 entity types referenced by audit events", () => {
    for (const t of [
      "account",
      "balance",
      "transaction",
      "counterparty",
      "obligation",
      "document",
      "invoice",
      "payment_intent",
      "reconciliation_match",
      "proposal",
      "execution",
    ]) {
      expect(SUPPORTED_AUDIT_ENTITY_TYPES).toContain(t);
    }
  });
});

describe("findEventsByEntity", () => {
  it("returns [] without querying for unknown entity types", async () => {
    const { client, log } = fakeClient();
    const rows = await findEventsByEntity(client, "unknown_type", "x_123", 10);
    expect(rows).toEqual([]);
    expect(log.length).toBe(0);
  });

  it("queries inputs->>'transaction_id' OR outputs->>'transaction_id' for transaction", async () => {
    const { client, log } = fakeClient();
    await findEventsByEntity(client, "transaction", "tx_01HQ7K3", 100);
    expect(log).toHaveLength(1);
    const sql = log[0]!.sql;
    expect(sql).toContain("(inputs->>'transaction_id') = $1");
    expect(sql).toContain("(outputs->>'transaction_id') = $1");
    expect(log[0]!.values).toEqual(["tx_01HQ7K3", 100]);
  });

  it("payment_intent also predicates on policy_decision_id", async () => {
    const { client, log } = fakeClient();
    await findEventsByEntity(client, "payment_intent", "pi_abc", 50);
    expect(log[0]!.sql).toContain("(inputs->>'payment_intent_id') = $1");
    expect(log[0]!.sql).toContain("policy_decision_id = $1");
  });

  it("orders chronologically (asc) so callers see the timeline", async () => {
    const { client, log } = fakeClient();
    await findEventsByEntity(client, "account", "acct_1", 10);
    expect(log[0]!.sql).toMatch(/ORDER BY created_at ASC/);
  });
});

describe("queryEvents", () => {
  it("returns rows from query with no filters", async () => {
    const { client, log } = fakeClient();
    await queryEvents(client, { limit: 20 });
    expect(log).toHaveLength(1);
    expect(log[0]!.sql).toContain("SELECT * FROM audit_events");
    expect(log[0]!.sql).not.toContain("WHERE");
    expect(log[0]!.values).toContain(20);
  });

  it("adds WHERE layer = $n when layer filter provided", async () => {
    const { client, log } = fakeClient();
    await queryEvents(client, { layer: "policy", limit: 10 });
    expect(log[0]!.sql).toContain("layer = $1");
    expect(log[0]!.values).toEqual(["policy", 10]);
  });

  it("adds since/until predicates and correct param indices", async () => {
    const { client, log } = fakeClient();
    const since = new Date("2024-01-01");
    const until = new Date("2024-12-31");
    await queryEvents(client, { since, until, limit: 5 });
    expect(log[0]!.sql).toContain("created_at >= $1");
    expect(log[0]!.sql).toContain("created_at <= $2");
    expect(log[0]!.values).toEqual([since, until, 5]);
  });

  it("orders desc so most recent events come first", async () => {
    const { client, log } = fakeClient();
    await queryEvents(client, { limit: 1 });
    expect(log[0]!.sql).toMatch(/ORDER BY created_at DESC/);
  });
});

describe("findEvent", () => {
  it("queries by id and returns null when no row", async () => {
    const { client, log } = fakeClient();
    const result = await findEvent(client, "evt_123");
    expect(log[0]!.sql).toContain("WHERE id = $1");
    expect(log[0]!.values).toEqual(["evt_123"]);
    expect(result).toBeNull();
  });

  it("returns the first row when present", async () => {
    const fakeRow = { id: "evt_123" };
    const { client } = fakeClient([fakeRow]);
    const result = await findEvent(client, "evt_123");
    expect(result).toBe(fakeRow);
  });
});

describe("listEventsForAnchor", () => {
  it("queries by periodStart and periodEnd ordered asc", async () => {
    const { client, log } = fakeClient();
    const start = new Date("2024-06-01");
    const end = new Date("2024-06-30");
    await listEventsForAnchor(client, start, end);
    expect(log[0]!.sql).toContain("created_at >= $1");
    expect(log[0]!.sql).toContain("created_at <= $2");
    expect(log[0]!.sql).toMatch(/ORDER BY created_at ASC/);
    expect(log[0]!.values).toEqual([start, end]);
  });
});

describe("insertAnchor", () => {
  it("inserts anchor row and returns it", async () => {
    const fakeRow = { id: "anc_1", tenant_id: "t1" };
    const { client, log } = fakeClient([fakeRow]);
    const root = Buffer.from("abc");
    const result = await insertAnchor(client, {
      id: "anc_1",
      tenantId: "t1",
      merkleRoot: root,
      eventCount: 5,
      periodStart: new Date("2024-01-01"),
      periodEnd: new Date("2024-01-31"),
    });
    expect(result).toBe(fakeRow);
    expect(log[0]!.sql).toContain("INSERT INTO audit_anchors");
    expect(log[0]!.sql).toContain("RETURNING *");
  });

  it("throws when insert returns no row", async () => {
    const { client } = fakeClient([]);
    await expect(
      insertAnchor(client, {
        id: "anc_2",
        tenantId: "t2",
        merkleRoot: Buffer.from("x"),
        eventCount: 0,
        periodStart: new Date(),
        periodEnd: new Date(),
      }),
    ).rejects.toThrow("audit_anchors insert returned no row");
  });

  it("returns the existing row when a concurrent insert won the race", async () => {
    // ON CONFLICT DO NOTHING returns no row when another publish for the same
    // (tenant, root) already inserted; §5.3 says re-anchoring is a no-op, so we
    // re-fetch and return the winner's row rather than throwing on the dup.
    const existing = { id: "anc_winner", tenant_id: "t1" };
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (sql.includes("INSERT INTO audit_anchors")) return { rows: [], rowCount: 0 };
        return { rows: [existing], rowCount: 1 };
      }),
    } as unknown as TenantScopedClient;
    const result = await insertAnchor(client, {
      id: "anc_loser",
      tenantId: "t1",
      merkleRoot: Buffer.from("dup"),
      eventCount: 3,
      periodStart: new Date(),
      periodEnd: new Date(),
    });
    expect(result).toBe(existing);
    expect(calls[0]).toContain("ON CONFLICT");
    expect(calls.some((s) => s.includes("WHERE merkle_root"))).toBe(true);
  });
});

describe("findLatestAnchor", () => {
  it("returns null when no anchors exist", async () => {
    const { client } = fakeClient();
    const result = await findLatestAnchor(client);
    expect(result).toBeNull();
  });

  it("queries ordered by period_end desc", async () => {
    const { client, log } = fakeClient();
    await findLatestAnchor(client);
    expect(log[0]!.sql).toMatch(/ORDER BY period_end DESC/);
  });
});

describe("findAnchorByRoot", () => {
  it("queries by merkle_root", async () => {
    const { client, log } = fakeClient();
    const root = Buffer.from("deadbeef", "hex");
    await findAnchorByRoot(client, root);
    expect(log[0]!.sql).toContain("WHERE merkle_root = $1");
    expect(log[0]!.values).toEqual([root]);
  });
});

describe("setAnchorTxHash", () => {
  it("issues UPDATE with txHash and blockNumber", async () => {
    const { client, log } = fakeClient();
    const txHash = Buffer.from("cafebabe", "hex");
    await setAnchorTxHash(client, "anc_1", txHash, 42n);
    expect(log[0]!.sql).toContain("SET onchain_tx_hash = $1");
    expect(log[0]!.sql).toContain("WHERE id = $3");
    expect(log[0]!.values).toEqual([txHash, "42", "anc_1"]);
  });
});
