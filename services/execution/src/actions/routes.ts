/**
 * /v1/actions/* HTTP routes.
 *
 * The v0.3 user-facing write-path for financial actions. Internally backed
 * by the existing PaymentIntentService (see docs/sdk-audit.md decision A);
 * this file is a thin translation layer that:
 *
 *   - accepts the docs body shape on `POST /actions`
 *   - emits the wire `Action` shape via `mapper.ts`
 *   - sets the RFC 8594 `Deprecation` header on the legacy
 *     `/payment-intents/*` routes (not here — see those routes)
 *
 *   POST   /actions                       create
 *   GET    /actions                       list
 *   GET    /actions/{action_id}           get
 *   DELETE /actions/{action_id}           cancel
 *   POST   /actions/{action_id}/approve   approve
 *   POST   /actions/{action_id}/reject    reject
 *   POST   /actions/{action_id}/execute   execute (runs §6 gate)
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  brainError,
  isBrainId,
  newInvoiceId,
  requireScope,
  withTenantScope,
  type Scope,
  type ServiceCallContext,
} from "@brain/shared";
import type { PaymentIntentService } from "../payment-intents/PaymentIntentService.js";
import { requirePaymentIntentApproveScope } from "../payment-intents/approve-scope.js";
import { paymentIntentToAction, type ActionStatus } from "./mapper.js";

const SCOPE_PROPOSE: Scope = "payment_intent:propose";
const SCOPE_EXECUTE: Scope = "payment_intent:execute";
const SCOPE_READ: Scope = "execution:read";
const SCOPE_ADMIN: Scope = "execution:admin";

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

function proposedAgentId(
  request: FastifyRequest,
  requestedAgentId: string | undefined,
): string | undefined {
  if (requestedAgentId !== undefined && request.principal!.scopes.includes(SCOPE_ADMIN)) {
    return requestedAgentId;
  }
  if (request.principal!.type === "agent") return request.principal!.id;
  return undefined;
}

interface CreateActionBody {
  type?: string;
  action_type?: string;
  agent_id?: string;
  invoiceId?: string;
  to?: { counterparty_id?: string };
  counterparty_id?: string;
  amount?: string;
  currency?: string;
  source_account_id?: string;
  description?: string;
  due_date?: string;
  memo?: string;
  evidence_ids?: string[];
}

interface ActionRouteOptions {
  pool?: Pool;
  invoiceLinkBaseUrl?: string;
}

// Free-form `type` → storage PaymentIntent action_type. Conservative
// set for v0.3; broader synonyms can be added without a contract bump.
const ACTION_TYPE_TO_PI_TYPE: Readonly<Record<string, string>> = {
  pay_invoice: "ach_outbound",
  outbound_payment: "ach_outbound",
  ach_outbound: "ach_outbound",
  ach_inbound: "ach_inbound",
  wire: "wire",
  onchain_transfer: "onchain_transfer",
  erp_writeback: "erp_writeback",
  card_payment: "card_payment",
};

const VALID_ACTION_STATUSES: ReadonlySet<ActionStatus> = new Set([
  "auto",
  "needs_approval",
  "approved",
  "rejected",
  "executed",
  "failed",
  "cancelled",
]);

function isPositiveDecimal(value: string | undefined): value is string {
  return value !== undefined && /^\d+(\.\d+)?$/.test(value) && value !== "0";
}

function invoiceLinkUrl(baseUrl: string | undefined, invoiceId: string): string {
  const base = baseUrl ?? "https://pay.robotmoney.local/invoices";
  return `${base.replace(/\/+$/, "")}/${invoiceId}`;
}

async function createInvoiceLink(
  ctx: ServiceCallContext,
  body: CreateActionBody,
  options: ActionRouteOptions,
  reply: FastifyReply,
): Promise<Record<string, unknown>> {
  if (options.pool === undefined) {
    throw brainError("invoice_link_unavailable", "invoice link creation is not configured", {
      statusOverride: 501,
    });
  }
  const counterpartyId = body.to?.counterparty_id ?? body.counterparty_id;
  if (
    counterpartyId === undefined ||
    !isBrainId(counterpartyId, "cp") ||
    !isPositiveDecimal(body.amount) ||
    body.currency === undefined ||
    !/^[A-Z]{3}$/.test(body.currency)
  ) {
    throw brainError(
      "request_body_invalid",
      "invoice_link requires counterparty_id, amount, and currency",
    );
  }
  const dueAt = body.due_date !== undefined ? new Date(body.due_date) : null;
  if (dueAt !== null && Number.isNaN(dueAt.getTime())) {
    throw brainError("request_body_invalid", "due_date must be ISO8601");
  }
  const invoiceId = newInvoiceId();
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  const hostedUrl = invoiceLinkUrl(options.invoiceLinkBaseUrl, invoiceId);
  await withTenantScope(options.pool, ctx.tenantId, async (client) => {
    const invoiceNumber = `RM-${invoiceId.slice(4, 14).toUpperCase()}`;
    await client.query(
      `INSERT INTO ledger_invoices (
         id, owner_id, invoice_number, counterparty_id, amount_due, amount_paid,
         currency, issue_date, due_date, status, linked_document_ids,
         linked_transaction_ids, source_ids, evidence_ids, provenance, confidence, metadata
       )
       VALUES ($1,$2,$3,$4,$5,0,$6,now(),$7,'sent',ARRAY[]::TEXT[],
         ARRAY[]::TEXT[],ARRAY[]::TEXT[],$8,'human_confirmed',1.0,$9::jsonb)`,
      [
        invoiceId,
        ctx.tenantId,
        invoiceNumber,
        counterpartyId,
        body.amount,
        body.currency,
        dueAt?.toISOString() ?? null,
        body.evidence_ids ?? [],
        JSON.stringify({
          description: body.description ?? null,
          memo: body.memo ?? null,
          created_by: ctx.actor,
        }),
      ],
    );
    await client.query(
      `INSERT INTO ledger_invoice_links (
         invoice_id, tenant_id, hosted_url, expires_at, created_by
       )
       VALUES ($1,$2,$3,$4,$5)`,
      [invoiceId, ctx.tenantId, hostedUrl, expiresAt, ctx.actor],
    );
  });
  reply.status(201);
  return {
    id: invoiceId,
    action_type: "invoice_link",
    invoice_id: invoiceId,
    hosted_url: hostedUrl,
    expires_at: expiresAt,
  };
}

export async function registerActionRoutes(
  app: FastifyInstance,
  service: PaymentIntentService,
  options: ActionRouteOptions = {},
): Promise<void> {
  // POST /actions
  app.post(
    "/actions",
    { config: { idempotent: true } },
    async (request: FastifyRequest<{ Body: CreateActionBody }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_PROPOSE);
      const b = request.body ?? {};
      const requestedType = b.type ?? b.action_type;
      if (requestedType === "invoice_link") {
        return createInvoiceLink(ctx, b, options, reply);
      }
      if (requestedType === undefined) {
        throw brainError("request_body_invalid", "`type` is required");
      }
      const piType = ACTION_TYPE_TO_PI_TYPE[requestedType];
      if (piType === undefined) {
        throw brainError("request_body_invalid", `unsupported action type: ${requestedType}`);
      }
      // For v0.3 the SDK still requires explicit destination + amount +
      // currency on the body when invoiceId is not the source. The
      // invoiceId shortcut (server resolves source/dest from the
      // invoice row) is its own follow-up — see audit §6.
      if (b.invoiceId === undefined) {
        if (
          b.source_account_id === undefined ||
          b.to?.counterparty_id === undefined ||
          b.amount === undefined ||
          b.currency === undefined ||
          !/^[A-Z]{3}$/.test(b.currency)
        ) {
          throw brainError(
            "request_body_invalid",
            "non-invoice actions require source_account_id, to.counterparty_id, amount, and currency",
          );
        }
      }

      const agentId = proposedAgentId(request, b.agent_id);
      const intent = await service.create(ctx, {
        action_type: piType as never,
        source_account_id: b.source_account_id ?? "acct_PENDING",
        destination_counterparty_id: b.to?.counterparty_id ?? "cp_PENDING",
        amount: b.amount ?? "0",
        currency: b.currency ?? "USD",
        ...(b.invoiceId !== undefined ? { invoice_id: b.invoiceId } : {}),
        ...(agentId !== undefined ? { agent_id: agentId } : {}),
        ...(b.evidence_ids !== undefined ? { evidence_ids: b.evidence_ids } : {}),
      });
      reply.status(201);
      return paymentIntentToAction(intent);
    },
  );

  // GET /actions
  app.get(
    "/actions",
    async (
      request: FastifyRequest<{
        Querystring: {
          tenantId?: string;
          agent_id?: string;
          status?: ActionStatus;
          from?: string;
          to?: string;
          limit?: string;
          cursor?: string;
        };
      }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_READ);
      const q = request.query;
      if (q.status !== undefined && !VALID_ACTION_STATUSES.has(q.status)) {
        throw brainError("request_params_invalid", `unknown status: ${q.status}`);
      }
      // The service's list() takes the storage status; translate the
      // docs status filter on the way in. "auto" maps to two storage
      // states (proposed + approved); we surface both by widening to no
      // filter for now and slicing client-side. A future commit adds a
      // typed multi-status filter in PaymentIntentService.list.
      const intents = await service.list(ctx, {
        ...(q.agent_id !== undefined ? { agent_id: q.agent_id } : {}),
        limit: q.limit !== undefined ? Number.parseInt(q.limit, 10) : 50,
      });
      const data = intents.map(paymentIntentToAction);
      const filtered = q.status === undefined ? data : data.filter((a) => a.status === q.status);
      reply.status(200);
      return { data: filtered, next_cursor: null };
    },
  );

  // GET /actions/:id
  app.get("/actions/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, SCOPE_READ);
    if (!isBrainId(request.params.id, "pi")) {
      throw brainError("request_params_invalid", "malformed action id");
    }
    const intent = await service.get(ctx, request.params.id);
    if (intent === null) {
      throw brainError("action_not_found", "no such action");
    }
    reply.status(200);
    return paymentIntentToAction(intent);
  });

  // DELETE /actions/:id
  app.delete("/actions/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, SCOPE_PROPOSE);
    if (!isBrainId(request.params.id, "pi")) {
      throw brainError("request_params_invalid", "malformed action id");
    }
    const intent = await service.cancel(ctx, request.params.id);
    reply.status(200);
    return paymentIntentToAction(intent);
  });

  // POST /actions/:id/approve
  app.post(
    "/actions/:id/approve",
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { asserted_actor_id?: string; actor_id?: unknown; actor?: unknown };
      }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requirePaymentIntentApproveScope(request.principal!.scopes);
      if (!isBrainId(request.params.id, "pi")) {
        throw brainError("request_params_invalid", "malformed action id");
      }
      const intent = await service.approve(ctx, request.params.id, {
        ...(request.body?.asserted_actor_id !== undefined
          ? { assertedActorId: request.body.asserted_actor_id }
          : {}),
        payloadActorId: request.body?.actor_id ?? request.body?.actor,
      });
      reply.status(200);
      return paymentIntentToAction(intent);
    },
  );

  // POST /actions/:id/reject
  app.post(
    "/actions/:id/reject",
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { reason?: string };
      }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requirePaymentIntentApproveScope(request.principal!.scopes);
      if (!isBrainId(request.params.id, "pi")) {
        throw brainError("request_params_invalid", "malformed action id");
      }
      const intent = await service.reject(ctx, request.params.id, request.body?.reason);
      reply.status(200);
      return paymentIntentToAction(intent);
    },
  );

  // POST /actions/:id/execute
  app.post(
    "/actions/:id/execute",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_EXECUTE);
      if (!isBrainId(request.params.id, "pi")) {
        throw brainError("request_params_invalid", "malformed action id");
      }
      const result = await service.execute(ctx, request.params.id);
      reply.status(202);
      return {
        action_id: result.payment_intent_id,
        execution_id: result.execution_id,
        rail: result.rail,
        status: result.status,
      };
    },
  );
}
