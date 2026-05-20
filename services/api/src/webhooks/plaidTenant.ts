/**
 * Plaid webhook tenant resolver.
 *
 * Maps a Plaid `item_id` (present in every Plaid webhook body) to the
 * Brain `tenant_id` that owns the corresponding Plaid source connection.
 * The mapping is stored in `raw_plaid_items` (migration 0003).
 *
 * Tenant resolution uses a cross-tenant direct pool query (no RLS) — the
 * item_id lookup is a public lookup needed *before* we know the tenant.
 * Subsequent ingest operations run through `withTenantScope`.
 */

import type { Pool } from "pg";
import { brainError } from "@brain/shared";

interface PlaidWebhookEnvelope {
  item_id?: string;
}

type TenantResolver = (
  provider: string,
  body: Buffer,
  headers: Record<string, unknown>,
) => Promise<string>;

export function createPlaidTenantResolver(pool: Pool): TenantResolver {
  return async function resolvePlaidTenant(provider: string, body: Buffer): Promise<string> {
    if (provider !== "plaid") {
      throw brainError("auth_tenant_mismatch", `no tenant resolver for provider: ${provider}`);
    }

    let parsed: PlaidWebhookEnvelope;
    try {
      parsed = JSON.parse(body.toString("utf8")) as PlaidWebhookEnvelope;
    } catch {
      throw brainError("request_body_invalid", "Plaid webhook body is not valid JSON");
    }

    const itemId = parsed.item_id;
    if (typeof itemId !== "string" || itemId.length === 0) {
      throw brainError("request_body_invalid", "Plaid webhook body missing item_id");
    }

    const result = await pool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM raw_plaid_items WHERE item_id = $1 AND active = TRUE LIMIT 1",
      [itemId],
    );

    if (result.rows.length === 0 || result.rows[0] === undefined) {
      throw brainError("auth_tenant_mismatch", "Plaid item_id not registered to any tenant", {
        details: { item_id: itemId },
      });
    }

    return result.rows[0].tenant_id;
  };
}
