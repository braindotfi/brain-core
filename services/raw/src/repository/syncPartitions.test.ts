import { describe, expect, it, vi } from "vitest";
import type { TenantScopedClient } from "@brain/shared";
import {
  claimPartition,
  commitCheckpoint,
  ensurePartitions,
  releasePartition,
} from "./syncPartitions.js";

function fakeClient(rows: Record<string, unknown[]> = {}): {
  client: TenantScopedClient;
  calls: Array<{ text: string; values: unknown[] }>;
} {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      for (const [needle, result] of Object.entries(rows)) {
        if (text.includes(needle)) return { rows: result, rowCount: result.length };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as TenantScopedClient;
  return { client, calls };
}

describe("ensurePartitions", () => {
  it("inserts one row per object type, idempotently via ON CONFLICT DO NOTHING", async () => {
    const { client, calls } = fakeClient();
    await ensurePartitions(client, "tnt_1", "src_1", [
      { objectType: "transaction", checkpointType: "cursor" },
      { objectType: "balance", checkpointType: "snapshot" },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.text).toContain(
      "ON CONFLICT (tenant_id, source_id, resource_id, object_type) DO NOTHING",
    );
    expect(calls[0]!.values.slice(1)).toEqual(["tnt_1", "src_1", "", "transaction", "cursor"]);
    expect(calls[1]!.values.slice(1)).toEqual(["tnt_1", "src_1", "", "balance", "snapshot"]);
  });
});

describe("claimPartition", () => {
  it("claims only a free or stale lease, returning the claimed row", async () => {
    const row = { id: "spart_1", pending_run_id: "sjob_run1" };
    const { client, calls } = fakeClient({ "UPDATE raw_sync_partitions": [row] });
    const claimed = await claimPartition(client, "spart_1", "sjob_run1");
    expect(claimed).toEqual(row);
    expect(calls[0]!.text).toContain("pending_run_id IS NULL");
    expect(calls[0]!.text).toContain("make_interval");
  });

  it("returns null when another run holds the lease", async () => {
    const { client } = fakeClient();
    expect(await claimPartition(client, "spart_1", "sjob_run2")).toBeNull();
  });
});

describe("commitCheckpoint", () => {
  it("advances the checkpoint only under the matching lease, in one UPDATE", async () => {
    const { client, calls } = fakeClient({ "UPDATE raw_sync_partitions": [{}] });
    const ok = await commitCheckpoint(
      client,
      "spart_1",
      "sjob_run1",
      { cursor: "c2" },
      {
        backfillComplete: true,
        releaseLease: true,
      },
    );
    expect(ok).toBe(true);
    const call = calls[0]!;
    expect(call.text).toContain("WHERE id = $1 AND pending_run_id = $2");
    expect(call.values).toEqual([
      "spart_1",
      "sjob_run1",
      JSON.stringify({ cursor: "c2" }),
      true,
      true,
    ]);
  });

  it("reports a lost lease as false (stale-lease takeover)", async () => {
    const { client } = fakeClient();
    const ok = await commitCheckpoint(client, "spart_1", "sjob_gone", null, {
      backfillComplete: false,
      releaseLease: false,
    });
    expect(ok).toBe(false);
  });
});

describe("releasePartition", () => {
  it("releases the lease without touching committed_checkpoint", async () => {
    const { client, calls } = fakeClient();
    await releasePartition(client, "spart_1", "sjob_run1", "provider 502");
    const call = calls[0]!;
    expect(call.text).not.toContain("committed_checkpoint =");
    expect(call.text).toContain("pending_run_id = NULL");
    expect(call.values).toEqual(["spart_1", "sjob_run1", "provider 502"]);
  });
});
