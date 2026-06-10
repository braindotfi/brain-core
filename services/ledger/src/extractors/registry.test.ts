import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { InMemoryAuditEmitter } from "@brain/shared";
import {
  extractorForParser,
  registeredParsers,
  registerParser,
  type ParserExtractInput,
} from "./registry.js";

const ctx = { tenantId: "tnt_1", actor: "user_1", requestId: "req_1" };

describe("parser registry", () => {
  it("registers both built-in parsers", () => {
    expect(registeredParsers()).toEqual(
      expect.arrayContaining(["plaid_tx_v1", "doc_obligation_v1"]),
    );
    expect(extractorForParser("plaid_tx_v1")).toBeDefined();
    expect(extractorForParser("doc_obligation_v1")).toBeDefined();
  });

  it("returns undefined for an unregistered parser id", () => {
    expect(extractorForParser("mystery_v1")).toBeUndefined();
  });

  it("dispatches a newly registered parser with no worker or service change", async () => {
    const seen: ParserExtractInput[] = [];
    registerParser("test_custom_v1", async (_pool, _audit, _ctx, input) => {
      seen.push(input);
      return [{ entity: "obligation", id: "obl_test" }];
    });

    const extractor = extractorForParser("test_custom_v1")!;
    const out = await extractor({} as unknown as Pool, new InMemoryAuditEmitter(), ctx, {
      rawParsedId: "prs_1",
      rawArtifactId: "raw_1",
      payload: { a: 1 },
      confidence: 0.4,
    });

    expect(out).toEqual([{ entity: "obligation", id: "obl_test" }]);
    expect(seen[0]!.confidence).toBe(0.4);
    expect(registeredParsers()).toContain("test_custom_v1");
  });

  it("refuses duplicate registration of the same parser id", () => {
    expect(() => registerParser("plaid_tx_v1", async () => [])).toThrow(/already registered/);
  });
});
