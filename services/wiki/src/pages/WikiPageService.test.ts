import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { newTenantId } from "@brain/shared";
import type { AuditEmitter, EmbeddingAdapter, ServiceCallContext } from "@brain/shared";
import { WikiPageService } from "./WikiPageService.js";

const ctx: ServiceCallContext = {
  tenantId: newTenantId(),
  actor: "system:wiki-regeneration-worker",
};

describe("WikiPageService.deletePage", () => {
  it("deletes the slug inside tenant scope", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const service = new WikiPageService(depsWith(queries, 1));

    await expect(service.deletePage(ctx, "/obligations/obl_1")).resolves.toBe(true);

    // RLS is FORCEd on wiki_pages, so an unscoped DELETE would silently affect
    // nothing. The scope is the point of the assertion, not an incidental.
    expect(queries.some((q) => q.text.includes("SELECT set_config('app.tenant_id'"))).toBe(true);
    const del = queries.find((q) => q.text.includes("DELETE FROM wiki_pages"));
    expect(del?.values).toEqual(["/obligations/obl_1"]);
  });

  it("reports false when no row matched", async () => {
    const service = new WikiPageService(depsWith([], 0));
    await expect(service.deletePage(ctx, "/obligations/obl_gone")).resolves.toBe(false);
  });
});

function depsWith(queries: Array<{ text: string; values: unknown[] }>, deleteRowCount: number) {
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      if (text.includes("DELETE FROM wiki_pages")) {
        return { rows: [], rowCount: deleteRowCount };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    audit: { emit: async () => undefined } as unknown as AuditEmitter,
    embed: { embed: async () => ({ vector: [0] }) } as unknown as EmbeddingAdapter,
  };
}
