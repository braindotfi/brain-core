import { describe, expect, it } from "vitest";
import { canonicalize, contentHashHex } from "./dsl.js";

describe("canonicalize", () => {
  it("is key-order independent", () => {
    const a = canonicalize({
      version: 1,
      rules: [
        {
          id: "r",
          applies_to: ["any"],
          when: { "amount.lte": { currency: "USD", value: "10" } },
          execute: "auto",
        },
      ],
    });
    const b = canonicalize({
      rules: [
        {
          execute: "auto",
          applies_to: ["any"],
          id: "r",
          when: { "amount.lte": { value: "10", currency: "USD" } },
        },
      ],
      version: 1,
    });
    expect(a).toBe(b);
  });
});

describe("contentHashHex", () => {
  it("is a stable 64-char hex digest", () => {
    const hex = contentHashHex({ version: 1, rules: [] });
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex).toBe(contentHashHex({ version: 1, rules: [] }));
  });
  it("changes when the document changes", () => {
    const a = contentHashHex({ version: 1, rules: [] });
    const b = contentHashHex({ version: 2, rules: [] });
    expect(a).not.toBe(b);
  });
});
