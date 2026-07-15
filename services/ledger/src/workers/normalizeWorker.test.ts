import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { newTenantId, type MetricsEmitter } from "@brain/shared";
import {
  recordNormalizationResult,
  runNormalizeCycle,
  DEFAULT_MAX_NORMALIZATION_ATTEMPTS,
} from "./normalizeWorker.js";

function fakePool(): { pool: Pool; queries: string[]; values: unknown[][] } {
  const queries: string[] = [];
  const values: unknown[][] = [];
  const client = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      queries.push(text.trim().split("\n")[0]!.trim());
      values.push(params ?? []);
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, queries, values };
}

describe("recordNormalizationResult", () => {
  it("writes normalization_log inside a tenant-scoped transaction, recording the row's parser", async () => {
    const { pool, queries, values } = fakePool();
    const tenantId = newTenantId();
    await recordNormalizationResult(
      pool,
      { id: "prs_1", tenant_id: tenantId, parser: "doc_obligation_v1" },
      null,
    );

    const setIdx = queries.findIndex((q) => q.includes("set_config('app.tenant_id'"));
    const insIdx = queries.findIndex((q) => q.includes("INSERT INTO normalization_log"));
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(insIdx).toBeGreaterThan(setIdx);
    expect(queries).toContain("COMMIT");
    // The actual parser lands in the log, not a hardcoded plaid_tx_v1.
    expect(values[insIdx]).toEqual([
      "prs_1",
      tenantId,
      "doc_obligation_v1",
      null,
      DEFAULT_MAX_NORMALIZATION_ATTEMPTS,
    ]);
  });

  it("updates failed rows with attempts and quarantine state", async () => {
    const { pool, queries, values } = fakePool();
    const tenantId = newTenantId();
    await recordNormalizationResult(
      pool,
      { id: "prs_1", tenant_id: tenantId, parser: "plaid_tx_v1" },
      "boom",
      { maxAttempts: 3 },
    );

    const insIdx = queries.findIndex((q) => q.includes("INSERT INTO normalization_log"));
    expect(values[insIdx]).toEqual(["prs_1", tenantId, "plaid_tx_v1", "boom", 3]);
  });
});

describe("runNormalizeCycle", () => {
  it("retries transient failures and succeeds on a later cycle", async () => {
    const tenantId = newTenantId();
    const rows = [{ id: "prs_retry", tenant_id: tenantId, parser: "plaid_tx_v1" }];
    let pollCount = 0;
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (text.includes("FROM raw_parsed")) {
          pollCount += 1;
          return { rows: pollCount <= 2 ? rows : [], rowCount: pollCount <= 2 ? 1 : 0 };
        }
        if (text.includes("RETURNING attempts, quarantined")) {
          return { rows: [{ attempts: 1, quarantined: false }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = { connect: async () => client, query: client.query } as unknown as Pool;
    const normalizeRow = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(undefined);

    await runNormalizeCycle({ pool, normalizeRow }, { batchSize: 1, maxAttempts: 3 });
    await runNormalizeCycle({ pool, normalizeRow }, { batchSize: 1, maxAttempts: 3 });

    expect(normalizeRow).toHaveBeenCalledTimes(2);
    const pollSql = queries.find((q) => q.includes("FROM raw_parsed"))!;
    expect(pollSql).toContain("nl.error IS NULL OR nl.quarantined");
  });

  it("quarantines permanently failing rows and emits a metric", async () => {
    const tenantId = newTenantId();
    const row = { id: "prs_bad", tenant_id: tenantId, parser: "stripe_v1" };
    const metricsCalls: Array<{ name: string; tags?: Record<string, unknown> }> = [];
    const metrics = {
      increment: (name: string, tags?: Record<string, unknown>) => {
        metricsCalls.push({ name, tags });
      },
      gauge: vi.fn(),
      histogram: vi.fn(),
      duration: vi.fn(),
      close: vi.fn(async () => undefined),
    } satisfies MetricsEmitter;
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes("FROM raw_parsed")) return { rows: [row], rowCount: 1 };
        if (text.includes("RETURNING attempts, quarantined")) {
          return {
            rows: [{ attempts: DEFAULT_MAX_NORMALIZATION_ATTEMPTS, quarantined: true }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = { connect: async () => client, query: client.query } as unknown as Pool;

    await runNormalizeCycle(
      {
        pool,
        metrics,
        normalizeRow: vi.fn(async () => {
          throw new Error("permanent");
        }),
      },
      { batchSize: 1 },
    );

    expect(metricsCalls).toContainEqual(
      expect.objectContaining({
        name: "brain.ledger.normalize.quarantined.count",
        tags: expect.objectContaining({ parser: "stripe_v1" }),
      }),
    );
  });
});
