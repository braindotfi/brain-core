/**
 * Ledger HTTP routes — Phase 2 ships read-only paths.
 *
 * Mirrors the §LAYER 2 LEDGER section of Brain_API_Specification.yaml.
 * Writes (`POST /ledger/normalize`, `POST /ledger/reconcile`) are stubbed
 * as 501 with a `not_implemented_in_phase` detail; they land in Phases 3
 * and 5 respectively.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  isBrainId,
  requireScope,
  type Scope,
  type ServiceCallContext,
} from "@brain/shared";
import type { LedgerService } from "../service/LedgerService.js";
import type { ReconciliationService } from "../reconciliation/ReconciliationService.js";

const READ: Scope = "ledger:read";
const WRITE: Scope = "ledger:write";

function principalCtx(request: FastifyRequest): ServiceCallContext {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  return {
    tenantId: request.principal.tenantId,
    actor: request.principal.id,
    requestId: request.id,
  };
}

export async function registerLedgerRoutes(
  app: FastifyInstance,
  service: LedgerService,
  reconciliation?: ReconciliationService,
): Promise<void> {
  app.get(
    "/ledger/accounts",
    async (
      request: FastifyRequest<{
        Querystring: { status?: string; account_type?: string; limit?: string };
      }>,
      reply,
    ) => {
      const ctx = principalCtx(request);
      requireScope(request.principal!.scopes, READ);
      const limit = parseLimit(request.query.limit);
      const result = await service.listAccounts(ctx, {
        ...(request.query.status !== undefined ? { status: request.query.status as never } : {}),
        ...(request.query.account_type !== undefined
          ? { account_type: request.query.account_type as never }
          : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      reply.status(200);
      return { accounts: result.items, next_cursor: result.next_cursor };
    },
  );

  app.get(
    "/ledger/accounts/:account_id",
    async (request: FastifyRequest<{ Params: { account_id: string } }>, reply) => {
      const ctx = principalCtx(request);
      requireScope(request.principal!.scopes, READ);
      if (!isBrainId(request.params.account_id, "acct")) {
        throw brainError("request_params_invalid", "malformed account_id");
      }
      const result = await service.getAccount(ctx, request.params.account_id);
      if (result === null) throw brainError("ledger_row_not_found", "no such account");
      reply.status(200);
      return result;
    },
  );

  app.get(
    "/ledger/balances",
    async (
      request: FastifyRequest<{ Querystring: { account_id?: string; as_of?: string } }>,
      reply,
    ) => {
      const ctx = principalCtx(request);
      requireScope(request.principal!.scopes, READ);
      const balances = await service.listBalances(ctx, {
        ...(request.query.account_id !== undefined ? { account_id: request.query.account_id } : {}),
        ...(request.query.as_of !== undefined ? { as_of: request.query.as_of } : {}),
      });
      reply.status(200);
      return { balances };
    },
  );

  app.get(
    "/ledger/transactions",
    async (
      request: FastifyRequest<{
        Querystring: {
          account_id?: string;
          counterparty_id?: string;
          direction?: string;
          status?: string;
          since?: string;
          until?: string;
          limit?: string;
        };
      }>,
      reply,
    ) => {
      const ctx = principalCtx(request);
      requireScope(request.principal!.scopes, READ);
      const limit = parseLimit(request.query.limit);
      const result = await service.listTransactions(ctx, {
        ...(request.query.account_id !== undefined ? { account_id: request.query.account_id } : {}),
        ...(request.query.counterparty_id !== undefined
          ? { counterparty_id: request.query.counterparty_id }
          : {}),
        ...(request.query.direction !== undefined
          ? { direction: request.query.direction as never }
          : {}),
        ...(request.query.status !== undefined ? { status: request.query.status as never } : {}),
        ...(request.query.since !== undefined ? { since: request.query.since } : {}),
        ...(request.query.until !== undefined ? { until: request.query.until } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      reply.status(200);
      return { transactions: result.items, next_cursor: result.next_cursor };
    },
  );

  app.get(
    "/ledger/transactions/:transaction_id",
    async (request: FastifyRequest<{ Params: { transaction_id: string } }>, reply) => {
      const ctx = principalCtx(request);
      requireScope(request.principal!.scopes, READ);
      if (!isBrainId(request.params.transaction_id, "tx")) {
        throw brainError("request_params_invalid", "malformed transaction_id");
      }
      const tx = await service.getTransaction(ctx, request.params.transaction_id);
      if (tx === null) throw brainError("ledger_row_not_found", "no such transaction");
      reply.status(200);
      return tx;
    },
  );

  app.get(
    "/ledger/counterparties",
    async (
      request: FastifyRequest<{
        Querystring: { q?: string; type?: string; verified_status?: string; limit?: string };
      }>,
      reply,
    ) => {
      const ctx = principalCtx(request);
      requireScope(request.principal!.scopes, READ);
      const limit = parseLimit(request.query.limit);
      const result = await service.listCounterparties(ctx, {
        ...(request.query.q !== undefined ? { q: request.query.q } : {}),
        ...(request.query.type !== undefined ? { type: request.query.type as never } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      reply.status(200);
      return { counterparties: result.items };
    },
  );

  app.get(
    "/ledger/counterparties/:counterparty_id",
    async (request: FastifyRequest<{ Params: { counterparty_id: string } }>, reply) => {
      const ctx = principalCtx(request);
      requireScope(request.principal!.scopes, READ);
      if (!isBrainId(request.params.counterparty_id, "cp")) {
        throw brainError("request_params_invalid", "malformed counterparty_id");
      }
      const result = await service.findCounterpartyById(ctx, request.params.counterparty_id);
      if (result === null) throw brainError("ledger_row_not_found", "no such counterparty");
      reply.status(200);
      return result;
    },
  );

  // Phase 6 governed read: the reconciled cross-source view (every observation
  // retained, field-level authority, conflicts listed, candidates pending
  // review) -- the "explain this number, including where sources disagree" surface.
  app.get(
    "/ledger/obligations/:obligation_id/resolved",
    async (request: FastifyRequest<{ Params: { obligation_id: string } }>, reply) => {
      const ctx = principalCtx(request);
      requireScope(request.principal!.scopes, READ);
      if (!isBrainId(request.params.obligation_id, "obl")) {
        throw brainError("request_params_invalid", "malformed obligation_id");
      }
      const result = await service.resolveObligation(ctx, request.params.obligation_id);
      if (result === null) throw brainError("ledger_row_not_found", "no such obligation");
      reply.status(200);
      return result;
    },
  );

  app.get(
    "/ledger/counterparties/:counterparty_id/resolved",
    async (request: FastifyRequest<{ Params: { counterparty_id: string } }>, reply) => {
      const ctx = principalCtx(request);
      requireScope(request.principal!.scopes, READ);
      if (!isBrainId(request.params.counterparty_id, "cp")) {
        throw brainError("request_params_invalid", "malformed counterparty_id");
      }
      const result = await service.resolveCounterparty(ctx, request.params.counterparty_id);
      if (result === null) throw brainError("ledger_row_not_found", "no such counterparty");
      reply.status(200);
      return result;
    },
  );

  app.get(
    "/ledger/obligations",
    async (
      request: FastifyRequest<{
        Querystring: { status?: string; type?: string; due_before?: string; limit?: string };
      }>,
      reply,
    ) => {
      const ctx = principalCtx(request);
      requireScope(request.principal!.scopes, READ);
      const limit = parseLimit(request.query.limit);
      const result = await service.listObligations(ctx, {
        ...(request.query.status !== undefined ? { status: request.query.status as never } : {}),
        ...(request.query.type !== undefined ? { type: request.query.type as never } : {}),
        ...(request.query.due_before !== undefined ? { due_before: request.query.due_before } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      reply.status(200);
      return { obligations: result.items };
    },
  );

  app.get(
    "/ledger/invoices",
    async (
      request: FastifyRequest<{
        Querystring: { status?: string; counterparty_id?: string; limit?: string };
      }>,
      reply,
    ) => {
      const ctx = principalCtx(request);
      requireScope(request.principal!.scopes, READ);
      const limit = parseLimit(request.query.limit);
      const result = await service.listInvoices(ctx, {
        ...(request.query.status !== undefined ? { status: request.query.status as never } : {}),
        ...(request.query.counterparty_id !== undefined
          ? { counterparty_id: request.query.counterparty_id }
          : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      reply.status(200);
      return { invoices: result.items };
    },
  );

  // POST /ledger/normalize — refactor-3 implements this via LedgerService.
  app.post(
    "/ledger/normalize",
    async (
      request: FastifyRequest<{
        Body: { raw_parsed_id?: string; target_entities?: string[] };
      }>,
      reply,
    ) => {
      const ctx = principalCtx(request);
      requireScope(request.principal!.scopes, WRITE);
      const id = request.body?.raw_parsed_id;
      if (id === undefined) {
        throw brainError("request_body_invalid", "raw_parsed_id required");
      }
      const result = await service.normalizeFromRaw(ctx, id);
      reply.status(200);
      return { ledger_rows_created: result.created };
    },
  );

  // POST /ledger/reconcile — refactor-5.
  app.post(
    "/ledger/reconcile",
    async (
      request: FastifyRequest<{
        Body: { since?: string; match_types?: string[] };
      }>,
      reply,
    ) => {
      if (reconciliation === undefined) {
        throw brainError(
          "raw_source_unsupported",
          "ReconciliationService not configured for this app instance",
          { statusOverride: 501 },
        );
      }
      const ctx = principalCtx(request);
      requireScope(request.principal!.scopes, WRITE);
      const out = await reconciliation.run(ctx, {
        ...(request.body?.since !== undefined ? { since: request.body.since } : {}),
        ...(request.body?.match_types !== undefined
          ? { match_types: request.body.match_types as never }
          : {}),
      });
      reply.status(202);
      return out;
    },
  );

  app.get(
    "/ledger/reconciliation-matches",
    async (
      request: FastifyRequest<{
        Querystring: { status?: string; match_type?: string; limit?: string };
      }>,
      reply,
    ) => {
      if (reconciliation === undefined) {
        throw brainError(
          "raw_source_unsupported",
          "ReconciliationService not configured for this app instance",
          { statusOverride: 501 },
        );
      }
      const ctx = principalCtx(request);
      requireScope(request.principal!.scopes, READ);
      type ListF = Parameters<typeof reconciliation.list>[1];
      const listF = {
        ...(request.query.status !== undefined ? { status: request.query.status } : {}),
        ...(request.query.match_type !== undefined ? { match_type: request.query.match_type } : {}),
        ...(request.query.limit !== undefined ? { limit: parseLimit(request.query.limit) } : {}),
      } as unknown as ListF;
      const matches = await reconciliation.list(ctx, listF);
      reply.status(200);
      return { matches };
    },
  );
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return n;
}
