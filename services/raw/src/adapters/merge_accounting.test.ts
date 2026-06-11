import { afterEach, describe, expect, it, vi } from "vitest";
import { MergeAccountingAdapter } from "./merge_accounting.js";
import { adapterForGenericIngest, descriptorForSourceType } from "./registry.js";
import type { SyncPartitionState } from "./types.js";

const PARTITION: SyncPartitionState = {
  sourceId: "src_merge1",
  resourceId: "",
  objectType: "invoice",
  checkpointType: "watermark",
  committedCheckpoint: null,
};

const CREDS = { api_key: "merge_platform_key", account_token: "acct_token_1" };

type FetchCall = { url: string; headers: Record<string, string> };

function mockMerge(routes: Record<string, () => Record<string, unknown>>): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      const path = new URL(url).pathname.replace("/api/accounting/v1", "");
      const handler = routes[path];
      if (handler === undefined) {
        return { ok: false, status: 404, arrayBuffer: async () => Buffer.from("{}") };
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from(JSON.stringify(handler())),
      };
    }),
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("merge_accounting connector", () => {
  it("is reserved on the generic route (aggregator data is provider-authenticated)", () => {
    expect(() => adapterForGenericIngest("merge_accounting")).toThrow();
  });

  it("is described by a ConnectorDescriptor with a registered parser", () => {
    const d = descriptorForSourceType("merge_accounting");
    expect(d.parserVersions).toContain("merge_accounting_v1");
    expect(d.origin).toBe("aggregator");
  });

  it("backfills: captures the underlying integration, pages via next, holds the watermark", async () => {
    const { calls } = mockMerge({
      "/account-details": () => ({ integration: "NetSuite" }),
      "/invoices": () => ({
        next: "cursor_2",
        results: [
          { id: "inv_1", modified_at: "2026-06-01T00:00:00Z" },
          { id: "inv_2", modified_at: "2026-06-02T00:00:00Z" },
        ],
      }),
    });

    const result = await MergeAccountingAdapter.fetchIncremental!({
      tenantId: "tnt_1",
      credentials: CREDS,
      partition: PARTITION,
    });

    // Two-part Merge auth on every call.
    const invoiceCall = calls.find((c) => c.url.includes("/invoices"))!;
    expect(invoiceCall.headers.authorization).toBe("Bearer merge_platform_key");
    expect(invoiceCall.headers["x-account-token"]).toBe("acct_token_1");
    expect(invoiceCall.url).not.toContain("modified_after"); // backfill

    expect(result.hasMore).toBe(true);
    expect(result.nextCheckpoint).toEqual({
      merge_integration: "NetSuite",
      watermark_modified: null, // not promoted until the walk completes
      page_cursor: "cursor_2",
      pending_watermark: "2026-06-02T00:00:00Z",
    });

    const artifact = result.artifacts[0]!;
    expect(artifact.envelope?.sourceSchema).toBe("merge_accounting.invoices.v1");
    // Original source stays visible through the aggregator.
    expect(artifact.envelope?.originalSource).toBe("netsuite");
    expect(artifact.envelope?.intermediaries).toEqual(["merge"]);
    expect(artifact.sourceRef.merge_integration).toBe("NetSuite");
    expect(artifact.envelope?.idempotencyKey).toBe("src_merge1:invoice:backfill:start");
  });

  it("completes the walk: promotes the watermark and pulls only deltas after", async () => {
    const { calls } = mockMerge({
      "/contacts": () => ({
        next: null,
        results: [{ id: "con_1", modified_at: "2026-06-03T00:00:00Z" }],
      }),
    });

    const result = await MergeAccountingAdapter.fetchIncremental!({
      tenantId: "tnt_1",
      credentials: CREDS,
      partition: {
        ...PARTITION,
        objectType: "contact",
        committedCheckpoint: {
          merge_integration: "QuickBooks",
          watermark_modified: "2026-06-01T00:00:00Z",
          page_cursor: null,
          pending_watermark: null,
        },
      },
    });

    const url = decodeURIComponent(calls.find((c) => c.url.includes("/contacts"))!.url);
    expect(url).toContain("modified_after=2026-06-01T00:00:00Z");
    expect(result.hasMore).toBe(false);
    expect(result.nextCheckpoint).toEqual({
      merge_integration: "QuickBooks", // no /account-details re-fetch
      watermark_modified: "2026-06-03T00:00:00Z",
      page_cursor: null,
      pending_watermark: null,
    });
    expect(calls.some((c) => c.url.includes("account-details"))).toBe(false);
  });

  it("returns no artifact for an empty delta page but keeps the watermark", async () => {
    mockMerge({ "/payments": () => ({ next: null, results: [] }) });
    const result = await MergeAccountingAdapter.fetchIncremental!({
      tenantId: "tnt_1",
      credentials: CREDS,
      partition: {
        ...PARTITION,
        objectType: "payment",
        committedCheckpoint: {
          merge_integration: "Xero",
          watermark_modified: "2026-06-01T00:00:00Z",
          page_cursor: null,
          pending_watermark: null,
        },
      },
    });
    expect(result.artifacts).toHaveLength(0);
    expect(result.nextCheckpoint).toMatchObject({ watermark_modified: "2026-06-01T00:00:00Z" });
  });

  it("declares all six per-object-type partitions", () => {
    expect(MergeAccountingAdapter.syncObjectTypes!.map((s) => s.objectType).sort()).toEqual([
      "contact",
      "gl_account",
      "invoice",
      "journal_entry",
      "payment",
      "tax_rate",
    ]);
  });

  it("rejects connections missing either credential half", async () => {
    await expect(
      MergeAccountingAdapter.fetchIncremental!({
        tenantId: "tnt_1",
        credentials: { api_key: "k" },
        partition: PARTITION,
      }),
    ).rejects.toMatchObject({ code: "source_credential_invalid" });
    await expect(
      MergeAccountingAdapter.fetchIncremental!({
        tenantId: "tnt_1",
        credentials: { account_token: "t" },
        partition: PARTITION,
      }),
    ).rejects.toMatchObject({ code: "source_credential_invalid" });
  });

  it("surfaces provider errors as 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, arrayBuffer: async () => Buffer.from("{}") })),
    );
    await expect(
      MergeAccountingAdapter.fetchIncremental!({
        tenantId: "tnt_1",
        credentials: CREDS,
        partition: { ...PARTITION, committedCheckpoint: { merge_integration: "Sage" } },
      }),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});
