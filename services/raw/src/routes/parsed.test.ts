import { describe, expect, it } from "vitest";
import { isBrainError } from "@brain/shared";
import { parseRawParsedWriteBody } from "./parsed.js";

// Pure-function coverage for the POST /raw/{id}/parsed body validator.
// The full write path (live DB, RLS, audit) is exercised in
// raw.integration.test.ts.

describe("parseRawParsedWriteBody", () => {
  const valid = {
    parser: "doc_obligation_v1",
    parser_version: "1.0.0",
    extracted: { direction: "payable", amount: "100.00" },
    confidence: 0.4,
  };

  it("accepts a well-formed body and normalizes it", () => {
    expect(parseRawParsedWriteBody(valid)).toEqual({
      parser: "doc_obligation_v1",
      parser_version: "1.0.0",
      extracted: { direction: "payable", amount: "100.00" },
      confidence: 0.4,
    });
  });

  it("defaults confidence to null when omitted", () => {
    const { confidence, ...rest } = valid;
    void confidence;
    expect(parseRawParsedWriteBody(rest).confidence).toBeNull();
  });

  it("treats explicit null confidence as null", () => {
    expect(parseRawParsedWriteBody({ ...valid, confidence: null }).confidence).toBeNull();
  });

  it.each([
    ["non-object body", 42],
    ["null body", null],
    ["missing parser", { ...valid, parser: undefined }],
    ["empty parser", { ...valid, parser: "" }],
    ["missing parser_version", { ...valid, parser_version: undefined }],
    ["missing extracted", { ...valid, extracted: undefined }],
    ["array extracted", { ...valid, extracted: [1, 2] }],
    ["null extracted", { ...valid, extracted: null }],
    ["confidence above 1", { ...valid, confidence: 1.5 }],
    ["confidence below 0", { ...valid, confidence: -0.1 }],
    ["confidence not a number", { ...valid, confidence: "high" }],
  ])("rejects %s with request_body_invalid", (_label, input) => {
    try {
      parseRawParsedWriteBody(input);
      throw new Error("expected parseRawParsedWriteBody to throw");
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
      if (isBrainError(err)) {
        expect(err.code).toBe("request_body_invalid");
        expect(err.statusCode).toBe(400);
      }
    }
  });
});
