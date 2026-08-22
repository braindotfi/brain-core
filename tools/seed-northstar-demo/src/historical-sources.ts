import { newSourceId, withTenantScope } from "@brain/shared";
import type { Pool } from "pg";
import { NORTHSTAR_SEED_KEY } from "./fixture.js";

export const NORTHSTAR_ACCOUNT_EXTERNAL_IDS = {
  operating: "northstar:operating:001",
  reserve: "northstar:reserve:001",
  card: "northstar:card:001",
} as const;

type NorthstarAccountKey = keyof typeof NORTHSTAR_ACCOUNT_EXTERNAL_IDS;

export type NorthstarHistoricalSource = {
  sourceKey: string;
  type: "csv_upload" | "pdf_upload";
  displayName: string;
  providerName: string;
  sourceCategory: string;
  externalAccountIds: string[];
  ledgerAccountIds: string[];
  ledgerDomains: string[];
};

const SOURCE_DEFINITIONS: ReadonlyArray<{
  sourceKey: string;
  type: "csv_upload" | "pdf_upload";
  displayName: string;
  providerName: string;
  sourceCategory: string;
  accountKeys: readonly NorthstarAccountKey[];
  ledgerDomains: readonly string[];
}> = [
  {
    sourceKey: "harborline-bank-export",
    type: "csv_upload",
    displayName: "Harborline Bank Historical Export",
    providerName: "Harborline Bank",
    sourceCategory: "banking_cash",
    accountKeys: ["operating", "reserve"],
    ledgerDomains: ["accounts", "transactions"],
  },
  {
    sourceKey: "keystone-card-export",
    type: "csv_upload",
    displayName: "Keystone Corporate Card Historical Export",
    providerName: "Keystone Corporate Card",
    sourceCategory: "banking_cash",
    accountKeys: ["card"],
    ledgerDomains: ["accounts", "transactions"],
  },
  {
    sourceKey: "meridian-payroll-export",
    type: "csv_upload",
    displayName: "Meridian Benefits Payroll Historical Export",
    providerName: "Meridian Benefits",
    sourceCategory: "payroll_hr",
    accountKeys: [],
    ledgerDomains: ["counterparties", "transactions", "obligations"],
  },
  {
    sourceKey: "irs-tax-records",
    type: "pdf_upload",
    displayName: "Internal Revenue Service Historical Tax Records",
    providerName: "Internal Revenue Service",
    sourceCategory: "tax_records",
    accountKeys: [],
    ledgerDomains: ["counterparties", "obligations"],
  },
  {
    sourceKey: "northstar-accounting-export",
    type: "csv_upload",
    displayName: "Northstar Accounting Historical Export",
    providerName: "Northstar Labs",
    sourceCategory: "accounting_erp",
    accountKeys: [],
    ledgerDomains: ["counterparties", "transactions", "obligations", "invoices"],
  },
];

export function buildNorthstarHistoricalSources(
  ledgerAccountIdsByKey: Readonly<Record<NorthstarAccountKey, string>>,
): NorthstarHistoricalSource[] {
  return SOURCE_DEFINITIONS.map((definition) => ({
    sourceKey: definition.sourceKey,
    type: definition.type,
    displayName: definition.displayName,
    providerName: definition.providerName,
    sourceCategory: definition.sourceCategory,
    externalAccountIds: definition.accountKeys.map((key) => NORTHSTAR_ACCOUNT_EXTERNAL_IDS[key]),
    ledgerAccountIds: definition.accountKeys.map((key) => ledgerAccountIdsByKey[key]),
    ledgerDomains: [...definition.ledgerDomains],
  }));
}

export type NorthstarHistoricalSourceSeedResult = {
  tenantId: string;
  created: number;
  updated: number;
  sourceIds: string[];
};

export function buildNorthstarHistoricalSourceMetadata(
  source: NorthstarHistoricalSource,
  sourceAsOf: string,
): Record<string, unknown> {
  return {
    seed_key: NORTHSTAR_SEED_KEY,
    seed_source_key: source.sourceKey,
    seed_as_of: sourceAsOf,
    display_name: source.displayName,
    provider_name: source.providerName,
    source_category: source.sourceCategory,
    origin_mode: "historical_import",
    live_connection: false,
    sync_disabled: true,
    disconnectable: false,
    disconnect_hidden: true,
    provenance_note:
      "Historical origin represented by the Northstar presenter seed. No live connector is configured.",
    overlaps_with: {
      ledger_account_ids: source.ledgerAccountIds,
      ledger_account_external_ids: source.externalAccountIds,
      ledger_domains: source.ledgerDomains,
    },
  };
}

export async function seedNorthstarHistoricalSources(
  pool: Pool,
  tenantId: string,
  asOf: Date = new Date(),
): Promise<NorthstarHistoricalSourceSeedResult> {
  const sourceAsOf = asOf.toISOString();
  return withTenantScope(pool, tenantId, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${NORTHSTAR_SEED_KEY}:historical-sources:${tenantId}`,
    ]);

    const accountRows = await client.query<{ id: string; external_account_id: string }>(
      `SELECT id, external_account_id
         FROM ledger_accounts
        WHERE external_account_id = ANY($1::text[])`,
      [Object.values(NORTHSTAR_ACCOUNT_EXTERNAL_IDS)],
    );
    const accountIdByExternalId = new Map(
      accountRows.rows.map((row) => [row.external_account_id, row.id]),
    );
    const ledgerAccountIdsByKey = Object.fromEntries(
      Object.entries(NORTHSTAR_ACCOUNT_EXTERNAL_IDS).map(([key, externalId]) => {
        const accountId = accountIdByExternalId.get(externalId);
        if (accountId === undefined) {
          throw new Error(`Northstar Ledger account is missing: ${externalId}`);
        }
        return [key, accountId];
      }),
    ) as Record<NorthstarAccountKey, string>;

    let created = 0;
    let updated = 0;
    const sourceIds: string[] = [];
    for (const source of buildNorthstarHistoricalSources(ledgerAccountIdsByKey)) {
      const metadata = buildNorthstarHistoricalSourceMetadata(source, sourceAsOf);
      const existing = await client.query<{ id: string }>(
        `SELECT id
           FROM raw_sources
          WHERE metadata->>'seed_key' = $1
            AND metadata->>'seed_source_key' = $2
          LIMIT 1`,
        [NORTHSTAR_SEED_KEY, source.sourceKey],
      );
      const existingId = existing.rows[0]?.id;
      if (existingId === undefined) {
        const id = newSourceId();
        await client.query(
          `INSERT INTO raw_sources
             (id, tenant_id, type, status, encrypted_credentials, credential_key_id,
              metadata, external_account_ids, last_synced_at, error_message, is_stub,
              created_at, updated_at)
           VALUES ($1,$2,$3,'historical',NULL,NULL,$4::jsonb,$5,NULL,NULL,true,now(),now())`,
          [id, tenantId, source.type, JSON.stringify(metadata), source.externalAccountIds],
        );
        sourceIds.push(id);
        created += 1;
      } else {
        await client.query(
          `UPDATE raw_sources
              SET type = $1,
                  status = 'historical',
                  encrypted_credentials = NULL,
                  credential_key_id = NULL,
                  metadata = $2::jsonb,
                  external_account_ids = $3,
                  last_synced_at = NULL,
                  error_message = NULL,
                  is_stub = true,
                  updated_at = now()
            WHERE id = $4`,
          [source.type, JSON.stringify(metadata), source.externalAccountIds, existingId],
        );
        sourceIds.push(existingId);
        updated += 1;
      }
    }

    return { tenantId, created, updated, sourceIds };
  });
}
