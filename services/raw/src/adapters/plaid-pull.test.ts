import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaidAdapter } from "./plaid.js";
import type { SyncPartitionState } from "./types.js";

const PARTITION: SyncPartitionState = {
  sourceId: "src_plaid1",
  resourceId: "",
  objectType: "transaction",
  checkpointType: "cursor",
  committedCheckpoint: null,
};

function plaidEnv(): void {
  process.env["PLAID_CLIENT_ID"] = "client_test";
  process.env["PLAID_SECRET"] = "secret_test";
  process.env["PLAID_ENV"] = "sandbox";
}

function mockFetchOnce(payload: Record<string, unknown>, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => Buffer.from(JSON.stringify(payload)),
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("PlaidAdapter.fetchIncremental (pull path)", () => {
  beforeEach(() => {
    plaidEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["PLAID_CLIENT_ID"];
    delete process.env["PLAID_SECRET"];
    delete process.env["PLAID_ENV"];
  });

  it("backfills from the start when no checkpoint is committed", async () => {
    const fetchFn = mockFetchOnce({
      added: [{ transaction_id: "t1" }],
      next_cursor: "cursor_1",
      has_more: true,
      request_id: "req_a",
    });

    const result = await PlaidAdapter.fetchIncremental!({
      tenantId: "tnt_1",
      credentials: { access_token: "access-sandbox-1" },
      partition: PARTITION,
    });

    const [url, init] = fetchFn.mock.calls[0]! as [string, { body: string }];
    expect(url).toBe("https://sandbox.plaid.com/transactions/sync");
    const sent = JSON.parse(init.body) as Record<string, unknown>;
    expect(sent.access_token).toBe("access-sandbox-1");
    expect(sent.cursor).toBeUndefined(); // backfill start

    expect(result.hasMore).toBe(true);
    expect(result.nextCheckpoint).toEqual({ cursor: "cursor_1" });
    const artifact = result.artifacts[0]!;
    expect(artifact.envelope?.sourceSchema).toBe("plaid.transactions_sync.v1");
    expect(artifact.envelope?.idempotencyKey).toBe("src_plaid1:transaction:backfill_start");
    // The body is the verbatim provider response, not re-serialized.
    expect(JSON.parse(artifact.body.toString("utf8")).request_id).toBe("req_a");
  });

  it("pulls only deltas behind the committed cursor, with a retry-stable idempotency key", async () => {
    const fetchFn = mockFetchOnce({
      added: [],
      modified: [],
      next_cursor: "cursor_2",
      has_more: false,
      request_id: "req_b",
    });

    const result = await PlaidAdapter.fetchIncremental!({
      tenantId: "tnt_1",
      credentials: { access_token: "access-sandbox-1" },
      partition: { ...PARTITION, committedCheckpoint: { cursor: "cursor_1" } },
    });

    const [, init] = fetchFn.mock.calls[0]! as [string, { body: string }];
    expect((JSON.parse(init.body) as Record<string, unknown>).cursor).toBe("cursor_1");
    expect(result.hasMore).toBe(false);
    expect(result.nextCheckpoint).toEqual({ cursor: "cursor_2" });
    // Keyed by the cursor BEFORE the page: a retry of an uncommitted
    // checkpoint dedups even though Plaid's request_id churns the bytes.
    expect(result.artifacts[0]!.envelope?.idempotencyKey).toBe("src_plaid1:transaction:cursor_1");
  });

  it("takes a balance snapshot for the balance partition", async () => {
    mockFetchOnce({ accounts: [{ account_id: "a1" }], request_id: "req_c" });

    const result = await PlaidAdapter.fetchIncremental!({
      tenantId: "tnt_1",
      credentials: { access_token: "access-sandbox-1" },
      partition: { ...PARTITION, objectType: "balance", checkpointType: "snapshot" },
    });

    expect(result.hasMore).toBe(false);
    expect(result.artifacts[0]!.envelope?.sourceSchema).toBe("plaid.balance.v1");
    expect(result.artifacts[0]!.envelope?.operation).toBe("snapshot");
  });

  it("fails closed when the pull path is unconfigured", async () => {
    delete process.env["PLAID_CLIENT_ID"];
    await expect(
      PlaidAdapter.fetchIncremental!({
        tenantId: "tnt_1",
        credentials: { access_token: "tok" },
        partition: PARTITION,
      }),
    ).rejects.toMatchObject({ code: "raw_source_unsupported" });
  });

  it("rejects a connection without an access_token", async () => {
    await expect(
      PlaidAdapter.fetchIncremental!({
        tenantId: "tnt_1",
        credentials: {},
        partition: PARTITION,
      }),
    ).rejects.toMatchObject({ code: "source_credential_invalid" });
  });

  it("surfaces provider errors as 502 without minting artifacts", async () => {
    mockFetchOnce({ error_code: "RATE_LIMIT" }, 429);
    await expect(
      PlaidAdapter.fetchIncremental!({
        tenantId: "tnt_1",
        credentials: { access_token: "tok" },
        partition: PARTITION,
      }),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});
