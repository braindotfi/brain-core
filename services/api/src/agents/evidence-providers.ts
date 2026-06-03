/**
 * Evidence providers for the agent router (plan A3 / audit R-26).
 *
 * Bridges the narrow `EvidenceProviders` interface (`@brain/agent-router`) to
 * the real Ledger and Wiki services, so a routed agent's `required_evidence`
 * can be satisfied from concrete Ledger rows + Wiki citations. With real
 * evidence an agent can exceed the `notify_only` safe default once it reaches
 * its `minimum_confidence`; without it the agent stays `notify_only`.
 *
 * Posture — CONTEXT-KEYED, never fabricated:
 *   An evidence item is emitted only when the routing `context` references a
 *   concrete object (`account_id`, `transaction_id`, `counterparty_id`,
 *   `invoice_id`, `obligation_id`), or for a tenant-level fact the Ledger can
 *   answer directly (`balance`). When the context carries no concrete
 *   reference, no evidence is produced for that kind and the agent keeps the
 *   safe default — identical behaviour to the previous empty gatherer, but now
 *   liftable as richer domain events (carrying object ids) come online.
 *
 * Both providers are best-effort: a read error yields no evidence for that kind
 * rather than failing the route. Reads are scoped to the kinds the routed agent
 * actually requires, so an agent with no `required_evidence` triggers no reads.
 */

import type { ServiceCallContext } from "@brain/shared";
import type {
  ILedgerService,
  IWikiMemoryService,
  Balance,
  Transaction,
  Counterparty,
  Invoice,
  Obligation,
  WikiPage,
} from "@brain/shared";
import type { Evidence } from "@brain/internal-agents";
import type { EvidenceProviders, EvidenceQuery } from "@brain/agent-router";

const SYSTEM_ACTOR = "system:agent-router";

/** Required-evidence kinds the query declares (bare strings or weighted specs). */
function requiredKinds(query: EvidenceQuery): Set<string> {
  return new Set(query.requiredEvidence.map((r) => (typeof r === "string" ? r : r.kind)));
}

