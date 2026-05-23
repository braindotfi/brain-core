/**
 * POST /raw/webhooks/{provider}
 *
 * skipAuth (§3.1 exception — HMAC-signed, not bearer). Plaid signature
 * verified via the shared primitive; other providers return 501 until
 * their sig schemes are wired.
 *
 * A verified webhook produces one or more artifacts through the source
 * adapter, each persisted via the ingest orchestrator.
 */

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  verifyPlaidWebhook,
  type IdempotencyStore,
  type PlaidVerifyOptions,
} from "@brain/shared";
import { adapterForWebhookProvider } from "../adapters/registry.js";
import { ingestMany } from "../services/ingest.js";
import type { RawDeps } from "../deps.js";

/**
 * §5.2 webhook idempotency. Providers retry by re-delivering the identical
 * signed body, so a content hash is a stable per-event dedup key. Returns true
 * if this body was already accepted (a replay), else marks it in-flight so a
 * concurrent/subsequent re-delivery short-circuits. The mark carries a TTL, so
 * a crashed delivery eventually frees up; releaseWebhook frees it immediately
 * on a processing failure so the provider's retry can get through.
 */
function webhookDedupKey(provider: string, raw: Buffer): { key: string; hash: string } {
  const hash = createHash("sha256").update(raw).digest("hex");
  return { key: `webhook:${provider}:${hash}`, hash };
}

export async function markWebhookSeen(
  store: IdempotencyStore,
  tenantId: string,
  provider: string,
  raw: Buffer,
  ttlSeconds: number,
): Promise<boolean> {
  const { key, hash } = webhookDedupKey(provider, raw);
  const probe = await store.probeAndMark({ tenantId, key, bodyHash: hash, ttlSeconds });
  return probe.state !== "miss";
}

export async function releaseWebhook(
  store: IdempotencyStore,
  tenantId: string,
  provider: string,
  raw: Buffer,
): Promise<void> {
  const { key } = webhookDedupKey(provider, raw);
  await store.discard({ tenantId, key });
}

/**
 * The tenant that a webhook corresponds to is derived from provider-specific
 * mapping — for Plaid: from `item_id` lookup against the Plaid Items table
 * that will land in stage-3 when extractors are built. For stage-2 we
 * require the tenant to be supplied via a signed query param or header, or
 * we use a dev-only header. The mapping helper is injected for testability.
 */
export type WebhookTenantResolver = (
  provider: string,
  body: Buffer,
  headers: Record<string, unknown>,
) => Promise<string>;

export interface WebhookRouteOptions {
  plaidVerify: PlaidVerifyOptions;
  resolveTenant: WebhookTenantResolver;
  /** When set, dedup re-delivered webhooks by body hash (§5.2). */
  dedupStore?: IdempotencyStore;
  /** TTL for the dedup marker in seconds. Default 24h. */
  dedupTtlSeconds?: number;
}

export async function registerWebhook(
  app: FastifyInstance,
  deps: RawDeps,
  opts: WebhookRouteOptions,
): Promise<void> {
  app.post(
    "/raw/webhooks/:provider",
    {
      config: { skipAuth: true },
      // The body must stay as a raw Buffer for HMAC/JWT verification. We
      // register a content-type parser in server.ts that preserves bytes.
    },
    async (request: FastifyRequest<{ Params: { provider: string } }>, reply) => {
      const provider = request.params.provider;
      const raw = (request.body as Buffer | undefined) ?? Buffer.alloc(0);

      if (provider === "plaid") {
        const header = request.headers["plaid-verification"];
        if (typeof header !== "string") {
          throw brainError("raw_webhook_signature_invalid", "missing Plaid-Verification header");
        }
        await verifyPlaidWebhook(raw, header, opts.plaidVerify);
      } else {
        throw brainError(
          "raw_source_unsupported",
          `webhook signature scheme for '${provider}' is not implemented yet`,
          { statusOverride: 501 },
        );
      }

      const adapter = adapterForWebhookProvider(provider);
      if (adapter.handleWebhook === undefined) {
        throw brainError(
          "raw_source_unsupported",
          `adapter '${adapter.sourceType}' has no webhook handler`,
          { statusOverride: 501 },
        );
      }

      const tenantId = await opts.resolveTenant(provider, raw, request.headers);

      // §5.2 — short-circuit a re-delivered (identical) webhook.
      const ttl = opts.dedupTtlSeconds ?? 86_400;
      if (opts.dedupStore !== undefined) {
        const replay = await markWebhookSeen(opts.dedupStore, tenantId, provider, raw, ttl);
        if (replay) {
          reply.status(202);
          reply.header("idempotent-replay", "true");
          return { accepted: true, trace_id: request.id, artifacts: 0 };
        }
      }

      try {
        const artifacts = await adapter.handleWebhook(
          tenantId,
          raw,
          request.headers as Record<string, unknown>,
        );
        const inputs = artifacts.map((a) => ({
          tenantId,
          actor: `partner_${provider}`,
          sourceType: adapter.sourceType,
          sourceRef: a.sourceRef,
          body: a.body,
          mimeType: a.mimeType,
        }));
        const results = await ingestMany(deps, inputs);

        reply.status(202);
        return { accepted: true, trace_id: request.id, artifacts: results.length };
      } catch (err) {
        // Free the dedup marker so the provider's retry can be processed.
        if (opts.dedupStore !== undefined) {
          await releaseWebhook(opts.dedupStore, tenantId, provider, raw);
        }
        throw err;
      }
    },
  );
}
