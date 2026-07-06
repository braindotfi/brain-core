import { afterEach, describe, expect, it, vi } from "vitest";
import { emitDomainEvent } from "./triggers.js";

describe("emitDomainEvent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("contains enqueue errors and logs structured context", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const enqueue = vi.fn(async () => {
      throw new Error("queue unavailable");
    });

    await expect(
      emitDomainEvent(enqueue, {
        tenantId: "tnt_00000000010000000000000000",
        requestId: "req_event",
        event: "vendor.created",
        context: { counterparty_id: "cp_1" },
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({
      level: "warn",
      message: "domain_event_enqueue_failed",
      tenant_id: "tnt_00000000010000000000000000",
      request_id: "req_event",
      event: "vendor.created",
      error: "queue unavailable",
    });
  });
});
