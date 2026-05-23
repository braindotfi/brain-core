/**
 * Outbound webhook dispatcher — Brain → customer HTTP endpoints.
 *
 * The dispatcher is called fire-and-forget after each `AuditEmitter.emit()`
 * for the nine forwarded event types. It queries the tenant's registered
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

/** The nine audit action types forwarded to registered endpoints. */
export const FORWARDED_EVENTS = new Set<string>([
  "payment_intent.created",
  "payment_intent.approved",
  "payment_intent.rejected",
  "payment_intent.execute.after",
  "ledger.counterparty.created",
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

    const payload = JSON.stringify({
      id: event.id,
      type: event.action,
      tenant_id: event.tenantId,
      created_at: event.createdAt,
      data: { inputs: event.inputs, outputs: event.outputs },
    });

    await Promise.allSettled(
      endpoints
        .filter((ep) => ep.enabled_events === null || ep.enabled_events.includes(event.action))
        .map(async (ep) => {
          // SSRF guard: never POST to a private/internal/metadata address even
          // if a tenant registered one as a webhook endpoint.
          if (!(await isPublicUrl(ep.url, { allowedProtocols: ["http:", "https:"] }))) {
            console.warn(`[webhooks] skipping endpoint ${ep.id}: url is not a public address`);
            return;
          }
          const sig = sign(ep.secret, payload);
          try {
            const res = await fetch(ep.url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Brain-Signature": `sha256=${sig}`,
              },
              body: payload,
              signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) {
              console.warn(`[webhooks] endpoint ${ep.id} returned HTTP ${res.status}`);
            }
          } catch {
            console.warn(`[webhooks] delivery failed to endpoint ${ep.id}`);
          }
        }),
    );
  }
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
