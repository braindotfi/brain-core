/**
 * /payment-intents/* HTTP routes.
 *
 * Maps the OpenAPI §PaymentIntent group to the PaymentIntentService.
 *
 *   POST /payment-intents             create an intent (with PolicyDecision attached)
 *   GET  /payment-intents/{id}        fetch detail
 *   POST /payment-intents/{id}/approve   sign approval, transition if quorum met
 *   POST /payment-intents/{id}/reject    reject from any non-terminal state
 *   POST /payment-intents/{id}/execute   run §6 gate + dispatch rail
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  isBrainId,
  requireScope,
  type Scope,
  type ServiceCallContext,
} from "@brain/shared";
import type { PaymentIntentService } from "./PaymentIntentService.js";
import type { ResolvedInvoiceShortcut } from "./invoice-shortcut.js";

/** P0.5: resolves the `pay_invoice` shortcut into a full create payload. */
export type InvoiceShortcutResolver = (
  ctx: ServiceCallContext,
  invoiceId: string,
) => Promise<ResolvedInvoiceShortcut>;

const SCOPE_PROPOSE: Scope = "payment_intent:propose";
const SCOPE_APPROVE: Scope = "payment_intent:approve";
const SCOPE_EXECUTE: Scope = "payment_intent:execute";
const SCOPE_READ: Scope = "execution:read";

function assertCtx(request: FastifyRequest): ServiceCallContext {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  return {
    tenantId: request.principal.tenantId,
    actor: request.principal.id,
    requestId: request.id,
    principalType: request.principal.type,
    scopes: request.principal.scopes,
  };
}

interface CreateBody {
  /** P0.5: "pay_invoice" selects the invoice shortcut form. */
  type?: string;
  action_type?: string;
  source_account_id?: string;
  destination_counterparty_id?: string;
  amount?: string;
  currency?: string;
  obligation_id?: string;
  invoice_id?: string;
  agent_id?: string;
  evidence_ids?: string[];
}

const ACTION_TYPES = new Set([
  "ach_outbound",
  "ach_inbound",
  "wire",
  "onchain_transfer",
  "erp_writeback",
  "card_payment",
  // x402 USDC-on-Base settlement (RFC 0001 §7.1). Shadow-first: accepting the
  // action type only makes the intent creatable + §6-gated; it cannot settle
  // until the commerce agent is in LIVE_AGENTS and an x402_base rail is
  // registered at boot (RailRegistry fails closed until then).
  "x402_settle",
]);

/** Whether `t` is an action type the create route accepts (exported for tests). */
export function isAcceptedActionType(t: string | undefined): boolean {
  return t !== undefined && ACTION_TYPES.has(t);
}

/**
 * Currency is ISO-4217-style (3 upper-case letters) for fiat rails. x402
 * settlements are denominated in USDC (D-4) — the lone 4-letter exception,
 * matched to the action type so fiat validation is not broadly loosened. The
 * gate re-checks `currency === settlement.asset === "USDC"` for x402 (§6.1).
 * Exported for unit tests (routes.ts itself is integration-tested).
 */
export function isValidCurrency(actionType: string | undefined, currency: string): boolean {
  if (actionType === "x402_settle") return currency === "USDC";
  return /^[A-Z]{3}$/.test(currency);
}

