import { describe, expect, it } from "vitest";
import { classifyAccount } from "./classify.js";

describe("classifyAccount", () => {
  it("maps the standard chart-of-accounts vocabularies", () => {
    expect(classifyAccount("ASSET")).toBe("asset");
    expect(classifyAccount("Liability")).toBe("liability");
    expect(classifyAccount("equity")).toBe("equity");
    expect(classifyAccount("EXPENSE")).toBe("expense");
  });

  it("normalizes INCOME and REVENUE to the same canonical class", () => {
    expect(classifyAccount("INCOME")).toBe("revenue");
    expect(classifyAccount("revenue")).toBe("revenue");
  });

  it("tolerates plural and whitespace-padded provider strings", () => {
    expect(classifyAccount("  Assets ")).toBe("asset");
    expect(classifyAccount("Liabilities")).toBe("liability");
  });

  it("resolves the unknown/missing cases to 'unknown' rather than guessing", () => {
    expect(classifyAccount(null)).toBe("unknown");
    expect(classifyAccount(undefined)).toBe("unknown");
    expect(classifyAccount("")).toBe("unknown");
    expect(classifyAccount("CONTRA_SOMETHING")).toBe("unknown");
  });
});
