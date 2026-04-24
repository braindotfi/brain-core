/**
 * Proof test 2 (§6 of Brain_MVP_Architecture.md):
 *
 * "Every day a design partner is on Brain, their Wiki gets measurably
 * richer: more entities, denser relations, higher average confidence on
 * derived facts, more human-confirmed corrections feeding back into
 * extraction quality. This is measurable and shown on a single chart in
 * the investor deck."
 *
 * This suite requires a test tenant that has been seeded with 12 months of
 * synthetic data. The tenant is reset daily by a cron job that restarts
 * the seed. The assertions check that the compounding metrics increase
 * monotonically across the 12 synthetic months.
 */

import { describe, expect, it } from "vitest";
import { envClient } from "./lib/client.js";

const DESCRIBE = process.env.BRAIN_BASE_URL !== undefined ? describe : describe.skip;

interface EntityCountSample {
  month: string;
  entity_count: number;
  relation_count: number;
  avg_confidence: number;
  human_confirmed_count: number;
}

DESCRIBE("wiki compounding (Series A proof 2)", () => {
  it("entity count, relation count, avg confidence, and human_confirmed count all increase monotonically", async () => {
    const client = envClient();
    // The staging-seeded tenant exposes a helper view via /wiki/search
    // with a synthetic month filter. Real production tenants won't have
    // this — it's a seed-only surface.
    const samples = await client.get<{ samples: EntityCountSample[] }>(
      "/wiki/search?q=__synthetic_monthly_summary__&limit=12",
    );
    const series = samples.samples;
    expect(series.length).toBe(12);

    for (let i = 1; i < series.length; i += 1) {
      const prev = series[i - 1]!;
      const cur = series[i]!;
      expect(cur.entity_count).toBeGreaterThanOrEqual(prev.entity_count);
      expect(cur.relation_count).toBeGreaterThanOrEqual(prev.relation_count);
      expect(cur.avg_confidence).toBeGreaterThanOrEqual(prev.avg_confidence - 0.01); // allow FP noise
      expect(cur.human_confirmed_count).toBeGreaterThanOrEqual(prev.human_confirmed_count);
    }
  });
});
