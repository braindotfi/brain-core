/**
 * Webhook endpoint repository — CRUD against `webhook_endpoints`.
 * Callers must be inside a withTenantScope transaction.
 */

import type { TenantScopedClient } from "@brain/shared";

export interface WebhookEndpointRow {
  id: string;
  tenant_id: string;
  url: string;
  secret: string;
  enabled_events: string[] | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function insertWebhookEndpoint(
  c: TenantScopedClient,
  row: Pick<WebhookEndpointRow, "id" | "tenant_id" | "url" | "secret" | "enabled_events">,
): Promise<WebhookEndpointRow> {
  const result = await c.query<WebhookEndpointRow>(
    `INSERT INTO webhook_endpoints (id, tenant_id, url, secret, enabled_events)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [row.id, row.tenant_id, row.url, row.secret, row.enabled_events ?? null],
  );
  return result.rows[0]!;
}

export async function findWebhookEndpoint(
  c: TenantScopedClient,
  id: string,
): Promise<WebhookEndpointRow | null> {
  const result = await c.query<WebhookEndpointRow>(
    `SELECT * FROM webhook_endpoints WHERE id = $1 LIMIT 1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function listWebhookEndpoints(c: TenantScopedClient): Promise<WebhookEndpointRow[]> {
  const result = await c.query<WebhookEndpointRow>(
    `SELECT * FROM webhook_endpoints ORDER BY created_at DESC`,
  );
  return result.rows;
}

export async function deleteWebhookEndpoint(c: TenantScopedClient, id: string): Promise<boolean> {
  const result = await c.query(`DELETE FROM webhook_endpoints WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}
