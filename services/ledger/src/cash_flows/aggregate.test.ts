import { describe, expect, it } from "vitest";
import { aggregateCashFlow, type CashFlowTransaction } from "./aggregate.js";

function tx(
  date: string,
  amount: string,
  direction: CashFlowTransaction["direction"],
  currency = "USD",
): CashFlowTransaction {
  return { transaction_date: date, amount, direction, currency };
}

describe("aggregateCashFlow", () => {
  it("returns an empty currencies array on no transactions", () => {
    const summary = aggregateCashFlow({
      tenantId: "tnt_a",
      since: "2026-04-01T00:00:00Z",
      until: "2026-05-01T00:00:00Z",
      transactions: [],
    });
    expect(summary.tenantId).toBe("tnt_a");
    expect(summary.currencies).toEqual([]);
  });

  it("sums inflow and outflow per currency", () => {
    const summary = aggregateCashFlow({
      tenantId: "tnt_a",
      since: "2026-05-01T00:00:00Z",
      until: "2026-06-01T00:00:00Z",
      transactions: [
        tx("2026-05-02T10:00:00Z", "1000.00", "inflow"),
        tx("2026-05-03T10:00:00Z", "300.00", "outflow"),
        tx("2026-05-04T10:00:00Z", "200.00", "outflow"),
      ],
    });
    expect(summary.currencies).toHaveLength(1);
    const usd = summary.currencies[0];
    expect(usd?.currency).toBe("USD");
    expect(usd?.inflow).toBe("1000.00");
    expect(usd?.outflow).toBe("500.00");
    expect(usd?.net).toBe("500.00");
    expect(usd?.transaction_count).toBe(3);
  });

  it("groups by currency when none is explicitly filtered", () => {
    const summary = aggregateCashFlow({
      tenantId: "tnt_a",
      since: "2026-05-01T00:00:00Z",
      until: "2026-06-01T00:00:00Z",
      transactions: [
        tx("2026-05-02T10:00:00Z", "100.00", "inflow", "USD"),
        tx("2026-05-02T10:00:00Z", "50.00", "inflow", "EUR"),
      ],
    });
    expect(summary.currencies).toHaveLength(2);
    const codes = summary.currencies.map((c) => c.currency).sort();
    expect(codes).toEqual(["EUR", "USD"]);
  });

  it("applies currencyFilter to drop other currencies", () => {
    const summary = aggregateCashFlow({
      tenantId: "tnt_a",
      since: "2026-05-01T00:00:00Z",
      until: "2026-06-01T00:00:00Z",
      currencyFilter: "USD",
      transactions: [
        tx("2026-05-02T10:00:00Z", "100.00", "inflow", "USD"),
        tx("2026-05-02T10:00:00Z", "50.00", "inflow", "EUR"),
      ],
    });
    expect(summary.currencies).toHaveLength(1);
    expect(summary.currencies[0]?.currency).toBe("USD");
    expect(summary.currencies[0]?.inflow).toBe("100.00");
  });

  it("breaks down by day in ascending date order", () => {
    const summary = aggregateCashFlow({
      tenantId: "tnt_a",
      since: "2026-05-01T00:00:00Z",
      until: "2026-06-01T00:00:00Z",
      transactions: [
        tx("2026-05-03T10:00:00Z", "300.00", "inflow"),
        tx("2026-05-02T10:00:00Z", "100.00", "inflow"),
        tx("2026-05-03T11:00:00Z", "50.00", "outflow"),
      ],
    });
    const byDay = summary.currencies[0]?.by_day ?? [];
    expect(byDay.map((d) => d.date)).toEqual(["2026-05-02", "2026-05-03"]);
    expect(byDay[0]?.inflow).toBe("100.00");
    expect(byDay[1]?.inflow).toBe("300.00");
    expect(byDay[1]?.outflow).toBe("50.00");
    expect(byDay[1]?.net).toBe("250.00");
  });

  it("counts transfers/adjustments in count but not in inflow/outflow totals", () => {
    const summary = aggregateCashFlow({
      tenantId: "tnt_a",
      since: "2026-05-01T00:00:00Z",
      until: "2026-06-01T00:00:00Z",
      transactions: [
        tx("2026-05-02T10:00:00Z", "100.00", "inflow"),
        tx("2026-05-03T10:00:00Z", "500.00", "transfer"),
        tx("2026-05-04T10:00:00Z", "20.00", "adjustment"),
      ],
    });
    const usd = summary.currencies[0];
    expect(usd?.inflow).toBe("100.00");
    expect(usd?.outflow).toBe("0.00");
    expect(usd?.net).toBe("100.00");
    expect(usd?.transaction_count).toBe(3);
  });
});
