import { describe, expect, it } from "vitest";
import { renderDocsHtml } from "./view.js";

describe("renderDocsHtml", () => {
  it("points the renderer at the same-origin spec and bundle", () => {
    const html = renderDocsHtml();
    expect(html).toContain('<script id="api-reference" data-url="/v1/openapi.yaml">');
    expect(html).toContain('<script src="/v1/docs/scalar.js">');
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });

  it("has no inline executable script (CSP: script-src 'self')", () => {
    const html = renderDocsHtml();
    // The only <script> tags are the data-only auto-init element and the
    // same-origin bundle src. No inline init like Scalar.createApiReference(...).
    expect(html).not.toContain("createApiReference");
    // Every <script> tag either carries a src= or is the empty data-url tag.
    const scripts = html.match(/<script[^>]*>/g) ?? [];
    for (const tag of scripts) {
      expect(tag.includes("src=") || tag.includes('id="api-reference"')).toBe(true);
    }
  });

  it("honours basePath and escapes the title", () => {
    const html = renderDocsHtml({ basePath: "/v2", title: 'A & B <x>"' });
    expect(html).toContain('data-url="/v2/openapi.yaml"');
    expect(html).toContain('src="/v2/docs/scalar.js"');
    expect(html).toContain("A &amp; B &lt;x&gt;&quot;");
    expect(html).not.toContain("<x>");
  });
});
