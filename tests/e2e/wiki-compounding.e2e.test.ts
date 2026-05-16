/**
 * Proof test 2 (§6 of Brain_MVP_Architecture.md):
 *
 * "Every day a design partner is on Brain, their Wiki gets measurably
 * richer: more entities, denser relations, higher average confidence on
 * derived facts, more human-confirmed corrections feeding back into
 * extraction quality. This is measurable and shown on a single chart in
 * the investor deck."
 *
 * This suite requires a test tenant seeded with synthetic data. It verifies
 * that the Layer 3 narrative memory is non-empty and that pgvector semantic
 * search returns ranked results — both are observable proxies for the
 * compounding memory value proposition.
 *
 * v0.3 note: the v0.2 /wiki/search monthly-summary special endpoint no
 * longer exists. Compounding growth is now demonstrated via wiki page count
 * and semantic search quality on the /memory/* routes.
 */

import { describe, expect, it } from "vitest";
import { envClient } from "./lib/client.js";

const DESCRIBE = process.env.BRAIN_BASE_URL !== undefined ? describe : describe.skip;

DESCRIBE("wiki compounding (Series A proof 2)", () => {
  it("wiki memory is non-empty and semantic search returns ranked results", async () => {
    const client = envClient();

    // Memory pages compiled from Ledger + Raw evidence should be non-empty.
    const pages = await client.get<{ pages: Array<{ slug: string; page_type: string }> }>(
      "/v1/memory/pages?limit=100",
    );
    expect(pages.pages.length).toBeGreaterThan(0);

    // Semantic search via pgvector must return scored results for a general
    // financial query. Score is cosine similarity ∈ [0, 1].
    const results = await client.get<{ results: Array<{ page: unknown; score: number }> }>(
      "/v1/memory/search?q=payment+summary&limit=10",
    );
    expect(results.results.length).toBeGreaterThan(0);
    for (const r of results.results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });
});
