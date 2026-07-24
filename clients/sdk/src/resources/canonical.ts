import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { components, operations } from "../generated/openapi.js";

export type CanonicalObligationProduct = components["schemas"]["CanonicalObligationProduct"];
export type CanonicalGlAccountProduct = components["schemas"]["CanonicalGlAccountProduct"];
export type CanonicalJournalEntryProduct = components["schemas"]["CanonicalJournalEntryProduct"];

export type ListCanonicalObligationsParams = NonNullable<
  operations["listCanonicalObligations"]["parameters"]["query"]
>;
export type ListCanonicalGlAccountsParams = NonNullable<
  operations["listCanonicalGlAccounts"]["parameters"]["query"]
>;
export type ListCanonicalJournalEntriesParams = NonNullable<
  operations["listCanonicalJournalEntries"]["parameters"]["query"]
>;

function unwrap<T>(data: T | undefined, error: BrainErrorBody | undefined, status: number): T {
  if (error !== undefined || data === undefined) {
    throw new BrainAPIError(status, error);
  }
  return data;
}

/**
 * Phase 6 governed data products, read-only, provenance-backed views over
 * the canonical domain (obligations, GL accounts, journal entries). Every
 * record carries how Brain knows it and when it was last projected.
 *
 * Requires the `canonical:read` scope. As of this writing, no currently
 * issued credential (member session, owner token, agent, or API key) is
 * granted that scope anywhere in the server, every call here will 403 with
 * `auth_scope_insufficient` until that's provisioned. The routes themselves
 * are real and registered; this is a scope-provisioning gap, not something
 * an SDK wrapper can work around. See the SDK gap-closing checklist's Tier 3
 * notes for detail.
 */
export class CanonicalResource {
  constructor(private readonly http: BrainHttpClient) {}

  async listObligations(
    params: ListCanonicalObligationsParams = {},
  ): Promise<CanonicalObligationProduct[]> {
    const { data, error, response } = await this.http.GET("/canonical/obligations", {
      params: { query: params },
    });
    const body = unwrap(data, error, response.status);
    return body.obligations;
  }

  async getObligation(obligationId: string): Promise<CanonicalObligationProduct> {
    const { data, error, response } = await this.http.GET(
      "/canonical/obligations/{obligation_id}",
      { params: { path: { obligation_id: obligationId } } },
    );
    return unwrap(data, error, response.status);
  }

  async listGlAccounts(
    params: ListCanonicalGlAccountsParams = {},
  ): Promise<CanonicalGlAccountProduct[]> {
    const { data, error, response } = await this.http.GET("/canonical/gl-accounts", {
      params: { query: params },
    });
    const body = unwrap(data, error, response.status);
    return body.gl_accounts;
  }

  async getGlAccount(glAccountId: string): Promise<CanonicalGlAccountProduct> {
    const { data, error, response } = await this.http.GET(
      "/canonical/gl-accounts/{gl_account_id}",
      { params: { path: { gl_account_id: glAccountId } } },
    );
    return unwrap(data, error, response.status);
  }

  async listJournalEntries(
    params: ListCanonicalJournalEntriesParams = {},
  ): Promise<CanonicalJournalEntryProduct[]> {
    const { data, error, response } = await this.http.GET("/canonical/journal-entries", {
      params: { query: params },
    });
    const body = unwrap(data, error, response.status);
    return body.journal_entries;
  }

  async getJournalEntry(journalEntryId: string): Promise<CanonicalJournalEntryProduct> {
    const { data, error, response } = await this.http.GET(
      "/canonical/journal-entries/{journal_entry_id}",
      { params: { path: { journal_entry_id: journalEntryId } } },
    );
    return unwrap(data, error, response.status);
  }
}
