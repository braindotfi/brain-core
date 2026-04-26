import { describe, expect, it } from "vitest";
import { amountScore, combine, dateScore, nameScore } from "./scoring.js";

describe("amountScore", () => {
  it("returns 1 for identical decimals", () => {
    expect(amountScore("100.00", "100.00")).toBe(1);
    expect(amountScore("100", "100.000")).toBe(1);
  });
  it("scores within 0.1% as ~0.95", () => {
    expect(amountScore("100.00", "100.05")).toBe(0.95);
  });
  it("scores within 1% as 0.6", () => {
    expect(amountScore("100.00", "100.99")).toBe(0.6);
  });
  it("scores within 5% as 0.2", () => {
    expect(amountScore("100.00", "104.00")).toBe(0.2);
  });
  it("returns 0 above 5% delta", () => {
    expect(amountScore("100.00", "150.00")).toBe(0);
  });
  it("returns 0 on malformed input", () => {
    expect(amountScore("nope", "100")).toBe(0);
  });
});

describe("dateScore", () => {
  it("returns 1 for same-day", () => {
    const d = new Date("2026-04-12T10:00:00Z");
    expect(dateScore(d, new Date("2026-04-12T16:00:00Z"))).toBe(1);
  });
  it("returns 0.7 within 3 days", () => {
    expect(
      dateScore(new Date("2026-04-12T00:00:00Z"), new Date("2026-04-14T00:00:00Z")),
    ).toBe(0.7);
  });
  it("returns 0 outside the window", () => {
    expect(
      dateScore(new Date("2026-04-12T00:00:00Z"), new Date("2026-05-01T00:00:00Z")),
    ).toBe(0);
  });
});

describe("nameScore", () => {
  it("returns 1 on normalized equality", () => {
    expect(nameScore("Acme Co.", "ACME CO")).toBe(1);
  });
  it("returns 0.7 on substring", () => {
    expect(nameScore("Acme", "Acme Inc")).toBe(0.7);
  });
  it("returns 0.4 on token overlap (≥50% of smaller set)", () => {
    expect(nameScore("Acme Holdings LLC", "Acme Holdings")).toBeGreaterThanOrEqual(0.4);
  });
  it("returns 0 on no overlap", () => {
    expect(nameScore("Acme", "Globex")).toBe(0);
  });
  it("returns 0 on missing input", () => {
    expect(nameScore(null, "Acme")).toBe(0);
    expect(nameScore("Acme", undefined)).toBe(0);
  });
});

describe("combine", () => {
  it("weighted average; weights normalize", () => {
    const r = combine([
      { score: 1, weight: 1 },
      { score: 0, weight: 1 },
    ]);
    expect(r).toBe(0.5);
  });
  it("zero weights yield zero", () => {
    expect(combine([])).toBe(0);
  });
});
