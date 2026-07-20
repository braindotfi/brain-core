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

/**
 * Exponential backoff schedule used by the dispatch worker (item 13): the wait
 * BEFORE the next retry given the current `attempt_count` of a DLQ row.
 *
 *   attempt_count = 1 → 30s, 2 → 60s, 3 → 120s, 4 → 240s, ≥5 → 480s (cap).
 *
 * Computed in TS for the schedule and mirrored in SQL by getDueDeadLetters.
 */
export function nextAttemptDelaySeconds(attemptCount: number): number {
  const base = 30;
  const cap = 480;
  const shift = Math.max(0, attemptCount - 1);
  return Math.min(base * 2 ** shift, cap);
}

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

export interface RecordDeliverySuccessInput {
  tenantId: string;
  endpointId: string;
  eventId: string;
  eventType: string;
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

/** A delivery succeeded. Persist a receipt so reconcile scans do not resend forever. */
export async function recordDeliverySuccess(
  c: TenantScopedClient,
  input: RecordDeliverySuccessInput,
): Promise<void> {
  await c.query(
    `INSERT INTO webhook_delivery_receipts
       (tenant_id, endpoint_id, event_id, event_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, endpoint_id, event_id) DO UPDATE
       SET event_type = EXCLUDED.event_type,
           delivered_at = now()`,
    [input.tenantId, input.endpointId, input.eventId, input.eventType],
  );
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

/** Row shape returned by the cross-tenant due-rows scan. */
export interface DueDeadLetter {
  id: string;
  tenant_id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  last_error: string | null;
  last_attempt_at: Date;
}

export interface UndeliveredWebhookEvent {
  tenant_id: string;
  endpoint_id: string;
  endpoint_url: string;
  endpoint_secret: string;
  event_id: string;
  event_type: string;
  created_at: Date;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
}

/** Minimal query surface the cross-tenant scan needs (a raw pg client). */
export interface RawQueryClient {
  query<T = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

/**
 * Cross-tenant scan (item 13): DLQ rows still under the retry cap whose
 * backoff window has elapsed. The SQL mirrors {@link nextAttemptDelaySeconds}.
 *
 * Caller must run under BYPASSRLS (or owner) — this is a worker scan, not a
 * tenant-scoped query. Same posture as the normalize worker (see
 * services/ledger/src/workers/normalizeWorker.ts).
 */
export async function getDueDeadLetters(
  c: RawQueryClient,
  maxAttempts: number,
  limit: number,
): Promise<DueDeadLetter[]> {
  const { rows } = await c.query<DueDeadLetter>(
    `SELECT id, tenant_id, endpoint_id, event_id, event_type, payload,
            attempt_count, last_error, last_attempt_at
       FROM webhook_dead_letters
      WHERE attempt_count < $1
        AND last_attempt_at + (LEAST(30 * power(2, attempt_count - 1), 480) || ' seconds')::interval <= now()
      ORDER BY last_attempt_at ASC
      LIMIT $2`,
    [maxAttempts, limit],
  );
  return rows;
}

/**
 * Cross-tenant durability backstop. Finds forwarded audit events for active
 * endpoints that have neither a success receipt nor a dead-letter row.
 */
export async function getUndeliveredWebhookEvents(
  c: RawQueryClient,
  eventTypes: readonly string[],
  limit: number,
  opts: { graceMs: number; lookbackMs: number },
): Promise<UndeliveredWebhookEvent[]> {
  if (eventTypes.length === 0) return [];
  const { rows } = await c.query<UndeliveredWebhookEvent>(
    `SELECT e.tenant_id,
            ep.id AS endpoint_id,
            ep.url AS endpoint_url,
            ep.secret AS endpoint_secret,
            e.id AS event_id,
            e.action AS event_type,
            e.created_at,
            e.inputs,
            e.outputs
       FROM audit_events e
       JOIN webhook_endpoints ep
         ON ep.tenant_id = e.tenant_id
        AND ep.enabled = true
        AND (ep.enabled_events IS NULL OR e.action = ANY(ep.enabled_events))
       LEFT JOIN webhook_delivery_receipts r
         ON r.tenant_id = e.tenant_id
        AND r.endpoint_id = ep.id
        AND r.event_id = e.id
       LEFT JOIN webhook_dead_letters dl
         ON dl.tenant_id = e.tenant_id
        AND dl.endpoint_id = ep.id
        AND dl.event_id = e.id
      WHERE e.action = ANY($1::text[])
        AND e.created_at <= now() - ($3::text || ' milliseconds')::interval
        AND e.created_at >= now() - ($4::text || ' milliseconds')::interval
        AND r.event_id IS NULL
        AND dl.event_id IS NULL
      ORDER BY e.created_at ASC, e.id ASC, ep.id ASC
      LIMIT $2`,
    [eventTypes, limit, opts.graceMs, opts.lookbackMs],
  );
  return rows;
}
