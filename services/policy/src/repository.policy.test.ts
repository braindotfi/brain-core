import { describe, expect, it, vi } from "vitest";
import type { TenantScopedClient } from "@brain/shared";
import {
  getActive,
  getByVersion,
  insertPolicy,
  listVersions,
  setSigners,
  transition,
} from "./repository.js";

type FakeClient = TenantScopedClient & {
  _log: { sql: string; values: unknown[] }[];
  _callCount: () => number;
};

function fakeClient(rows: unknown[] = []): FakeClient {
  const log: { sql: string; values: unknown[] }[] = [];
  let callCount = 0;
  const client = {
    _log: log,
    _callCount: () => callCount,
    query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
      log.push({ sql, values: Array.from(values ?? []) });
      callCount++;
      return { rows: [...rows], rowCount: rows.length };
    }),
  };
  return client as unknown as FakeClient;
}

const stubPolicy = {
  id: "pol_1",
  tenant_id: "t1",
  version: 1,
  content: { version: 1, rules: [] },
  content_hash: Buffer.from("ab", "hex"),
  quorum_required: 2,
  state: "draft" as const,
  created_by: "user_1",
  signers: null,
  activated_at: null,
  deactivated_at: null,
};

describe("insertPolicy", () => {
  it("inserts and returns the row", async () => {
    const client = fakeClient([stubPolicy]);
    const result = await insertPolicy(client, {
      id: "pol_1",
      tenantId: "t1",
      version: 1,
      content: { version: 1, rules: [] },
      contentHash: Buffer.from("ab", "hex"),
      quorumRequired: 2,
      state: "draft",
      createdBy: "user_1",
    });
    expect(result).toBe(stubPolicy);
    expect(client._log[0]!.sql).toContain("INSERT INTO policies");
    expect(client._log[0]!.sql).toContain("RETURNING *");
  });

  it("throws when insert returns no row", async () => {
    const client = fakeClient([]);
    await expect(
      insertPolicy(client, {
        id: "pol_x",
        tenantId: "t1",
        version: 2,
        content: { version: 2, rules: [] },
        contentHash: Buffer.from("cc", "hex"),
        quorumRequired: 1,
        state: "draft",
        createdBy: "user_1",
      }),
    ).rejects.toThrow("policies insert returned no row");
  });
});

describe("getActive", () => {
  it("returns null when no active policy", async () => {
    const client = fakeClient([]);
    const result = await getActive(client);
    expect(result).toBeNull();
    expect(client._log[0]!.sql).toContain("state = 'active'");
  });

  it("returns the active row when found", async () => {
    const active = { ...stubPolicy, state: "active" };
    const client = fakeClient([active]);
    const result = await getActive(client);
    expect(result).toBe(active);
  });
});

describe("getByVersion", () => {
  it("queries by version number", async () => {
    const client = fakeClient([]);
    await getByVersion(client, 3);
    expect(client._log[0]!.sql).toContain("version = $1");
    expect(client._log[0]!.values).toEqual([3]);
  });

  it("returns null when not found", async () => {
    const client = fakeClient([]);
    expect(await getByVersion(client, 99)).toBeNull();
  });
});

describe("listVersions", () => {
  it("orders by version DESC", async () => {
    const client = fakeClient([]);
    await listVersions(client);
    expect(client._log[0]!.sql).toMatch(/ORDER BY version DESC/);
  });
});

describe("setSigners", () => {
  it("issues UPDATE with JSON signers", async () => {
    const client = fakeClient([]);
    const signers = [{ address: "0xabc", signature: "0xsig" }];
    await setSigners(client, "pol_1", signers);
    expect(client._log[0]!.sql).toContain("SET signers = $1");
    expect(client._log[0]!.values[0]).toBe(JSON.stringify(signers));
    expect(client._log[0]!.values[1]).toBe("pol_1");
  });
});

describe("transition", () => {
  it("throws for invalid transitions", async () => {
    const client = fakeClient([]);
    await expect(transition(client, "pol_1", "active", "pending_signatures")).rejects.toMatchObject(
      { message: expect.stringContaining("invalid policy state transition") },
    );
  });

  it("issues UPDATE and returns row for valid transition", async () => {
    const updated = { ...stubPolicy, state: "cancelled" };
    const client = fakeClient([updated]);
    const result = await transition(client, "pol_1", "draft", "cancelled");
    expect(result).toBe(updated);
    expect(client._log[0]!.sql).toContain("SET state = $1");
  });

  it("deactivates existing active policy when transitioning to active", async () => {
    const activated = { ...stubPolicy, state: "active" };
    // First call deactivates active, second call returns new active row
    let call = 0;
    const client = {
      _log: [] as { sql: string; values: unknown[] }[],
      query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
        client._log.push({ sql, values: Array.from(values ?? []) });
        return { rows: call++ === 0 ? [] : [activated], rowCount: 1 };
      }),
    } as unknown as FakeClient;
    const result = await transition(client, "pol_1", "pending_signatures", "active");
    expect(result).toBe(activated);
    expect(client._log[0]!.sql).toContain("state = 'deactivated'");
  });

  it("throws when no row matches the transition (stale state)", async () => {
    const client = fakeClient([]);
    await expect(transition(client, "pol_1", "draft", "cancelled")).rejects.toMatchObject({
      message: expect.stringContaining("is not in state"),
    });
  });
});