/** Read a string-valued context key, or undefined when absent / non-string. */
function strContext(context: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = context?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function ctxFor(tenantId: string): ServiceCallContext {
  return { tenantId, actor: SYSTEM_ACTOR };
}

// ---------- typed EvidenceRef builders -------------------------------------

function balanceEvidence(b: Balance): Evidence {
  return {
    kind: "balance",
    ref: `balance:${b.id}`,
    source_system: "ledger",
    object_type: "balance",
    object_id: b.id,
    confidence: 1,
    timestamp: b.as_of,
    excerpt: `${b.currency} current ${b.current_balance}`,
  };
}

function transactionEvidence(t: Transaction): Evidence {
  return {
    kind: "transaction",
    ref: `transaction:${t.id}`,
    source_system: "ledger",
    object_type: "transaction",
    object_id: t.id,
    confidence: 1,
    timestamp: t.transaction_date,
    excerpt: `${t.direction} ${t.currency} ${t.amount} ${t.status}`,
  };
}

function counterpartyEvidence(c: Counterparty): Evidence {
  return {
    kind: "counterparty",
    ref: `counterparty:${c.id}`,
    source_system: "ledger",
    object_type: "counterparty",
    object_id: c.id,
    confidence: 1,
    excerpt: `${c.name} (${c.type})${c.risk_level !== null ? ` risk=${c.risk_level}` : ""}`,
  };
}

function invoiceEvidence(i: Invoice): Evidence {
  return {
    kind: "invoice",
    ref: `invoice:${i.id}`,
    source_system: "ledger",
    object_type: "invoice",
    object_id: i.id,
    confidence: 1,
    timestamp: i.issue_date,
    excerpt: `${i.invoice_number} ${i.status} due ${i.currency} ${i.amount_due}`,
  };
}

function obligationEvidence(o: Obligation): Evidence {
  return {
    kind: "obligation",
    ref: `obligation:${o.id}`,
    source_system: "ledger",
    object_type: "obligation",
    object_id: o.id,
    confidence: 1,
    timestamp: o.due_date,
    excerpt: `${o.type} ${o.status} due ${o.currency} ${o.amount_due}`,
  };
}

function wikiEvidence(page: WikiPage, score: number): Evidence {
  return {
    kind: "wiki",
    ref: `wiki:${page.slug}`,
    source_system: "wiki",
    object_type: page.page_type,
    object_id: page.subject_id ?? page.id,
    confidence: Math.max(0, Math.min(1, score)),
    timestamp: page.rendered_at,
    excerpt: page.body_md.slice(0, 160),
  };
}

// ---------- providers ------------------------------------------------------

/**
 * Ledger evidence provider. Resolves the required kinds it can serve from the
 * routing context using the `ILedgerService` read surface.
 */
export function makeLedgerEvidenceProvider(
  ledger: ILedgerService,
): (query: EvidenceQuery) => Promise<readonly Evidence[]> {
  return async (query: EvidenceQuery): Promise<readonly Evidence[]> => {
    const ctx = ctxFor(query.tenantId);
    const want = requiredKinds(query);
    const context = query.context;
    const out: Evidence[] = [];

    const accountId = strContext(context, "account_id");
    const transactionId = strContext(context, "transaction_id");
    const counterpartyId = strContext(context, "counterparty_id");
    const invoiceId = strContext(context, "invoice_id");
    const obligationId = strContext(context, "obligation_id");

    // balance — a specific account's latest balance, else the tenant's
    // most-recent balance row (a legitimate aggregate for cash/treasury agents).
    if (want.has("balance")) {
      try {
        if (accountId !== undefined) {
          const res = await ledger.getAccount(ctx, accountId);
          if (res !== null && res.latest_balance !== null) {
            out.push(balanceEvidence(res.latest_balance));
          }
        } else {
          const balances = await ledger.listBalances(ctx, {});
          const latest = balances[0];
          if (latest !== undefined) {
            out.push(balanceEvidence(latest));
          }
        }
      } catch {
        // best-effort: a read failure must not fail the route.
      }
    }

    // transaction — the referenced transaction, else the latest for a
    // referenced counterparty (a relevant, not arbitrary, pick).
    if (want.has("transaction")) {
      try {
        if (transactionId !== undefined) {
          const tx = await ledger.getTransaction(ctx, transactionId);
          if (tx !== null) {
            out.push(transactionEvidence(tx));
          }
        } else if (counterpartyId !== undefined) {
          const { items } = await ledger.listTransactions(ctx, {
            counterparty_id: counterpartyId,
            limit: 1,
          });
          const tx = items[0];
          if (tx !== undefined) {
            out.push(transactionEvidence(tx));
          }
        }
      } catch {
        // best-effort.
      }
    }

    // counterparty — resolve the referenced counterparty (no point getter on
    // the boundary, so match within a bounded list).
    if (want.has("counterparty") && counterpartyId !== undefined) {
      try {
        const { items } = await ledger.listCounterparties(ctx, { limit: 200 });
        const cp = items.find((c) => c.id === counterpartyId);
        if (cp !== undefined) {
          out.push(counterpartyEvidence(cp));
        }
      } catch {
        // best-effort.
      }
    }

    // invoice — by referenced counterparty (filtered list), matching invoice_id
    // when present, else the most-recent invoice for that counterparty.
    if (want.has("invoice") && (counterpartyId !== undefined || invoiceId !== undefined)) {
      try {
        const { items } = await ledger.listInvoices(ctx, {
          ...(counterpartyId !== undefined ? { counterparty_id: counterpartyId } : {}),
          limit: 25,
        });
        const inv = invoiceId !== undefined ? items.find((i) => i.id === invoiceId) : items[0];
        if (inv !== undefined) {
          out.push(invoiceEvidence(inv));
        }
      } catch {
        // best-effort.
      }
    }

    // obligation — match the referenced obligation within a bounded list
    // (the boundary exposes no point getter).
    if (want.has("obligation") && obligationId !== undefined) {
      try {
        const { items } = await ledger.listObligations(ctx, { limit: 100 });
        const ob = items.find((o) => o.id === obligationId);
        if (ob !== undefined) {
          out.push(obligationEvidence(ob));
        }
      } catch {
        // best-effort.
      }
    }

    return out;
  };
}

/**
 * Wiki evidence provider. Emits narrative citations (kind "wiki") grounded in a
 * text query derived from the routing context. No internal agent requires a
 * "wiki" kind today, so these enrich the bundle for grounding/observability
 * without changing required-evidence completeness — they are supplemental.
 */
export function makeWikiEvidenceProvider(
  wiki: IWikiMemoryService,
): (query: EvidenceQuery) => Promise<readonly Evidence[]> {
  return async (query: EvidenceQuery): Promise<readonly Evidence[]> => {
    const ctx = ctxFor(query.tenantId);
    const context = query.context;
    const q =
      strContext(context, "query") ??
      strContext(context, "question") ??
      strContext(context, "description") ??
      strContext(context, "counterparty_name");
    if (q === undefined) {
      return [];
    }
    try {
      const hits = await wiki.search(ctx, q, 3);
      return hits.map((h) => wikiEvidence(h.page, h.score));
    } catch {
      // best-effort: search failure yields no supplemental citations.
      return [];
    }
  };
}

/** Build the combined Wiki + Ledger evidence providers for a ServiceEvidenceGatherer. */
export function buildEvidenceProviders(deps: {
  ledger: ILedgerService;
  wiki: IWikiMemoryService;
}): EvidenceProviders {
  return {
    ledger: makeLedgerEvidenceProvider(deps.ledger),
    wiki: makeWikiEvidenceProvider(deps.wiki),
  };
}
