import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, MemoryBlobAdapter, newTenantId } from "@brain/shared";
import { runInterpretCycle } from "./interpretWorker.js";

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
    ...over,
  };
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
    const log = calls.find((c) => c.text.includes("INSERT INTO raw_interpretation_log"));
    expect(log).toBeDefined();
    expect(log!.values[0]).toBe("raw_A1");
    expect(log!.values[4]).toBeNull(); // no error
    expect(audit.events.map((e) => e.action)).toContain("raw.parsed.write");
    // §6.1: the audit body carries a hash of extracted, never the payload.
    expect(audit.events[0]!.inputs.extracted_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("logs an empty page without writing a parsed row (and never re-polls it)", async () => {
    const tenantId = newTenantId();
    const blob = new MemoryBlobAdapter();
    await seedBlob(blob, `${tenantId}/blob1`, { object: "list", data: [], has_more: false });
    const { pool, calls } = fakePool([artifactRow(tenantId)]);

    await runInterpretCycle({ pool, blob, audit: new InMemoryAuditEmitter() });

    expect(calls.some((c) => c.text.startsWith("INSERT INTO raw_parsed"))).toBe(false);
    const log = calls.find((c) => c.text.includes("INSERT INTO raw_interpretation_log"));
    expect(log!.values[3]).toBeNull(); // parsed_id
    expect(log!.values[4]).toBeNull(); // error
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

    const logs = calls.filter((c) => c.text.includes("INSERT INTO raw_interpretation_log"));
    const bad = logs.find((c) => c.values[0] === "raw_BAD")!;
    expect(bad.values[4]).toMatch(/not JSON/);
    // The failure did not block the next artifact.
    const good = logs.find((c) => c.values[0] === "raw_GOOD")!;
    expect(good.values[4]).toBeNull();
    expect(calls.some((c) => c.text.startsWith("INSERT INTO raw_parsed"))).toBe(true);
  });
});
