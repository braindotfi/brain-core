/**
 * Wiki page generation framework.
 *
 * Each page type has a generator that takes a Ledger query handle and
 * returns:
 *   - body_md (markdown matching the standard Brain memory page sections:
 *     Current Truth, Key Linked Entities, Recent Activity, Open Questions /
 *     Missing Evidence, Risk Notes, Timeline, Evidence Links)
 *   - source_revision (a checksum of the inputs used; lets a stale page
 *     be detected without re-rendering)
 *
 * Generators MUST NOT call the LLM. Wiki pages are deterministic
 * renderings of Ledger state; the LLM-in-hot-path lives at /wiki/question
 * (orchestrator.ts) and reads pages + Ledger.
 */

import type { TenantScopedClient, WikiPage, ServiceCallContext } from "@brain/shared";

export interface PageGenerationContext {
  ctx: ServiceCallContext;
  client: TenantScopedClient;
}

export interface PageGenerationOutput {
  page_type: WikiPage["page_type"];
  subject_id: string | null;
  slug: string;
  body_md: string;
  source_revision: string;
}

export interface PageGenerator {
  readonly pageType: WikiPage["page_type"];
  /**
   * Resolve a slug-or-id to the subject this generator can render.
   * Returns null if the generator does not own this slug.
   */
  resolveSlug(slugOrId: string): { subjectId: string | null; slug: string } | null;
  /** Render the page from current Ledger state. */
  render(
    deps: PageGenerationContext,
    subject: { subjectId: string | null; slug: string },
  ): Promise<PageGenerationOutput>;
}
