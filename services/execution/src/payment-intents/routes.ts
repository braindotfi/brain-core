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
} from "@brain/api/shared";
import type { PaymentIntentService } from "./PaymentIntentService.js";

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
]);

export async function registerPaymentIntentRoutes(
  app: FastifyInstance,
  service: PaymentIntentService,
): Promise<void> {
  app.post("/payment-intents", async (request: FastifyRequest<{ Body: CreateBody }>, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, SCOPE_PROPOSE);
    const b = request.body ?? {};
    if (
      b.action_type === undefined ||
      !ACTION_TYPES.has(b.action_type) ||
      b.source_account_id === undefined ||
      !isBrainId(b.source_account_id, "acct") ||
      b.destination_counterparty_id === undefined ||
      !isBrainId(b.destination_counterparty_id, "cp") ||
      b.amount === undefined ||
      b.currency === undefined ||
      !/^[A-Z]{3}$/.test(b.currency)
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
  });

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
