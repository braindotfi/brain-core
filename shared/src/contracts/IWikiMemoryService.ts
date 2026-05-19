/**
 * IWikiMemoryService — Layer 3 boundary contract.
 *
 * Owns human-readable memory pages and the natural-language Q&A endpoint.
 * Pages are derived artifacts — regenerable from Ledger + Raw at any time.
 *
 * Layer boundary invariants:
 *  - Wiki text is NEVER the source of truth for balances, obligations,
 *    transactions, or permissions. Policy never reads Wiki. Execution never
 *    reads Wiki. Agents may read Wiki for narrative recall, but every
 *    machine-checkable precondition comes from the Ledger.
 *  - /wiki/question grounds in Ledger rows, not in Wiki text. Wiki provides
 *    retrieval scaffolding; the cited facts come from Ledger.
 *  - Annotations write through to the Ledger via a controlled write-through
 *    path that itself writes a Raw artifact, so the audit chain is intact.
 */

import type { ServiceCallContext } from "./types.js";

export interface WikiPage {
  id: string;
  page_type:
    | "account"
    | "counterparty"
    | "obligation"
    | "invoice"
    | "agent"
    | "policy"
    | "monthly_summary"
    | "cash_flow";
  subject_id: string | null;
  slug: string;
  body_md: string;
  rendered_at: string;
  source_revision: string;
}

export interface QuestionRequest {
  question: string;
  asOf: string | null;
  maxEvidenceDepth: number;
}

export interface QuestionAnswer {
  question: string;
  answer: string;
  evidence: Array<{ entityType: string; entityId: string; excerpt: string }>;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  cachedAt?: string;
}

export interface AnnotationInput {
  target_type:
    | "ledger_account"
    | "ledger_transaction"
    | "ledger_counterparty"
    | "ledger_obligation"
    | "ledger_invoice";
  target_id: string;
  body?: string;
  /** Optional structured override of attributes; written through to Ledger via a Raw artifact. */
  override_attributes?: Record<string, unknown>;
}

export interface IWikiMemoryService {
  listPages(
    ctx: ServiceCallContext,
    f: { page_type?: WikiPage["page_type"]; q?: string; limit?: number },
  ): Promise<{ pages: WikiPage[] }>;
  getPage(ctx: ServiceCallContext, slugOrId: string): Promise<WikiPage | null>;
  regenerate(ctx: ServiceCallContext, slugOrId: string): Promise<WikiPage>;
  search(
    ctx: ServiceCallContext,
    q: string,
    limit: number,
  ): Promise<Array<{ page: WikiPage; score: number }>>;
  question(ctx: ServiceCallContext, req: QuestionRequest): Promise<QuestionAnswer>;
  annotate(
    ctx: ServiceCallContext,
    input: AnnotationInput,
  ): Promise<{ annotation_id: string; raw_artifact_id: string }>;
}
