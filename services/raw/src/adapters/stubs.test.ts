import { describe, expect, it } from "vitest";
import { StripeAdapter, NetSuiteAdapter, GmailAdapter, EvmAdapter } from "./stubs.js";

describe("stub adapters", () => {
  for (const [name, adapter] of [
    ["StripeAdapter", StripeAdapter],
    ["NetSuiteAdapter", NetSuiteAdapter],
    ["GmailAdapter", GmailAdapter],
    ["EvmAdapter", EvmAdapter],
  ] as const) {
    it(`${name}.handleWebhook throws a 501 brain error`, async () => {
      const handler = adapter.handleWebhook!;
      await expect(handler({} as never)).rejects.toMatchObject({
        statusCode: 501,
      });
    });
  }
});
