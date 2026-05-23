import { describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore, newTenantId } from "@brain/shared";
import { markWebhookSeen, releaseWebhook } from "./webhook.js";

describe("webhook event-id dedup", () => {
  it("is a miss the first time and a replay on an identical re-delivery", async () => {
    const store = new InMemoryIdempotencyStore();
    const tenantId = newTenantId();
    const body = Buffer.from(`{"webhook_code":"DEFAULT_UPDATE","item_id":"itm_1"}`);

    expect(await markWebhookSeen(store, tenantId, "plaid", body, 60)).toBe(false);
    expect(await markWebhookSeen(store, tenantId, "plaid", body, 60)).toBe(true);
  });

  it("treats a different body as a distinct event", async () => {
    const store = new InMemoryIdempotencyStore();
    const tenantId = newTenantId();
    const a = Buffer.from(`{"item_id":"itm_1"}`);
    const b = Buffer.from(`{"item_id":"itm_2"}`);
    expect(await markWebhookSeen(store, tenantId, "plaid", a, 60)).toBe(false);
    expect(await markWebhookSeen(store, tenantId, "plaid", b, 60)).toBe(false);
  });

  it("allows reprocessing after release (failed delivery can retry)", async () => {
    const store = new InMemoryIdempotencyStore();
    const tenantId = newTenantId();
    const body = Buffer.from(`{"item_id":"itm_1"}`);
    expect(await markWebhookSeen(store, tenantId, "plaid", body, 60)).toBe(false);
    await releaseWebhook(store, tenantId, "plaid", body);
    expect(await markWebhookSeen(store, tenantId, "plaid", body, 60)).toBe(false);
  });
});
