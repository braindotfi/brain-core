import { describe, expect, it, vi } from "vitest";

import { Brain } from "./brain.js";

function mockFetch(
  status: number,
  body: unknown,
): { fetch: typeof globalThis.fetch; calls: Request[] } {
  const calls: Request[] = [];
  const fn = vi.fn(async (input: Request | URL | string) => {
    calls.push(input as Request);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

describe("Brain.canonical", () => {
  it("listObligations returns the obligations array", async () => {
    const { fetch, calls } = mockFetch(200, { obligations: [{ id: "cobl_1" }] });
    const brain = new Brain({ token: "k", fetch });

    const obligations = await brain.canonical.listObligations({ direction: "payable" });

    expect(obligations).toHaveLength(1);
    expect(calls[0]?.url).toContain("/canonical/obligations");
    expect(calls[0]?.url).toContain("direction=payable");
  });

  it("getObligation fetches one by id", async () => {
    const { fetch, calls } = mockFetch(200, { id: "cobl_1" });
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.canonical.getObligation("cobl_1");

    expect(result.id).toBe("cobl_1");
    expect(calls[0]?.url).toContain("/canonical/obligations/cobl_1");
  });

  it("listGlAccounts returns the gl_accounts array", async () => {
    const { fetch, calls } = mockFetch(200, { gl_accounts: [{ id: "gla_1" }] });
    const brain = new Brain({ token: "k", fetch });

    const accounts = await brain.canonical.listGlAccounts();

    expect(accounts).toHaveLength(1);
    expect(calls[0]?.url).toContain("/canonical/gl-accounts");
  });

  it("getGlAccount fetches one by id", async () => {
    const { fetch, calls } = mockFetch(200, { id: "gla_1" });
    const brain = new Brain({ token: "k", fetch });

    await brain.canonical.getGlAccount("gla_1");

    expect(calls[0]?.url).toContain("/canonical/gl-accounts/gla_1");
  });

  it("listJournalEntries returns the journal_entries array", async () => {
    const { fetch, calls } = mockFetch(200, { journal_entries: [{ id: "je_1" }] });
    const brain = new Brain({ token: "k", fetch });

    const entries = await brain.canonical.listJournalEntries();

    expect(entries).toHaveLength(1);
    expect(calls[0]?.url).toContain("/canonical/journal-entries");
  });

  it("getJournalEntry fetches one by id", async () => {
    const { fetch, calls } = mockFetch(200, { id: "je_1" });
    const brain = new Brain({ token: "k", fetch });

    await brain.canonical.getJournalEntry("je_1");

    expect(calls[0]?.url).toContain("/canonical/journal-entries/je_1");
  });

  it("propagates a scope-insufficient 403 as BrainAPIError (no principal has canonical:read yet)", async () => {
    const { fetch } = mockFetch(403, {
      error: {
        code: "auth_scope_insufficient",
        message: "missing required scope: canonical:read",
        request_id: "req_1",
        docs_url: "https://docs.brain.fi/resources/errors#auth_scope_insufficient",
      },
    });
    const brain = new Brain({ token: "k", fetch });

    await expect(brain.canonical.listObligations()).rejects.toMatchObject({ status: 403 });
  });
});

describe("Brain.ledgerOperations", () => {
  it("normalize posts raw_parsed_id and returns created rows", async () => {
    const { fetch, calls } = mockFetch(200, {
      ledger_rows_created: [{ entity: "account", id: "acct_1" }],
    });
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.ledgerOperations.normalize({ raw_parsed_id: "rp_1" });

    expect(result.ledger_rows_created).toHaveLength(1);
    expect(calls[0]?.url).toContain("/ledger/normalize");
    const sent = await calls[0]!.text();
    expect(sent).toContain('"raw_parsed_id":"rp_1"');
  });

  it("reconcile posts an optional body and returns a job_id", async () => {
    const { fetch, calls } = mockFetch(202, { job_id: "recjob_1" });
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.ledgerOperations.reconcile({ since: "2026-07-01T00:00:00Z" });

    expect(result.job_id).toBe("recjob_1");
    expect(calls[0]?.url).toContain("/ledger/reconcile");
  });

  it("reconcile surfaces a 501 (ReconciliationService not configured) as BrainAPIError", async () => {
    const { fetch } = mockFetch(501, {
      error: {
        code: "raw_source_unsupported",
        message: "ReconciliationService not configured for this app instance",
        request_id: "req_1",
        docs_url: "https://docs.brain.fi/resources/errors#raw_source_unsupported",
      },
    });
    const brain = new Brain({ token: "k", fetch });

    await expect(brain.ledgerOperations.reconcile()).rejects.toMatchObject({ status: 501 });
  });

  it("listReconciliationMatches passes status/match_type query params", async () => {
    const { fetch, calls } = mockFetch(200, { matches: [{ id: "match_1" }] });
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.ledgerOperations.listReconciliationMatches({
      status: "confirmed",
      match_type: "invoice_payment",
    });

    expect(result.matches).toHaveLength(1);
    expect(calls[0]?.url).toContain("status=confirmed");
    expect(calls[0]?.url).toContain("match_type=invoice_payment");
  });
});

describe("Brain.accounts / counterparties / obligations getResolved", () => {
  it("accounts.getResolved fetches the resolved view", async () => {
    const { fetch, calls } = mockFetch(200, { account_id: "acct_1", observations: [] });
    const brain = new Brain({ token: "k", fetch });

    await brain.accounts.getResolved("acct_1");

    expect(calls[0]?.url).toContain("/ledger/accounts/acct_1/resolved");
  });

  it("counterparties.getResolved fetches the resolved view", async () => {
    const { fetch, calls } = mockFetch(200, { counterparty_id: "cp_1", facets: [] });
    const brain = new Brain({ token: "k", fetch });

    await brain.counterparties.getResolved("cp_1");

    expect(calls[0]?.url).toContain("/ledger/counterparties/cp_1/resolved");
  });

  it("obligations.getResolved fetches the resolved view", async () => {
    const { fetch, calls } = mockFetch(200, { obligation_id: "obl_1", observations: [] });
    const brain = new Brain({ token: "k", fetch });

    await brain.obligations.getResolved("obl_1");

    expect(calls[0]?.url).toContain("/ledger/obligations/obl_1/resolved");
  });
});
