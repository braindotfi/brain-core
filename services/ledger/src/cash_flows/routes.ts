/**
 * GET /ledger/cash_flows — cash-flow aggregation route.
 *
 * Thin glue: fetch transactions in the window via LedgerService, run
 * the pure `aggregateCashFlow` over them, return the summary.
 *
 * Source: https://docs.brain.fi/api-reference/ledger-api ("cash flows").
 *
 * @packageDocumentation
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, requireScope, type Scope, type ServiceCallContext } from "@brain/shared";
import type { LedgerService } from "../service/LedgerService.js";
import { aggregateCashFlow, type CashFlowTransaction } from "./aggregate.js";

const SCOPE_READ: Scope = "ledger:read";

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

interface Query {
  tenantId?: string;
  days?: string;
  currency?: string;
}

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

export async function registerCashFlowRoutes(
  app: FastifyInstance,
  service: LedgerService,
): Promise<void> {
  app.get("/ledger/cash_flows", async (request: FastifyRequest<{ Querystring: Query }>, reply) => {
    const ctx = principalCtx(request);
    requireScope(request.principal!.scopes, SCOPE_READ);

    const days = Math.min(
      Math.max(
        request.query.days !== undefined
          ? Number.parseInt(request.query.days, 10) || DEFAULT_DAYS
          : DEFAULT_DAYS,
        1,
      ),
      MAX_DAYS,
    );
    if (request.query.currency !== undefined && !/^[A-Z]{3}$/.test(request.query.currency)) {
      throw brainError("request_params_invalid", "currency must match ^[A-Z]{3}$");
    }

    const until = new Date();
    const since = new Date(until.getTime() - days * 24 * 3600 * 1000);

    // Pull transactions in the window via LedgerService. The existing
    // listTransactions clamps to 1000; for v0.3 cash-flow this covers
    // typical ranges. Very high-volume tenants will need cursor-based
    // pagination here — follow-up commit.
    const txns = await service.listTransactions(ctx, {
      since: since.toISOString(),
      until: until.toISOString(),
      limit: 1000,
    });

    const flat: CashFlowTransaction[] = txns.items.map((t) => ({
      transaction_date:
        typeof t.transaction_date === "string"
          ? t.transaction_date
          : new Date(t.transaction_date as unknown as number).toISOString(),
      amount: t.amount,
      currency: t.currency,
      direction: t.direction as CashFlowTransaction["direction"],
    }));

    const summary = aggregateCashFlow({
      tenantId: ctx.tenantId,
      since: since.toISOString(),
      until: until.toISOString(),
      ...(request.query.currency !== undefined ? { currencyFilter: request.query.currency } : {}),
      transactions: flat,
    });

    reply.status(200);
    return summary;
  });
}
