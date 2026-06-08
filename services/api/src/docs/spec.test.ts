import { describe, expect, it } from "vitest";
import { loadOpenApiSpecText, loadScalarBundle } from "./spec.js";

describe("loadOpenApiSpecText", () => {
  it("loads the OpenAPI 3.1 contract as YAML text", () => {
    const text = loadOpenApiSpecText();
    expect(text.startsWith("openapi: 3.1")).toBe(true);
    expect(text).toContain("Brain API");
  });

  it("caches the result (same reference on second call)", () => {
    expect(loadOpenApiSpecText()).toBe(loadOpenApiSpecText());
  });
});

describe("loadScalarBundle", () => {
  it("loads the same-origin Scalar standalone renderer bundle", () => {
    const bundle = loadScalarBundle();
    // The single-file standalone is multi-MB and contains the auto-init logic.
    expect(bundle.length).toBeGreaterThan(100_000);
    expect(bundle).toContain("api-reference");
  });
});
