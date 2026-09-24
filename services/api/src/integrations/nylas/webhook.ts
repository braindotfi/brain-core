import { createHmac, timingSafeEqual } from "node:crypto";
import { brainError, withTenantScope } from "@brain/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";

export interface NylasWebhookDeps {
  readonly pool: Pool;
  readonly webhookSecret?: string;
}

export async function registerNylasWebhook(
  app: FastifyInstance,
  deps: NylasWebhookDeps,
): Promise<void> {
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.post(
    "/webhooks/nylas",
    async (
      request: FastifyRequest<{
        Body: Buffer;
        Querystring: { challenge?: string };
      }>,
      reply,
    ) => {
      if (typeof request.query.challenge === "string") {
        reply.status(200).send(request.query.challenge);
        return;
      }
      const body = request.body;
      const signature = request.headers["x-nylas-signature"];
      if (!Buffer.isBuffer(body) || typeof signature !== "string") {
        throw brainError("raw_webhook_signature_invalid", "invalid Nylas webhook payload", {
          statusOverride: 401,
        });
      }
      if (!verifyNylasSignature(body, signature, deps.webhookSecret)) {
        throw brainError("raw_webhook_signature_invalid", "invalid Nylas webhook signature", {
          statusOverride: 401,
        });
      }
      const event = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      await handleNylasWebhookEvent(deps.pool, event);
      reply.status(200);
      return { ok: true };
    },
  );
}

export function verifyNylasSignature(
  body: Buffer,
  signature: string,
  secret: string | undefined,
): boolean {
  if (secret === undefined || secret.length === 0) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const actual = signature.startsWith("v1=") ? signature.slice(3) : signature;
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  return (
    expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

export async function handleNylasWebhookEvent(
  pool: Pool,
  event: Record<string, unknown>,
): Promise<void> {
  const type = readString(event["type"]) || readString(event["event"]);
  const data = readObject(event["data"]) ?? readObject(event["object"]) ?? {};
  const grantId = readString(data["grant_id"]) || readString(event["grant_id"]);
  if (grantId.length === 0) return;
  const status = statusFor(type);
  if (status === null) return;
  const threadId = readString(data["thread_id"]);
  const messageId = readString(data["id"]) || readString(data["message_id"]);
  await updateDeliveryStatus(pool, grantId, status, { threadId, messageId });
}

async function updateDeliveryStatus(
  pool: Pool,
  grantId: string,
  status: "opened" | "replied" | "bounced",
  refs: { threadId: string; messageId: string },
): Promise<void> {
  const tenant = await tenantForGrant(pool, grantId);
  if (tenant === null) return;
  await withTenantScope(pool, tenant, async (client) => {
    const clauses = ["delivery_status = $1"];
    const values: unknown[] = [status];
    if (refs.threadId.length > 0) {
      values.push(refs.threadId);
      clauses.push(`sent_thread_id = COALESCE(sent_thread_id, $${values.length})`);
    }
    if (refs.messageId.length > 0) {
      values.push(refs.messageId);
      clauses.push(`sent_message_id = COALESCE(sent_message_id, $${values.length})`);
    }
    const filters = [
      "tenant_id = current_setting('app.tenant_id', true)",
      "delivery_status IS DISTINCT FROM $1",
    ];
    if (refs.threadId.length > 0) {
      values.push(refs.threadId);
      filters.push(`sent_thread_id = $${values.length}`);
    } else if (refs.messageId.length > 0) {
      values.push(refs.messageId);
      filters.push(`sent_message_id = $${values.length}`);
    }
    await client.query(
      `UPDATE proposals
          SET ${clauses.join(", ")}
        WHERE ${filters.join(" AND ")}`,
      values,
    );
  });
}

async function tenantForGrant(pool: Pool, grantId: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ tenant_id: string }>(
      `SELECT tenant_id
         FROM nylas_grants
        WHERE grant_id = $1
          AND disconnected_at IS NULL
        LIMIT 1`,
      [grantId],
    );
    return rows[0]?.tenant_id ?? null;
  } finally {
    client.release();
  }
}

function statusFor(type: string): "opened" | "replied" | "bounced" | null {
  if (type === "message.created") return "replied";
  if (type === "message.bounce_detected") return "bounced";
  if (type === "message.updated") return "opened";
  return null;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
