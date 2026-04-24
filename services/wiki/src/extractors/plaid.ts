/**
 * Plaid → Wiki extractor. Minimal stage-3 implementation.
 *
 * Input:  a raw_parsed row where parser = 'plaid_tx_v1' (or the raw JSON
 *         body from a Plaid webhook directly).
 * Output: transaction entities + optional counterparty entities +
 *         transacted_with relations.
 *
 * This is NOT a full extractor — real Plaid transaction reconciliation
 * requires merchant-name normalization, counterparty resolution, and
 * currency conversion. Those expand in a dedicated workstream. MVP keeps
 * the happy path so /wiki/question has something to ground in.
 */

import {
  newWikiEntityId,
  newWikiRelationId,
  type TenantScopedClient,
} from "@brain/api/shared";
import { insertEntity } from "../repository/entities.js";
import { insertRelation } from "../repository/relations.js";
import type { SchemaRegistry } from "../schemas.js";

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  date: string;
  authorized_date?: string | null;
  name?: string;
  merchant_name?: string;
  pending?: boolean;
}

export interface PlaidExtractInput {
  tenantId: string;
  rawParsedId: string;
  transactions: ReadonlyArray<PlaidTransaction>;
  accountEntityId: string;
}

export interface ExtractResult {
  entities: number;
  relations: number;
}

export async function extractPlaidTransactions(
  client: TenantScopedClient,
  schemas: SchemaRegistry,
  input: PlaidExtractInput,
): Promise<ExtractResult> {
  const now = new Date();
  let entities = 0;
  let relations = 0;

  for (const tx of input.transactions) {
    if (tx.pending === true) continue; // don't materialize pending rows
    const txEntityId = newWikiEntityId();
    const direction: "inbound" | "outbound" = tx.amount >= 0 ? "outbound" : "inbound";
    const attrs = {
      direction,
      amount: Math.abs(tx.amount).toFixed(2),
      currency: tx.iso_currency_code ?? "USD",
      posted_at: new Date(tx.date).toISOString(),
      ...(tx.authorized_date != null
        ? { authorized_at: new Date(tx.authorized_date).toISOString() }
        : {}),
      ...(tx.name !== undefined ? { memo: tx.name } : {}),
      external_id: tx.transaction_id,
      rail: "ach" as const,
    };
    schemas.validateEntity("transaction", attrs);

    await insertEntity(client, {
      id: txEntityId,
      tenantId: input.tenantId,
      kind: "transaction",
      attributes: attrs,
      embedding: null,
      validFrom: now,
      validTo: null,
      provenance: "extracted",
      confidence: 0.9,
      sourceEvidence: [input.rawParsedId],
    });
    entities += 1;

    // counterparty entity (merchant_name when available)
    let counterpartyId: string | null = null;
    if (tx.merchant_name !== undefined && tx.merchant_name.length > 0) {
      const cpAttrs = { display_name: tx.merchant_name, kind: "vendor" };
      schemas.validateEntity("counterparty", cpAttrs);
      const cpId = newWikiEntityId();
      await insertEntity(client, {
        id: cpId,
        tenantId: input.tenantId,
        kind: "counterparty",
        attributes: cpAttrs,
        embedding: null,
        validFrom: now,
        validTo: null,
        provenance: "extracted",
        confidence: 0.6,
        sourceEvidence: [input.rawParsedId],
      });
      entities += 1;
      counterpartyId = cpId;
    }

    // transacted_with relation
    if (counterpartyId !== null) {
      const relAttrs = {
        transaction_id: txEntityId,
        amount: attrs.amount,
        currency: attrs.currency,
        posted_at: attrs.posted_at,
      };
      schemas.validateRelation("transacted_with", relAttrs);
      await insertRelation(client, {
        id: newWikiRelationId(),
        tenantId: input.tenantId,
        src: input.accountEntityId,
        dst: counterpartyId,
        kind: "transacted_with",
        attributes: relAttrs,
        validFrom: now,
        validTo: null,
        provenance: "extracted",
        confidence: 0.8,
        sourceEvidence: [input.rawParsedId],
      });
      relations += 1;
    }
  }

  return { entities, relations };
}
