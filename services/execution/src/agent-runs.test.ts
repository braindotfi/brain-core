import { describe, expect, it } from "vitest";
import {
  amountBucket,
  buildEventIdempotencyKey,
  buildProposalDedupKey,
  dayBucket,
  isUniqueViolation,
} from "./agent-runs.js";

describe("dayBucket", () => {
  it("is the UTC date (YYYY-MM-DD)", () => {
    expect(dayBucket(new Date("2026-05-23T23:59:59Z"))).toBe("2026-05-23");
    expect(dayBucket(new Date("2026-05-24T00:00:01Z"))).toBe("2026-05-24");
  });
});

describe("buildEventIdempotencyKey", () => {
  const base = {
    tenantId: "tnt_acme",
    eventType: "invoice.overdue",
    objectType: "invoice",
    objectId: "inv_1",
    agentId: "collections",
    action: "draft_followup",
    day: "2026-05-23",
  };

  it("joins the canonical key parts", () => {
    expect(buildEventIdempotencyKey(base)).toBe(
      "tnt_acme:invoice.overdue:invoice:inv_1:collections:draft_followup:2026-05-23",
    );
  });

  it("buckets by day so a later re-fire is a new key", () => {
    const today = buildEventIdempotencyKey(base);
    const tomorrow = buildEventIdempotencyKey({ ...base, day: "2026-05-24" });
    expect(today).not.toBe(tomorrow);
  });
});

describe("amountBucket", () => {
  it("rounds to the nearest whole unit so near-duplicates collide", () => {
    expect(amountBucket("100.40")).toBe("100");
    expect(amountBucket("100.50")).toBe("101");
    expect(amountBucket("not-a-number")).toBe("not-a-number");
  });
});

describe("buildProposalDedupKey", () => {
  it("prefers obligation, then invoice, then counterparty+amount+day", () => {
    expect(
      buildProposalDedupKey({ tenantId: "tnt_a", agentId: "payment", obligationId: "obl_1" }),
    ).toBe("tnt_a:payment:obl:obl_1");
    expect(
      buildProposalDedupKey({ tenantId: "tnt_a", agentId: "payment", invoiceId: "inv_1" }),
    ).toBe("tnt_a:payment:inv:inv_1");
    expect(
      buildProposalDedupKey({
        tenantId: "tnt_a",
        agentId: "payment",
        counterpartyId: "cp_1",
        amount: "500.20",
        currency: "USD",
        day: "2026-05-23",
      }),
    ).toBe("tnt_a:payment:cpa:cp_1:USD:500:2026-05-23");
  });

  it("returns null when there is no stable discriminator", () => {
    expect(buildProposalDedupKey({ tenantId: "tnt_a", agentId: "payment" })).toBeNull();
  });
});

describe("isUniqueViolation", () => {
  it("matches Postgres SQLSTATE 23505", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