export async function registerPaymentIntentRoutes(
  app: FastifyInstance,
  service: PaymentIntentService,
  resolveShortcut?: InvoiceShortcutResolver,
): Promise<void> {
  app.post(
    "/payment-intents",
    { config: { idempotent: true } },
    async (request: FastifyRequest<{ Body: CreateBody }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_PROPOSE);
      const b = request.body ?? {};

      // P0.5 invoice shortcut: { type: "pay_invoice", invoice_id } resolves the
      // full body from the invoice. The resolver fails closed with a specific
      // invoice_shortcut_* code for each unresolved input.
      if (b.type === "pay_invoice") {
        if (resolveShortcut === undefined) {
          throw brainError("invoice_shortcut_invalid", "invoice shortcut is not enabled");
        }
        if (b.invoice_id === undefined) {
          throw brainError("invoice_shortcut_invalid", "invoice_id is required for pay_invoice");
        }
        const resolved = await resolveShortcut(ctx, b.invoice_id);
        const intent = await service.create(ctx, {
          action_type: resolved.action_type as never,
          source_account_id: resolved.source_account_id,
          destination_counterparty_id: resolved.destination_counterparty_id,
          amount: resolved.amount,
          currency: resolved.currency,
          invoice_id: b.invoice_id,
          evidence_ids: resolved.evidence_ids,
          ...(resolved.obligation_id !== undefined
            ? { obligation_id: resolved.obligation_id }
            : {}),
          ...(b.agent_id !== undefined ? { agent_id: b.agent_id } : {}),
        });
        reply.status(201);
        return intent;
      }

      if (
        !isAcceptedActionType(b.action_type) ||
        b.source_account_id === undefined ||
        !isBrainId(b.source_account_id, "acct") ||
        b.destination_counterparty_id === undefined ||
        !isBrainId(b.destination_counterparty_id, "cp") ||
        b.amount === undefined ||
        b.currency === undefined ||
        !isValidCurrency(b.action_type, b.currency)
      ) {
        throw brainError("request_body_invalid", "missing or malformed PaymentIntent fields");
      }
      const intent = await service.create(ctx, {
        action_type: b.action_type as never,
        source_account_id: b.source_account_id,
        destination_counterparty_id: b.destination_counterparty_id,
        amount: b.amount,
        currency: b.currency,
        ...(b.obligation_id !== undefined ? { obligation_id: b.obligation_id } : {}),
        ...(b.invoice_id !== undefined ? { invoice_id: b.invoice_id } : {}),
        ...(b.agent_id !== undefined ? { agent_id: b.agent_id } : {}),
        ...(b.evidence_ids !== undefined ? { evidence_ids: b.evidence_ids } : {}),
      });
      reply.status(201);
      return intent;
    },
  );

  app.get(
    "/payment-intents/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_READ);
      if (!isBrainId(request.params.id, "pi")) {
        throw brainError("request_params_invalid", "malformed payment_intent id");
      }
      const intent = await service.get(ctx, request.params.id);
      if (intent === null) {
        throw brainError("payment_intent_not_found", "no such PaymentIntent");
      }
      reply.status(200);
      return intent;
    },
  );

  app.post(
    "/payment-intents/:id/approve",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_APPROVE);
      if (!isBrainId(request.params.id, "pi")) {
        throw brainError("request_params_invalid", "malformed payment_intent id");
      }
      const intent = await service.approve(ctx, request.params.id);
      reply.status(200);
      return intent;
    },
  );

  app.post(
    "/payment-intents/:id/reject",
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: { reason?: string } }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_APPROVE);
      if (!isBrainId(request.params.id, "pi")) {
        throw brainError("request_params_invalid", "malformed payment_intent id");
      }
      const intent = await service.reject(ctx, request.params.id, request.body?.reason);
      reply.status(200);
      return intent;
    },
  );

  app.post(
    "/payment-intents/:id/execute",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_EXECUTE);
      if (!isBrainId(request.params.id, "pi")) {
        throw brainError("request_params_invalid", "malformed payment_intent id");
      }
      const result = await service.execute(ctx, request.params.id);
      reply.status(202);
      return result;
    },
  );

  // Kill-switch (1b.3): pause/resume an approved intent. Approve scope gates both
  // (an approver can hold/release); tenant-root is the operational owner.
  app.post(
    "/payment-intents/:id/pause",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_APPROVE);
      if (!isBrainId(request.params.id, "pi")) {
        throw brainError("request_params_invalid", "malformed payment_intent id");
      }
      const intent = await service.pause(ctx, request.params.id);
      reply.status(200);
      return intent;
    },
  );

  app.post(
    "/payment-intents/:id/resume",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_APPROVE);
      if (!isBrainId(request.params.id, "pi")) {
        throw brainError("request_params_invalid", "malformed payment_intent id");
      }
      const intent = await service.resume(ctx, request.params.id);
      reply.status(200);
      return intent;
    },
  );

  // GET /payment-intents/:id/replay-investigation — typed forensic record (2.4).
  app.get(
    "/payment-intents/:id/replay-investigation",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_READ);
      if (!isBrainId(request.params.id, "pi")) {
        throw brainError("request_params_invalid", "malformed payment_intent id");
      }
      const bundle = await service.replayInvestigation(ctx, request.params.id);
      reply.status(200);
      return bundle;
    },
  );

  // GET /agents/:agent_id/actions — spec §Agent listAgentActions
  app.get(
    "/agents/:agent_id/actions",
    async (
      request: FastifyRequest<{
        Params: { agent_id: string };
        Querystring: { limit?: string };
      }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_READ);
      const limit = parseIntParam(request.query.limit, 50, 500);
      const intents = await service.list(ctx, { agent_id: request.params.agent_id, limit });
      reply.status(200);
      return {
        actions: intents.map((i) => ({
          proposal_id: null,
          payment_intent_id: i.id,
          status: i.status,
          created_at: i.created_at,
        })),
      };
    },
  );
}

function parseIntParam(raw: string | undefined, defaultVal: number, max: number): number {
  if (raw === undefined) return defaultVal;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : defaultVal;
}
