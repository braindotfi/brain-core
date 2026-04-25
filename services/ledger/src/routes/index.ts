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
} from "@brain/api/shared";
import type { LedgerService } from "../service/LedgerService.js";

const READ: Scope = "ledger:read";

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
        ...(request.query.direction !== undefined ? { direction: request.query.direction as never } : {}),
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

  // Phase-2 stubs for write-side endpoints. Each returns 501 so callers
  // see the explicit "lands in phase N" message.
  app.post("/ledger/normalize", async () => {
    throw brainError(
      "raw_source_unsupported",
      "/ledger/normalize is implemented in refactor-3 (extractor → ledger rewrite)",
      { statusOverride: 501 },
    );
  });

  app.post("/ledger/reconcile", async () => {
    throw brainError(
      "raw_source_unsupported",
      "/ledger/reconcile is implemented in refactor-5 (reconciliation engine)",
      { statusOverride: 501 },
    );
  });
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return n;
}
