/**
 * H-20 outbound webhook dead-letter queue.
 *
 * Makes failed webhook deliveries durable (they were previously logged + lost)
 * and bounds retries. Each (endpoint, event) failure upserts one row with an
 * attempt_count; a successful (re)delivery clears it. Once attempt_count hits
 * MAX_WEBHOOK_DELIVERY_ATTEMPTS the row is "exhausted" — replay no longer
 * auto-retries it (manual ops intervention).
 *
 * Repo lives in @brain/shared because the dispatcher (also shared) writes it;
 * the table migration + the management routes live in @brain/audit, co-located
 * with webhook_endpoints. All calls run under a tenant scope (RLS).
 */

import { newWebhookDeadLetterId } from "../ids.js";
import type { TenantScopedClient } from "../db/tenant-scoped.js";

/** Replay stops auto-retrying a dead-letter after this many failed attempts. */
export const MAX_WEBHOOK_DELIVERY_ATTEMPTS = 5;

export interface WebhookDeadLetterRow {
  id: string;
  tenant_id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  last_error: string | null;
  attempt_count: number;
  created_at: Date;
  last_attempt_at: Date;
}

export interface RecordDeliveryFailureInput {
  tenantId: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  error: string;
}

/**
 * Upsert a delivery failure: insert a new dead-letter or bump attempt_count +
 * last_error on the existing (tenant, endpoint, event) row.
 */
export async function recordDeliveryFailure(
  c: TenantScopedClient,
  input: RecordDeliveryFailureInput,
): Promise<void> {
  await c.query(
    `INSERT INTO webhook_dead_letters
       (id, tenant_id, endpoint_id, event_id, event_type, payload, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, endpoint_id, event_id) DO UPDATE
       SET attempt_count = webhook_dead_letters.attempt_count + 1,
           last_error = EXCLUDED.last_error,
           last_attempt_at = now()`,
    [
      newWebhookDeadLetterId(),
      input.tenantId,
      input.endpointId,
      input.eventId,
      input.eventType,
      JSON.stringify(input.payload),
      input.error,
    ],
  );
}

/** A delivery succeeded — clear any dead-letter for that (endpoint, event). */
export async function clearDeadLetter(
  c: TenantScopedClient,
  endpointId: string,
  eventId: string,
): Promise<void> {
  await c.query(`DELETE FROM webhook_dead_letters WHERE endpoint_id = $1 AND event_id = $2`, [
    endpointId,
    eventId,
  ]);
}

/** List dead-letters for an endpoint (newest first). */
export async function listDeadLetters(
  c: TenantScopedClient,
  endpointId: string,
): Promise<WebhookDeadLetterRow[]> {
  const { rows } = await c.query<WebhookDeadLetterRow>(
    `SELECT * FROM webhook_dead_letters WHERE endpoint_id = $1 ORDER BY created_at DESC`,
    [endpointId],
  );
  return rows;
}

/** Dead-letters for an endpoint still eligible for replay (under the cap). */
export async function getReplayableDeadLetters(
  c: TenantScopedClient,
  endpointId: string,
): Promise<WebhookDeadLetterRow[]> {
  const { rows } = await c.query<WebhookDeadLetterRow>(
    `SELECT * FROM webhook_dead_letters
      WHERE endpoint_id = $1 AND attempt_count < $2
      ORDER BY created_at ASC`,
    [endpointId, MAX_WEBHOOK_DELIVERY_ATTEMPTS],
  );
  return rows;
}

export async function deleteDeadLetterById(c: TenantScopedClient, id: string): Promise<void> {
  await c.query(`DELETE FROM webhook_dead_letters WHERE id = $1`, [id]);
}

export async function incrementDeadLetterAttempt(
  c: TenantScopedClient,
  id: string,
  error: string,
): Promise<void> {
  await c.query(
    `UPDATE webhook_dead_letters
        SET attempt_count = attempt_count + 1, last_error = $2, last_attempt_at = now()
      WHERE id = $1`,
    [id, error],
  );
}
