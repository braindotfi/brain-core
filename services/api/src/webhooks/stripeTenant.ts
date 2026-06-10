/**
 * Stripe webhook tenant resolver.
 *
 * Maps a Stripe event's `account` field to the Brain `tenant_id` that owns
 * the corresponding Stripe connection. No dedicated mapping table is needed:
 * the connected account id materializes in the sync-partition checkpoint
 * (`raw_sync_partitions.committed_checkpoint->>'stripe_account_id'`) on the
 * connection's first pull, so the lookup reads that.
 *
 * `account` is present on Connect-platform deliveries. Direct-account events
 * do not carry it; those tenants are covered by the pull modality (webhooks
 * normally schedule a synchronization rather than being the authoritative
 * record, ingestion architecture §8), and an unresolvable event is rejected
 * rather than guessed.
 *
 * Cross-tenant direct pool query (no RLS) — the lookup runs *before* the
 * tenant is known, mirroring the Plaid resolver.
 */

import type { Pool } from "pg";
import { brainError } from "@brain/shared";

interface StripeEventEnvelope {
  account?: string;
}

type TenantResolver = (
  provider: string,
  body: Buffer,
  headers: Record<string, unknown>,
) => Promise<string>;

export function createStripeTenantResolver(pool: Pool): TenantResolver {
  return async function resolveStripeTenant(provider: string, body: Buffer): Promise<string> {
    if (provider !== "stripe") {
      throw brainError("auth_tenant_mismatch", `no tenant resolver for provider: ${provider}`);
    }

    let parsed: StripeEventEnvelope;
    try {
      parsed = JSON.parse(body.toString("utf8")) as StripeEventEnvelope;
    } catch {
      throw brainError("request_body_invalid", "Stripe webhook body is not valid JSON");
    }

    const accountId = parsed.account;
    if (typeof accountId !== "string" || accountId.length === 0) {
      throw brainError(
        "auth_tenant_mismatch",
        "Stripe event carries no account id — direct-account events are ingested via the pull path",
      );
    }

    const result = await pool.query<{ tenant_id: string }>(
      `SELECT tenant_id
         FROM raw_sync_partitions
        WHERE committed_checkpoint->>'stripe_account_id' = $1
        LIMIT 1`,
      [accountId],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw brainError("auth_tenant_mismatch", "Stripe account not registered to any tenant", {
        details: { stripe_account_id: accountId },
      });
    }
    return row.tenant_id;
  };
}

/** Routes webhook tenant resolution by provider. */
export function createProviderTenantResolver(
  resolvers: Record<string, TenantResolver>,
): TenantResolver {
  return async (provider, body, headers) => {
    const resolver = resolvers[provider];
    if (resolver === undefined) {
      throw brainError("auth_tenant_mismatch", `no tenant resolver for provider: ${provider}`);
    }
    return resolver(provider, body, headers);
  };
}
