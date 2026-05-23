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

/**
 * Read-only projections the memory layer needs from services it does NOT own.
 * Wiki must not query the Policy/Execution tables directly (the sanctioned Wiki
 * read-projection covers Ledger only), so it reads policy/agent state through
 * these ports. The composition root (services/api) supplies adapters backed by
 * the owning service's read API; Wiki never imports @brain/policy or
 * @brain/execution.
 */
export interface PolicyView {
  id: string;
  version: number;
  state: string;
  quorum_required: number;
  signers: Array<{ address: string }>;
  activated_at: Date | null;
  deactivated_at: Date | null;
  created_by: string;
  created_at: Date;
}

export interface AgentView {
  id: string;
  kind: string;
  role: string;
  display_name: string;
  onchain_address: string | null;
  state: string;
  registered_at: Date | null;
  created_at: Date;
}

export interface PolicyReader {
  byId(ctx: ServiceCallContext, id: string): Promise<PolicyView | null>;
  active(ctx: ServiceCallContext): Promise<PolicyView | null>;
}

export interface AgentReader {
  byId(ctx: ServiceCallContext, id: string): Promise<AgentView | null>;
}

export interface PageGenerationContext {
  ctx: ServiceCallContext;
  client: TenantScopedClient;
  /** Cross-service read ports (Policy/Execution). Absent in deployments that
   *  do not co-host those services; the policy/agent generators require them. */
  policyReader?: PolicyReader;
  agentReader?: AgentReader;
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
