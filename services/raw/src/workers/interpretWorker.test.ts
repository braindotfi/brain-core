import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, MemoryBlobAdapter, MockMetrics, newTenantId } from "@brain/shared";
import { runInterpretCycle } from "./interpretWorker.js";
import { DOCUMENT_RECORDS_UPLOAD_PARSER, UPLOAD_DOCUMENT_SCHEMA } from "../interpreters/upload.js";

interface Call {
  text: string;
  values: unknown[];
}

function fakePool(artifacts: Array<Record<string, unknown>>) {
  const calls: Call[] = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      if (text.includes("FROM raw_artifacts ra")) {
        return { rows: artifacts, rowCount: artifacts.length };
      }
      if (text.startsWith("INSERT INTO raw_parsed")) {
        return {
          rows: [
            {
              id: values?.[0],
              raw_artifact_id: values?.[1],
              parser: values?.[3],
              parser_version: values?.[4],
              extracted: JSON.parse(values?.[5] as string) as Record<string, unknown>,
              confidence: values?.[6],
              extracted_at: new Date(),
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

async function seedBlob(blob: MemoryBlobAdapter, path: string, body: unknown): Promise<void> {
  await blob.put(path, Buffer.from(JSON.stringify(body)), { immutable: true, metadata: {} });
}

function artifactRow(
  tenantId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "raw_A1",
    tenant_id: tenantId,
    source_type: "stripe",
    source_schema: "stripe.balance_transactions.v1",
    source_ref: { stripe_account_id: "acct_s1" },
    source_id: "src_1",
    object_type: "balance_transaction",
    blob_uri: `${tenantId}/blob1`,
    attempt_count: 0,
    ...over,
  };
}

function interpretationLogInsert(calls: Call[], rawArtifactId: string): Call | undefined {
  return calls.find(
    (c) => c.text.includes("INSERT INTO raw_interpretation_log") && c.values[0] === rawArtifactId,
  );
}

describe("runInterpretCycle", () => {
  it("promotes a landed stripe page to raw_parsed and logs the interpretation", async () => {
    const tenantId = newTenantId();
    const blob = new MemoryBlobAdapter();
    await seedBlob(blob, `${tenantId}/blob1`, {
      object: "list",
      data: [{ id: "txn_1", amount: -100, currency: "usd" }],
      has_more: false,
    });
    const { pool, calls } = fakePool([artifactRow(tenantId)]);
    const audit = new InMemoryAuditEmitter();

    await runInterpretCycle({ pool, blob, audit });

    const insert = calls.find((c) => c.text.startsWith("INSERT INTO raw_parsed"));
    expect(insert).toBeDefined();
    expect(insert!.values[3]).toBe("stripe_v1"); // parser
    const log = interpretationLogInsert(calls, "raw_A1");
    expect(log).toBeDefined();
    expect(log!.values[0]).toBe("raw_A1");
    expect(log!.values[4]).toBeNull(); // no error
    expect(audit.events.map((e) => e.action)).toContain("raw.parsed.write");
    // §6.1: the audit body carries a hash of extracted, never the payload.
    expect(audit.events[0]!.inputs.extracted_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("processes a previously stranded upload once source_schema is supplied", async () => {
    const tenantId = newTenantId();
    const blob = new MemoryBlobAdapter();
    const csv = [
      "Customer,Invoice No,Total Due,Current",
      "Northwind Labs,INV-1001,120.50,120.50",
    ].join("\n");
    await blob.put(`${tenantId}/upload.csv`, Buffer.from(csv), {
      immutable: true,
      metadata: {},
    });
    const { pool, calls } = fakePool([
      artifactRow(tenantId, {
        id: "raw_UPLOAD",
        source_type: "csv_upload",
        source_schema: UPLOAD_DOCUMENT_SCHEMA,
        source_ref: { filename: "ar-aging.csv" },
        object_type: null,
        mime_type: "text/csv",
        blob_uri: `${tenantId}/upload.csv`,
      }),
    ]);
    const audit = new InMemoryAuditEmitter();

    await runInterpretCycle({ pool, blob, audit });

    const insert = calls.find((c) => c.text.startsWith("INSERT INTO raw_parsed"));
    expect(insert).toBeDefined();
    expect(insert!.values[3]).toBe(DOCUMENT_RECORDS_UPLOAD_PARSER);
    const extracted = JSON.parse(insert!.values[5] as string) as {
      receivables?: Array<{ invoice_ref?: string; amount?: string }>;
    };
    expect(extracted.receivables).toEqual([
      expect.objectContaining({ invoice_ref: "INV-1001", amount: "120.50" }),
    ]);
    const log = interpretationLogInsert(calls, "raw_UPLOAD");
    expect(log!.values[4]).toBeNull();
    expect(audit.events.map((event) => event.action)).toContain("raw.parsed.write");
  });

  it("logs an empty page without writing a parsed row (and never re-polls it)", async () => {
    const tenantId = newTenantId();
    const blob = new MemoryBlobAdapter();
    await seedBlob(blob, `${tenantId}/blob1`, { object: "list", data: [], has_more: false });
    const { pool, calls } = fakePool([artifactRow(tenantId)]);

    await runInterpretCycle({ pool, blob, audit: new InMemoryAuditEmitter() });

    expect(calls.some((c) => c.text.startsWith("INSERT INTO raw_parsed"))).toBe(false);
    const log = interpretationLogInsert(calls, "raw_A1");
    expect(log!.values[3]).toBeNull(); // parsed_id
    expect(log!.values[4]).toBeNull(); // error
    expect(log!.values[5]).toBe(0); // attempt_count unchanged
    expect(log!.values[6]).toBeNull(); // next_attempt_at: terminal, never re-polled
  });

  it("quarantines a failing artifact in the log without blocking the cycle", async () => {
    const tenantId = newTenantId();
    const blob = new MemoryBlobAdapter();
    await blob.put(`${tenantId}/bad`, Buffer.from("not json"), { immutable: true, metadata: {} });
    await seedBlob(blob, `${tenantId}/good`, {
      object: "list",
      data: [{ id: "txn_2" }],
      has_more: false,
    });
    const { pool, calls } = fakePool([
      artifactRow(tenantId, { id: "raw_BAD", blob_uri: `${tenantId}/bad` }),
      artifactRow(tenantId, { id: "raw_GOOD", blob_uri: `${tenantId}/good` }),
    ]);

    await runInterpretCycle({ pool, blob, audit: new InMemoryAuditEmitter() });

    const bad = interpretationLogInsert(calls, "raw_BAD")!;
    expect(bad.values[4]).toMatch(/not JSON/);
    // The failure did not block the next artifact.
    const good = interpretationLogInsert(calls, "raw_GOOD")!;
    expect(good.values[4]).toBeNull();
    expect(calls.some((c) => c.text.startsWith("INSERT INTO raw_parsed"))).toBe(true);
  });

  it("poll query is retryable-aware, not the old permanent NOT EXISTS exclusion", async () => {
    const blob = new MemoryBlobAdapter();
    const { pool, calls } = fakePool([]);

    await runInterpretCycle({ pool, blob, audit: new InMemoryAuditEmitter() });

    const poll = calls.find((c) => c.text.includes("FROM raw_artifacts ra"))!;
    expect(poll.text).toContain("LEFT JOIN raw_interpretation_log il");
    expect(poll.text).not.toContain("NOT EXISTS");
    expect(poll.text).toContain("il.error IS NOT NULL");
    expect(poll.text).toContain("il.attempt_count < $3");
    expect(poll.text).toContain("il.next_attempt_at IS NULL OR il.next_attempt_at <= now()");
  });

  it("requeues a failing artifact with bounded exponential backoff before the attempt ceiling", async () => {
    const tenantId = newTenantId();
    const blob = new MemoryBlobAdapter();
    await blob.put(`${tenantId}/bad`, Buffer.from("not json"), { immutable: true, metadata: {} });
    // Simulates the second poll pick-up: one prior failed attempt already logged.
    const { pool, calls } = fakePool([
      artifactRow(tenantId, { id: "raw_BAD", blob_uri: `${tenantId}/bad`, attempt_count: 1 }),
    ]);
    const metrics = new MockMetrics();
    const now = new Date("2026-07-06T00:00:00Z");

    await runInterpretCycle(
      { pool, blob, audit: new InMemoryAuditEmitter(), metrics },
      { maxAttempts: 3, retryBaseMs: 1_000, now: () => now },
    );

    const log = interpretationLogInsert(calls, "raw_BAD")!;
    expect(log.values[4]).toMatch(/not JSON/); // error
    expect(log.values[5]).toBe(2); // attempt_count incremented
    // delay = retryBaseMs * 2^(attemptCount-1) = 1000 * 2^1 = 2000ms
    expect(log.values[6]).toEqual(new Date("2026-07-06T00:00:02Z"));
    expect(metrics.calls.some((c) => c.name === "brain.raw.interpretation.retry.count")).toBe(true);
    expect(metrics.calls.some((c) => c.name === "brain.raw.interpretation.stranded.count")).toBe(
      false,
    );
  });

  it("becomes terminal-failed once the attempt ceiling is reached, and stops retrying", async () => {
    const tenantId = newTenantId();
    const blob = new MemoryBlobAdapter();
    await blob.put(`${tenantId}/bad`, Buffer.from("not json"), { immutable: true, metadata: {} });
    // Two prior failed attempts already logged; this third attempt exhausts maxAttempts=3.
    const { pool, calls } = fakePool([
      artifactRow(tenantId, { id: "raw_BAD", blob_uri: `${tenantId}/bad`, attempt_count: 2 }),
    ]);
    const metrics = new MockMetrics();

    await runInterpretCycle(
      { pool, blob, audit: new InMemoryAuditEmitter(), metrics },
      { maxAttempts: 3, retryBaseMs: 1_000 },
    );

    const log = interpretationLogInsert(calls, "raw_BAD")!;
    expect(log.values[5]).toBe(3); // attempt_count at ceiling
    expect(log.values[6]).toBeNull(); // no further retry scheduled
    expect(metrics.calls.some((c) => c.name === "brain.raw.interpretation.stranded.count")).toBe(
      true,
    );
    expect(metrics.calls.some((c) => c.name === "brain.raw.interpretation.retry.count")).toBe(
      false,
    );
  });

  it("a successful interpretation clears a prior error and is never re-polled again", async () => {
    const tenantId = newTenantId();
    const blob = new MemoryBlobAdapter();
    await seedBlob(blob, `${tenantId}/blob1`, {
      object: "list",
      data: [{ id: "txn_1", amount: -100, currency: "usd" }],
      has_more: false,
    });
    // Simulates an artifact that failed once before and is now retried successfully.
    const { pool, calls } = fakePool([artifactRow(tenantId, { attempt_count: 1 })]);

    await runInterpretCycle({ pool, blob, audit: new InMemoryAuditEmitter() });

    const log = interpretationLogInsert(calls, "raw_A1")!;
    expect(log.values[4]).toBeNull(); // error cleared
    expect(log.values[6]).toBeNull(); // next_attempt_at cleared: terminal-success
  });
});
