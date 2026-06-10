import { describe, expect, it } from "vitest";
import {
  StripeAdapter,
  NetSuiteAdapter,
  EmailInboundAdapter,
  AlchemyWalletAdapter,
} from "./stubs.js";

describe("stub adapters", () => {
  for (const [name, adapter] of [
    ["StripeAdapter", StripeAdapter],
    ["NetSuiteAdapter", NetSuiteAdapter],
    ["EmailInboundAdapter", EmailInboundAdapter],
    ["AlchemyWalletAdapter", AlchemyWalletAdapter],
  ] as const) {
    it(`${name}.handleWebhook throws a 501 brain error`, async () => {
      const handler = adapter.handleWebhook!;
      await expect(handler("tenant_1", Buffer.from(""), {})).rejects.toMatchObject({
        statusCode: 501,
      });
    });
  }
});
