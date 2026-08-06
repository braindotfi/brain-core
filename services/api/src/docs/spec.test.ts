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

  it("still honours the data-url auto-init contract view.ts renders", () => {
    // view.ts emits `<script id="api-reference" data-url="...">` and NOTHING
    // else: no inline executable script, so the docs CSP stays script-src
    // 'self'. That only works while the bundle keeps auto-initialising from
    // that attribute. Scalar has already deprecated one spelling of this
    // (data-spec-url), so pin the one we actually depend on -- a silent switch
    // would render an empty docs page that no other test would catch.
    expect(loadScalarBundle()).toContain("data-url");
  });
});
