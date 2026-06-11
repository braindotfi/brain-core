import { afterEach, describe, expect, it, vi } from "vitest";
import { FinchAdapter } from "./finch.js";
import { adapterForGenericIngest, descriptorForSourceType } from "./registry.js";
import type { SyncPartitionState } from "./types.js";

const PARTITION: SyncPartitionState = {
  sourceId: "src_finch1",
  resourceId: "",
  objectType: "pay_run",
  checkpointType: "watermark",
  committedCheckpoint: null,
};

const CREDS = { access_token: "finch_access_1" };
const TODAY = new Date().toISOString().slice(0, 10);

type FetchCall = { url: string; headers: Record<string, string>; body?: string };

function mockFinch(
  routes: Record<string, (call: FetchCall) => Record<string, unknown> | unknown[]>,
): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { headers: Record<string, string>; body?: string }) => {
      const call: FetchCall = {
        url,
        headers: init.headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
      };
      calls.push(call);
      const path = new URL(url).pathname;
      const handler = routes[path];
      if (handler === undefined) {
        return { ok: false, status: 404, arrayBuffer: async () => Buffer.from("{}") };
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from(JSON.stringify(handler(call))),
      };
    }),
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("finch connector", () => {
  it("is reserved on the generic route (sensitive scoped data)", () => {
    expect(() => adapterForGenericIngest("finch")).toThrow();
  });

  it("is described with the spec parser id and payroll catalog grouping", () => {
    const d = descriptorForSourceType("finch");
    expect(d.parserVersions).toContain("finch_payroll_v1");
    expect(d.category).toBe("payroll_hr");
  });

  it("pulls a pay-run window AND its pay statements together, watermarking by day", async () => {
    const { calls } = mockFinch({
      "/employer/payment": () => [
        { id: "pay_1", pay_date: "2026-06-05" },
        { id: "pay_2", pay_date: "2026-06-12" },
      ],
      "/employer/pay-statement": () => ({
        responses: [{ payment_id: "pay_1" }, { payment_id: "pay_2" }],
      }),
    });

    const result = await FinchAdapter.fetchIncremental!({
      tenantId: "tnt_1",
      credentials: CREDS,
      partition: PARTITION,
    });

    const paymentCall = calls.find((c) => c.url.includes("/employer/payment?"))!;
    expect(paymentCall.headers.authorization).toBe("Bearer finch_access_1");
    expect(paymentCall.headers["finch-api-version"]).toBe("2020-09-17");
    expect(paymentCall.url).toContain("start_date=2024-01-01"); // backfill horizon

    const stmtCall = calls.find((c) => c.url.includes("/employer/pay-statement"))!;
    expect(JSON.parse(stmtCall.body!)).toEqual({
      requests: [{ payment_id: "pay_1" }, { payment_id: "pay_2" }],
    });

    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts[0]!.envelope?.sourceSchema).toBe("finch.payments.v1");
    expect(result.artifacts[1]!.envelope?.sourceSchema).toBe("finch.pay_statements.v1");
    expect(result.nextCheckpoint).toMatchObject({ watermark_day: TODAY });
    expect(result.hasMore).toBe(false);
  });

  it("re-pulls from the watermark day inclusive and skips same-day re-runs", async () => {
    const { calls } = mockFinch({ "/employer/payment": () => [] });
    const first = await FinchAdapter.fetchIncremental!({
      tenantId: "tnt_1",
      credentials: CREDS,
      partition: {
        ...PARTITION,
        committedCheckpoint: {
          snapshot_day: null,
          directory_offset: null,
          watermark_day: "2026-06-10",
        },
      },
    });
    expect(decodeURIComponent(calls[0]!.url)).toContain("start_date=2026-06-10");
    expect(first.artifacts).toHaveLength(0); // empty window, checkpoint still advances
    expect(first.nextCheckpoint).toMatchObject({ watermark_day: TODAY });

    const second = await FinchAdapter.fetchIncremental!({
      tenantId: "tnt_1",
      credentials: CREDS,
      partition: { ...PARTITION, committedCheckpoint: first.nextCheckpoint },
    });
    expect(second.artifacts).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes("/employer/payment"))).toHaveLength(1); // day gate
  });

  it("walks the directory snapshot in offset pages", async () => {
    mockFinch({
      "/employer/directory": (call) => {
        const offset = Number(new URL(call.url).searchParams.get("offset"));
        return offset === 0
          ? { individuals: new Array(250).fill({ id: "ind" }), paging: { count: 300, offset: 0 } }
          : { individuals: new Array(50).fill({ id: "ind" }), paging: { count: 300, offset: 250 } };
      },
    });

    const page1 = await FinchAdapter.fetchIncremental!({
      tenantId: "tnt_1",
      credentials: CREDS,
      partition: { ...PARTITION, objectType: "individual", checkpointType: "snapshot" },
    });
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCheckpoint).toMatchObject({ directory_offset: 250 });

    const page2 = await FinchAdapter.fetchIncremental!({
      tenantId: "tnt_1",
      credentials: CREDS,
      partition: {
        ...PARTITION,
        objectType: "individual",
        checkpointType: "snapshot",
        committedCheckpoint: page1.nextCheckpoint,
      },
    });
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCheckpoint).toMatchObject({ directory_offset: null, snapshot_day: TODAY });
  });

  it("NEVER calls the SSN-bearing /employer/individual endpoint", async () => {
    const { calls } = mockFinch({
      "/employer/company": () => ({ id: "co_1", legal_name: "Acme" }),
      "/employer/directory": () => ({ individuals: [], paging: { count: 0, offset: 0 } }),
      "/employer/payment": () => [],
    });
    for (const objectType of ["company", "individual", "pay_run"]) {
      await FinchAdapter.fetchIncremental!({
        tenantId: "tnt_1",
        credentials: CREDS,
        partition: { ...PARTITION, objectType },
      });
    }
    expect(calls.some((c) => c.url.includes("/employer/individual"))).toBe(false);
  });

  it("rejects a connection without an access_token", async () => {
    await expect(
      FinchAdapter.fetchIncremental!({ tenantId: "tnt_1", credentials: {}, partition: PARTITION }),
    ).rejects.toMatchObject({ code: "source_credential_invalid" });
  });

  it("surfaces provider errors as 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, arrayBuffer: async () => Buffer.from("{}") })),
    );
    await expect(
      FinchAdapter.fetchIncremental!({
        tenantId: "tnt_1",
        credentials: CREDS,
        partition: PARTITION,
      }),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});
