/**
 * POST /v1/demo/provision-run/:tenantId/anchor — server-side anchor trigger
 * for the BrainSaaS "Brain Playground".
 *
 * After a demo run completes, the playground SERVER (never the browser) calls
 * this to anchor that run's audit log on-chain immediately, instead of waiting
 * for the hourly background publisher.
 *
 * Auth posture: the same shared X-Demo-Provision-Auth secret as provision-run,
 * NOT an audit:admin token scope. Batch-10 C-1 deliberately strips audit:admin
 * (and payment_intent:execute) from the provision-run token so a leaked browser
 * JWT cannot drain or tamper a fresh tenant. Anchoring is therefore exposed only
 * behind the operator secret, which lives solely in the playground's server
 * process and never reaches the browser. The blast radius is one demo tenant's
 * already-sealed, append-only audit log: a read-then-prove operation strictly
 * weaker than the execute scope C-1 protects. It can neither move money nor
 * mutate the ledger.
 *
 * Isolation: the injected `publish` wraps publishAnchor over the RLS-enforced
 * app pool (NOT a BYPASSRLS pool). publishAnchor uses withTenantScope(tenantId)
 * internally, which sets app.tenant_id and lets RLS scope the audit_events read
 * to exactly this tenant, so the path param alone bounds the blast radius to
 * that single tenant. (A BYPASSRLS pool would defeat that scoping and anchor
 * every tenant's events under this one demo tenant.)
 */

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PublishOptions } from "@brain/audit";

/**
 * Structural subset of the audit `AuditAnchorRow` we serialize. Declared here
 * so the route module does not depend on the audit repository's internal row
 * type (which is not part of the @brain/audit public surface).
 */
export interface AnchorPublishResult {
  id: string;
  merkle_root: Buffer;
  event_count: number;
  onchain_tx_hash: Buffer | null;
  onchain_status: string;
}

/**
 * Anchors a tenant's recent audit events and returns the resulting row, or
 * null when the tenant has no events in the window. Injected so tests can run
 * without a live DB / RPC; main.ts binds it to
 * `publishAnchor(privilegedPool, broadcaster, ...)`.
 */
export type AnchorPublishFn = (input: PublishOptions) => Promise<AnchorPublishResult | null>;

export interface DemoProvisionAnchorRouteDeps {
  /** Shared operator secret (= BRAIN_DEMO_PROVISION_SECRET). */
  provisionSecret: string;
  /**
   * The anchor implementation, or undefined when the on-chain broadcaster is
   * unconfigured (e.g. a dev stack with no AUDIT_PUBLISHER_KEY) — the route
   * then answers 503 rather than failing deep in the publisher.
   */
  publish: AnchorPublishFn | undefined;
  /** Per-tenant cooldown window. Defaults to 60s (mirrors /audit/anchor/publish). */
  cooldownMs?: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;

function errorEnvelope(
  code: string,
  message: string,
  requestId: string | null,
): {
  error: { code: string; message: string; request_id: string | null; docs_url: string };
} {
  return {
    error: {
      code,
      message,
      request_id: requestId,
      docs_url: "https://docs.brain.fi/build/playground",
    },
  };
}

export async function registerDemoProvisionAnchorRoute(
  app: FastifyInstance,
  deps: DemoProvisionAnchorRouteDeps,
): Promise<void> {
  const cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  // Persists across requests via this closure (one registration per boot),
  // exactly like the lastPublishTime map in the /audit/anchor/publish route.
  const cooldown = new Map<string, number>();

  app.post<{ Params: { tenantId: string } }>(
    "/demo/provision-run/:tenantId/anchor",
    { config: { skipAuth: true, rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const requestId = req.id ?? null;

      // Constant-time shared-secret check (same as provision-run) so request
      // timing never leaks the secret a byte at a time.
      const headerRaw = req.headers["x-demo-provision-auth"];
      const provided = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
      const expectedBuf = Buffer.from(deps.provisionSecret, "utf8");
      const providedBuf = Buffer.from(provided ?? "", "utf8");
      const authOk =
        providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
      if (!authOk) {
        reply.status(401);
        return errorEnvelope(
          "auth_header_invalid",
          "X-Demo-Provision-Auth header missing or does not match BRAIN_DEMO_PROVISION_SECRET",
          requestId,
        );
      }

      const tenantId = req.params.tenantId;
      if (!tenantId.startsWith("tnt_")) {
        reply.status(400);
        return errorEnvelope("auth_tenant_mismatch", "malformed tenant id", requestId);
      }

      if (deps.publish === undefined) {
        reply.status(503);
        return errorEnvelope(
          "audit_anchor_unavailable",
          "on-chain anchor broadcaster is not configured",
          requestId,
        );
      }

      // Per-tenant cooldown — prevents rapid re-anchoring and runaway on-chain
      // spend. Stamp before the await so concurrent calls cannot race past it.
      const lastRun = cooldown.get(tenantId) ?? 0;
      const msUntilReady = lastRun + cooldownMs - Date.now();
      if (msUntilReady > 0) {
        const retryAfter = Math.ceil(msUntilReady / 1000);
        reply.status(429);
        return {
          error: {
            code: "rate_limited",
            message: `anchor cooling down, retry in ${retryAfter}s`,
            details: { retry_after_seconds: retryAfter },
            request_id: requestId,
            docs_url: "https://docs.brain.fi/build/playground",
          },
        };
      }
      cooldown.set(tenantId, Date.now());

      // Anchor the tenant's last 24h of audit events (covers a fresh demo
      // tenant whose run just finished).
      const now = new Date();
      const periodStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      let anchor: AnchorPublishResult | null;
      try {
        anchor = await deps.publish({ tenantId, periodStart, periodEnd: now });
      } catch (err) {
        // A transient broadcast/RPC failure should not poison the cooldown:
        // let the caller retry immediately.
        cooldown.delete(tenantId);
        throw err;
      }
      if (anchor === null) {
        reply.status(404);
        return errorEnvelope(
          "audit_no_events",
          "no audit events in the last 24 hours for this tenant",
          requestId,
        );
      }

      reply.status(200);
      const txHashHex = anchor.onchain_tx_hash?.toString("hex") ?? null;
      return {
        id: anchor.id,
        merkle_root: anchor.merkle_root.toString("hex"),
        event_count: anchor.event_count,
        tx_hash: txHashHex,
        basescan_url: txHashHex !== null ? `https://sepolia.basescan.org/tx/0x${txHashHex}` : null,
        onchain_status: anchor.onchain_status,
      };
    },
  );
}
