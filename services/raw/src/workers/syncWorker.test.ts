import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, MemoryBlobAdapter, newTenantId } from "@brain/shared";
import { runSyncCycle } from "./syncWorker.js";
import type {
  FetchIncrementalContext,
  FetchIncrementalResult,
  SourceAdapter,
} from "../adapters/types.js";

interface Call {
  text: string;
  values: unknown[];
}

/**
 * SQL-routing fake pool. Tracks every statement in order so tests can assert
 * the §10 invariant: artifact INSERTs come before the checkpoint UPDATE.
 */
function fakePool(tenantId: string, sourceId: string) {
  const calls: Call[] = [];
  const partitionRow = {
    id: "spart_tx",
    tenant_id: tenantId,
    source_id: sourceId,
    resource_id: "",
    object_type: "transaction",
    checkpoint_type: "cursor",
    committed_checkpoint: null,
    pending_run_id: null,
    last_successful_sync_at: null,
    backfill_status: "not_started",
    error_message: null,
  };
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      if (text.includes("FROM raw_sources") && text.includes("status = 'active'")) {
        return { rows: [{ id: sourceId, tenant_id: tenantId, type: "test_pull" }], rowCount: 1 };
      }
      if (text.includes("FROM raw_sync_partitions")) {
        return { rows: [partitionRow], rowCount: 1 };
      }
      if (text.includes("UPDATE raw_sync_partitions") && text.includes("RETURNING")) {
        // claim
        return { rows: [{ ...partitionRow, pending_run_id: values?.[1] }], rowCount: 1 };
      }
      if (text.includes("UPDATE raw_sync_partitions")) {
        // commit / release
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO raw_artifacts")) {
        return {
          rows: [
            {
              id: values?.[0],
              bytes: "10",
              source_type: values?.[3],
              source_schema: values?.[9] ?? null,
              ingested_at: new Date(),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: async () => client, query: client.query } as unknown as Pool;
  return { pool, calls };
}

function makeAdapter(
  pages: Array<Pick<FetchIncrementalResult, "nextCheckpoint" | "hasMore">>,
  seenCheckpoints: unknown[],
): SourceAdapter {
  let call = 0;
  return {
    sourceType: "other",
    syncObjectTypes: [{ objectType: "transaction", checkpointType: "cursor" }],
    async fetchIncremental(ctx: FetchIncrementalContext): Promise<FetchIncrementalResult> {
      seenCheckpoints.push(ctx.partition.committedCheckpoint);
      const page = pages[call];
      if (page === undefined) throw new Error("unexpected extra fetch");
      call++;
      return {
        artifacts: [
          {
            body: Buffer.from(`page-${call}`),
            mimeType: "application/json",
            sourceRef: { page: call },
            envelope: { idempotencyKey: `k${call}` },
          },
        ],
        nextCheckpoint: page.nextCheckpoint,
        hasMore: page.hasMore,
      };
    },
  };
}

describe("runSyncCycle", () => {
  it("backfills in pages, committing artifacts BEFORE each checkpoint advance", async () => {
    const tenantId = newTenantId();
    const { pool, calls } = fakePool(tenantId, "src_1");
    const audit = new InMemoryAuditEmitter();
    const seen: unknown[] = [];
    const adapter = makeAdapter(
      [
        { nextCheckpoint: { cursor: "c1" }, hasMore: true },
        { nextCheckpoint: { cursor: "c2" }, hasMore: false },
      ],
      seen,
    );

    await runSyncCycle({
      pool,
      blob: new MemoryBlobAdapter(),
      audit,
      resolveCredentials: async () => ({ access_token: "tok" }),
      adapterForType: () => adapter,
    });

    // Two pages: backfill starts at null, second page resumes from c1.
    expect(seen).toEqual([null, { cursor: "c1" }]);

    // Order invariant: every artifact INSERT precedes its checkpoint UPDATE.
    const artifactIdx = calls
      .map((c, i) => (c.text.startsWith("INSERT INTO raw_artifacts") ? i : -1))
      .filter((i) => i >= 0);
    const commitIdx = calls
      .map((c, i) =>
        c.text.includes("UPDATE raw_sync_partitions") && c.text.includes("committed_checkpoint")
          ? i
          : -1,
      )
      .filter((i) => i >= 0);
    expect(artifactIdx).toHaveLength(2);
    expect(commitIdx).toHaveLength(2);
    expect(artifactIdx[0]!).toBeLessThan(commitIdx[0]!);
    expect(artifactIdx[1]!).toBeLessThan(commitIdx[1]!);

    // Checkpoints advanced in order, final commit completes the backfill.
    expect(calls[commitIdx[0]!]!.values[2]).toBe(JSON.stringify({ cursor: "c1" }));
    expect(calls[commitIdx[1]!]!.values[2]).toBe(JSON.stringify({ cursor: "c2" }));
    expect(calls[commitIdx[1]!]!.values[4]).toBe(true); // backfillComplete

    // Batch manifests emitted per page.
    const manifests = audit.events.filter((e) => e.action === "raw.sync.batch");
    expect(manifests).toHaveLength(2);
    expect(manifests[0]!.inputs.has_more).toBe(true);
    expect(manifests[1]!.inputs.has_more).toBe(false);

    // Source freshness stamped after a successful partition run.
    expect(calls.some((c) => c.text.includes("UPDATE raw_sources SET last_synced_at"))).toBe(true);
  });

  it("never advances the checkpoint when the provider fetch fails", async () => {
    const tenantId = newTenantId();
    const { pool, calls } = fakePool(tenantId, "src_1");
    const audit = new InMemoryAuditEmitter();
    const adapter: SourceAdapter = {
      sourceType: "other",
      syncObjectTypes: [{ objectType: "transaction", checkpointType: "cursor" }],
      async fetchIncremental(): Promise<FetchIncrementalResult> {
        throw new Error("provider 502");
      },
    };

    await runSyncCycle({
      pool,
      blob: new MemoryBlobAdapter(),
      audit,
      resolveCredentials: async () => ({ access_token: "tok" }),
      adapterForType: () => adapter,
    });

    expect(calls.some((c) => c.text.includes("committed_checkpoint ="))).toBe(false);
    // Lease released with the error recorded.
    const release = calls.find(
      (c) =>
        c.text.includes("UPDATE raw_sync_partitions") && c.text.includes("pending_run_id = NULL"),
    );
    expect(release).toBeDefined();
    expect(release!.values[2]).toBe("provider 502");
    expect(calls.some((c) => c.text.startsWith("INSERT INTO raw_artifacts"))).toBe(false);
  });

  it("releases the lease without a checkpoint when credentials are unavailable", async () => {
    const tenantId = newTenantId();
    const { pool, calls } = fakePool(tenantId, "src_1");
    const adapter = makeAdapter([], []);

    await runSyncCycle({
      pool,
      blob: new MemoryBlobAdapter(),
      audit: new InMemoryAuditEmitter(),
      resolveCredentials: async () => null,
      adapterForType: () => adapter,
    });

    expect(calls.some((c) => c.text.includes("committed_checkpoint ="))).toBe(false);
    const release = calls.find(
      (c) =>
        c.text.includes("UPDATE raw_sync_partitions") && c.text.includes("pending_run_id = NULL"),
    );
    expect(release!.values[2]).toBe("credentials unavailable");
  });

  it("skips sources whose adapter has no pull modality", async () => {
    const tenantId = newTenantId();
    const { pool, calls } = fakePool(tenantId, "src_1");
    const pushOnly: SourceAdapter = { sourceType: "other" };

    await runSyncCycle({
      pool,
      blob: new MemoryBlobAdapter(),
      audit: new InMemoryAuditEmitter(),
      resolveCredentials: async () => ({}),
      adapterForType: () => pushOnly,
    });

    expect(calls.some((c) => c.text.includes("raw_sync_partitions"))).toBe(false);
  });
});
