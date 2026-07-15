import { afterEach, describe, expect, it, vi } from "vitest";
import { StripeAdapter } from "./stripe.js";
import type { SyncPartitionState } from "./types.js";

const PARTITION: SyncPartitionState = {
  sourceId: "src_stripe1",
  resourceId: "",
  objectType: "balance_transaction",
  checkpointType: "cursor",
  committedCheckpoint: null,
};

const CREDS = { api_key: "sk_test_abc" };

type FetchCall = { url: string; headers: Record<string, string> };

/** Routes fetch by URL path; records calls. */
function mockStripe(routes: Record<string, () => Record<string, unknown>>): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      const path = new URL(url).pathname;
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

describe("StripeAdapter.fetchIncremental (cursor pull)", () => {
  it("backfills page 1: captures the account id, pages via starting_after, holds the watermark", async () => {
    const { calls } = mockStripe({
      "/v1/account": () => ({ id: "acct_S1" }),
      "/v1/balance_transactions": () => ({
        object: "list",
        data: [
          { id: "txn_3", created: 300 },
          { id: "txn_2", created: 200 },
        ],
        has_more: true,
      }),
    });

    const result = await StripeAdapter.fetchIncremental!({
      tenantId: "tnt_1",
      credentials: CREDS,
      partition: PARTITION,
    });

    // Bearer auth with the connection's key.
    expect(calls[0]!.headers.authorization).toBe("Bearer sk_test_abc");
    // No created filter on backfill.
    expect(calls.find((c) => c.url.includes("balance_transactions"))!.url).not.toContain("created");

    expect(result.hasMore).toBe(true);
    expect(result.nextCheckpoint).toEqual({
      stripe_account_id: "acct_S1",
      watermark_created: null, // not promoted until the walk completes
      page_after: "txn_2",
      pending_watermark: 300,
    });
    const artifact = result.artifacts[0]!;
    expect(artifact.envelope?.sourceSchema).toBe("stripe.balance_transactions.v1");
    expect(artifact.envelope?.idempotencyKey).toBe(
      "src_stripe1:balance_transaction:backfill:start",
    );
    expect(artifact.sourceRef.stripe_account_id).toBe("acct_S1");
  });

  it("completes the walk: promotes the pending watermark and clears the page cursor", async () => {
    mockStripe({
      "/v1/balance_transactions": () => ({
        object: "list",
        data: [{ id: "txn_1", created: 100 }],
        has_more: false,
      }),
    });

    const result = await StripeAdapter.fetchIncremental!({
      tenantId: "tnt_1",
      credentials: CREDS,
      partition: {
        ...PARTITION,
        committedCheckpoint: {
          stripe_account_id: "acct_S1",
          watermark_created: null,
          page_after: "txn_2",
          pending_watermark: 300,
        },
      },
    });

    expect(result.hasMore).toBe(false);
    expect(result.nextCheckpoint).toEqual({
      stripe_account_id: "acct_S1",
      watermark_created: 300, // max(pending, page max)
      page_after: null,
      pending_watermark: null,
    });
    // Mid-walk page key is stable for retries of this exact position.
    expect(result.artifacts[0]!.envelope?.idempotencyKey).toBe(
      "src_stripe1:balance_transaction:backfill:txn_2",
    );
    // No /v1/account re-fetch once the checkpoint carries the id.
  });

  it("pulls deltas inclusively at the committed watermark", async () => {
    const { calls } = mockStripe({
      "/v1/charges": () => ({
        object: "list",
        data: [{ id: "ch_9", created: 900 }],
        has_more: false,
      }),
    });

    const result = await StripeAdapter.fetchIncremental!({
      tenantId: "tnt_1",
      credentials: CREDS,
      partition: {
        ...PARTITION,
        objectType: "charge",
        committedCheckpoint: {
          stripe_account_id: "acct_S1",
          watermark_created: 300,
          page_after: null,
          pending_watermark: null,
        },
      },
    });

    const url = calls.find((c) => c.url.includes("charges"))!.url;
    expect(decodeURIComponent(url)).toContain("created[gte]=300");
    expect(result.nextCheckpoint).toMatchObject({ watermark_created: 900 });
    expect(result.artifacts[0]!.envelope?.sourceSchema).toBe("stripe.charges.v1");
  });

  it("re-pulls the watermark second so late same-second objects are not skipped", async () => {
    const { calls } = mockStripe({
      "/v1/charges": () => ({
        object: "list",
        data: [
          { id: "ch_late", created: 900 },
          { id: "ch_prior", created: 900 },
        ],
        has_more: false,
      }),
    });

    const result = await StripeAdapter.fetchIncremental!({
      tenantId: "tnt_1",
      credentials: CREDS,
      partition: {
        ...PARTITION,
        objectType: "charge",
        committedCheckpoint: {
          stripe_account_id: "acct_S1",
          watermark_created: 900,
          page_after: null,
          pending_watermark: null,
        },
      },
    });

    const url = calls.find((c) => c.url.includes("charges"))!.url;
    expect(decodeURIComponent(url)).toContain("created[gte]=900");
    expect(result.nextCheckpoint).toMatchObject({ watermark_created: 900 });
    expect(result.artifacts[0]!.envelope?.idempotencyKey).toBe("src_stripe1:charge:900:start");
  });

  it("returns no artifact for an empty delta page but still finalizes the checkpoint", async () => {
    mockStripe({
      "/v1/payouts": () => ({ object: "list", data: [], has_more: false }),
    });

    const result = await StripeAdapter.fetchIncremental!({
      tenantId: "tnt_1",
      credentials: CREDS,
      partition: {
        ...PARTITION,
        objectType: "payout",
        committedCheckpoint: {
          stripe_account_id: "acct_S1",
          watermark_created: 300,
          page_after: null,
          pending_watermark: null,
        },
      },
    });

    expect(result.artifacts).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.nextCheckpoint).toMatchObject({ watermark_created: 300 });
  });

  it("declares all six per-object-type partitions", () => {
    expect(StripeAdapter.syncObjectTypes!.map((s) => s.objectType).sort()).toEqual([
      "balance_transaction",
      "charge",
      "customer",
      "dispute",
      "payout",
      "refund",
    ]);
  });

  it("rejects a connection without an api_key", async () => {
    await expect(
      StripeAdapter.fetchIncremental!({
        tenantId: "tnt_1",
        credentials: {},
        partition: PARTITION,
      }),
    ).rejects.toMatchObject({ code: "source_credential_invalid" });
  });

  it("surfaces provider errors as 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 429,
        arrayBuffer: async () => Buffer.from("{}"),
      })),
    );
    await expect(
      StripeAdapter.fetchIncremental!({
        tenantId: "tnt_1",
        credentials: CREDS,
        partition: { ...PARTITION, committedCheckpoint: { stripe_account_id: "acct_S1" } },
      }),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("wraps a (route-verified) webhook event as an evidence artifact keyed by event id", async () => {
    const event = {
      id: "evt_99",
      type: "charge.succeeded",
      account: "acct_S1",
      created: 1770000000,
    };
    const artifacts = await StripeAdapter.handleWebhook!(
      "tnt_1",
      Buffer.from(JSON.stringify(event)),
      {},
    );
    expect(artifacts).toHaveLength(1);
    const a = artifacts[0]!;
    expect(a.sourceRef).toMatchObject({ event_id: "evt_99", stripe_account_id: "acct_S1" });
    expect(a.envelope?.sourceSchema).toBe("stripe.webhook_event.v1");
    // Stripe re-delivers events verbatim; the event id is the dedup key.
    expect(a.envelope?.idempotencyKey).toBe("stripe:event:evt_99");
  });

  it("rejects a non-JSON webhook body", async () => {
    await expect(
      StripeAdapter.handleWebhook!("tnt_1", Buffer.from("not json"), {}),
    ).rejects.toMatchObject({ code: "request_body_invalid" });
  });
});
