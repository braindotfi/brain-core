/**
 * Outbound webhook dispatcher — Brain → customer HTTP endpoints.
 *
 * The dispatcher is called fire-and-forget after each `AuditEmitter.emit()`
 * for the forwarded event types. It queries the tenant's registered
 * `webhook_endpoints`, signs the payload with HMAC-SHA256, and POSTs.
 *
 * Delivery is best-effort for MVP (no retry queue). Failures are logged at
 * warn level and do not propagate to the caller — the audit event is always
 * written regardless of webhook delivery.
 *
 * Payload shape (same for all events):
 *   {
 *     id:         string,    // evt_... audit event id
 *     type:       string,    // e.g. "payment_intent.created"
 *     tenant_id:  string,
 *     created_at: string,    // ISO-8601
 *     data: { inputs, outputs }
 *   }
 *
 * Signature header: `Brain-Signature: sha256=<hex>`
 * Computed over the serialized JSON body with the endpoint's HMAC key.
 */

import { createHmac, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { AuditEmitter } from "../audit/emitter.js";
import type { AuditEvent, AuditEventInput } from "../audit/types.js";
import { isPublicUrl } from "../net/ssrf.js";
import { clearDeadLetter, recordDeliveryFailure } from "./dead-letters.js";

/** Audit action types forwarded to registered endpoints. */
export const FORWARDED_EVENTS = new Set<string>([
  "payment_intent.created",
  "payment_intent.approved",
  "payment_intent.awaiting_second_approval",
  "proposal.awaiting_second_approval",
  "payment_intent.rejected",
  "member.changed",
  "payment_intent.execute.after",
  "ledger.counterparty.created",
  "ledger.counterparty.updated",
  "ledger.transaction.created",
  "ledger.obligation.created",
  "policy.evaluate",
  "raw.ingest.completed",
]);

interface EndpointRow {
  id: string;
  url: string;
  secret: string;
  enabled_events: string[] | null;
}

/** Signs body with HMAC-SHA256 and returns the hex digest. */
function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Deliver one signed payload to one endpoint. Returns {ok} or {ok:false, error}
 * — never throws. Shared by the live dispatch path and the dead-letter replay
 * route (H-20). Enforces the SSRF guard (no private/internal/metadata targets).
 */
export async function deliverWebhook(
  endpoint: { url: string; secret: string },
  payload: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await isPublicUrl(endpoint.url, { allowedProtocols: ["http:", "https:"] }))) {
    return { ok: false, error: "url is not a public address" };
  }
  const sig = sign(endpoint.secret, payload);
  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Brain-Signature": `sha256=${sig}` },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "delivery failed" };
  }
}

export class WebhookDispatcher {
  public constructor(private readonly pool: Pool) {}

  public async dispatch(event: AuditEvent): Promise<void> {
    if (!FORWARDED_EVENTS.has(event.action)) return;

    let endpoints: EndpointRow[];
    try {
      const client = await this.pool.connect();
      try {
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [event.tenantId]);
        const result = await client.query<EndpointRow>(
          `SELECT id, url, secret, enabled_events
             FROM webhook_endpoints
            WHERE tenant_id = $1 AND enabled = true`,
          [event.tenantId],
        );
        endpoints = result.rows;
      } finally {
        client.release();
      }
    } catch {
      console.warn("[webhooks] failed to query endpoints for tenant", event.tenantId);
      return;
    }

    const payloadObj = {
      id: event.id,
      type: event.action,
      tenant_id: event.tenantId,
      created_at: event.createdAt,
      data: { inputs: event.inputs, outputs: event.outputs },
    };
    const payload = JSON.stringify(payloadObj);

    const targets = endpoints.filter(
      (ep) => ep.enabled_events === null || ep.enabled_events.includes(event.action),
    );

    // Deliver to every target, collecting per-endpoint outcomes.
    const outcomes = await Promise.all(
      targets.map(async (ep) => ({ ep, result: await deliverWebhook(ep, payload) })),
    );

    // H-20: persist failures to the dead-letter queue (and clear any prior
    // dead-letter on success) so failed deliveries are durable + replayable
    // instead of vanishing into a log line. Best-effort: a dead-letter write
    // failure must not surface to the audit-emit caller.
    if (outcomes.length > 0) {
      try {
        const client = await this.pool.connect();
        try {
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [event.tenantId]);
          const scoped = client as unknown as TenantScopedLike;
          for (const { ep, result } of outcomes) {
            if (result.ok) {
              await clearDeadLetter(scoped, ep.id, event.id);
            } else {
              console.warn(`[webhooks] delivery failed to endpoint ${ep.id}: ${result.error}`);
              await recordDeliveryFailure(scoped, {
                tenantId: event.tenantId,
                endpointId: ep.id,
                eventId: event.id,
                eventType: event.action,
                payload: payloadObj,
                error: result.error ?? "delivery failed",
              });
            }
          }
        } finally {
          client.release();
        }
      } catch (err) {
        console.warn("[webhooks] failed to record dead-letters", err);
      }
    }
  }
}

/** Minimal query surface the dead-letter repo needs from a raw pg client. */
interface TenantScopedLike {
  query<T = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

/**
 * Wraps any AuditEmitter and dispatches outbound webhooks after each emit.
 * Fire-and-forget: dispatch failures never surface to the caller.
 */
export class WebhookAuditEmitter implements AuditEmitter {
  public constructor(
    private readonly inner: AuditEmitter,
    private readonly dispatcher: WebhookDispatcher,
  ) {}

  public async emit(event: AuditEventInput): Promise<AuditEvent> {
    const result = await this.inner.emit(event);
    setImmediate(() => {
      this.dispatcher.dispatch(result).catch((err: unknown) => {
        console.warn("[webhooks] dispatch threw unexpectedly", err);
      });
    });
    return result;
  }
}

/** Generate a cryptographically random HMAC key (32 bytes, hex-encoded). */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}
