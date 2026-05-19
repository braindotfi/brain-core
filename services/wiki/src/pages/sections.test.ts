import { describe, expect, it } from "vitest";
import { bullet, renderPage, revisionFromTouches } from "./sections.js";

describe("renderPage", () => {
  it("emits sections in the canonical order", () => {
    const md = renderPage("Test", {
      currentTruth: "now: ok",
      recentActivity: "tx_1, tx_2",
      timeline: "due 2026-04-30",
      // intentionally drop linkedEntities, openQuestions, riskNotes,
      // evidenceLinks to verify they don't render when empty.
    });
    const ct = md.indexOf("## Current Truth");
    const ra = md.indexOf("## Recent Activity");
    const tl = md.indexOf("## Timeline");
    expect(ct).toBeGreaterThan(0);
    expect(ra).toBeGreaterThan(ct);
    expect(tl).toBeGreaterThan(ra);
    expect(md.includes("## Key Linked Entities")).toBe(false);
  });

  it("starts with the H1 title", () => {
    expect(renderPage("Hello", {}).startsWith("# Hello")).toBe(true);
  });
});

describe("bullet", () => {
  it("renders fallback when empty", () => {
    expect(bullet([])).toBe("_None_");
  });
  it("renders dash bullets", () => {
    expect(bullet(["a", "b"])).toBe("- a\n- b");
  });
});

describe("revisionFromTouches", () => {
  it("is order-independent on input", () => {
    const a = revisionFromTouches([
      { id: "tx_2", updated_at: new Date("2026-04-02T00:00:00Z") },
      { id: "tx_1", updated_at: new Date("2026-04-01T00:00:00Z") },
    ]);
    const b = revisionFromTouches([
      { id: "tx_1", updated_at: new Date("2026-04-01T00:00:00Z") },
      { id: "tx_2", updated_at: new Date("2026-04-02T00:00:00Z") },
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
  it("changes when an updated_at moves", () => {
    const a = revisionFromTouches([{ id: "tx_1", updated_at: new Date("2026-04-01T00:00:00Z") }]);
    const b = revisionFromTouches([{ id: "tx_1", updated_at: new Date("2026-04-02T00:00:00Z") }]);
    expect(a).not.toBe(b);
  });
});
