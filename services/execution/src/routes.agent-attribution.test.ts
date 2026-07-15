import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  errorHandlerPlugin,
  newAccountId,
  newAgentId,
  newCounterpartyId,
  newPaymentIntentId,
  newPolicyDecisionId,
  newProposalId,
  newTenantId,
  requestIdPlugin,
  type CreatePaymentIntentInput,
  type PaymentIntent,
  type Principal,
  type Scope,
} from "@brain/shared";
import type { Pool } from "pg";
import { registerActionRoutes } from "./actions/routes.js";
import type { ExecutionDeps } from "./deps.js";
import { registerPaymentIntentRoutes } from "./payment-intents/routes.js";
import type { PaymentIntentService } from "./payment-intents/PaymentIntentService.js";
import { RailRegistry } from "./rails/stubs.js";
import { registerExecutionRoutes } from "./routes.js";

const TENANT = newTenantId();
const AUTH_AGENT = newAgentId();
const REQUESTED_AGENT = newAgentId();
const ACCT = newAccountId();
const CP = newCounterpartyId();

function principal(scopes: Scope[]): Principal {
  return {
    id: AUTH_AGENT,
    type: "agent",
    tenantId: TENANT,
    scopes,
    tokenId: "tok_01TEST0000000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

function paymentIntent(input: CreatePaymentIntentInput): PaymentIntent {
  const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
  return {
    id: newPaymentIntentId(),
    owner_id: TENANT,
    created_by_agent_id: input.agent_id ?? null,
    action_type: input.action_type,
    source_account_id: input.source_account_id,
    destination_counterparty_id: input.destination_counterparty_id,
    amount: input.amount,
    currency: input.currency,
    obligation_id: input.obligation_id ?? null,
    invoice_id: input.invoice_id ?? null,
    status: "approved",
    policy_decision_id: newPolicyDecisionId(),
    approval_ids: [],
    execution_receipt_ids: [],
    source_ids: [],
    evidence_ids: input.evidence_ids ?? [],
    provenance: "agent_contributed",
    confidence: 1,
    created_at: now,
    updated_at: now,
  } as PaymentIntent;
}

function createService() {
  const create = vi.fn(async (_ctx, input: CreatePaymentIntentInput) => paymentIntent(input));
  return {
    service: { create } as unknown as PaymentIntentService,
    create,
  };
}

async function buildApp(p: Principal): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request) => {
    request.principal = p;
  });
  return app;
}

function executionDeps(captured: string[]): ExecutionDeps {
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT set_config")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO proposals")) {
        captured.push(values[2] as string);
        return {
          rows: [
            {
              id: newProposalId(),
              tenant_id: TENANT,
              proposing_agent: values[2],
              action: JSON.parse(values[3] as string),
              policy_version: values[4],
              policy_decision: values[5],
              policy_trace: [],
              required_approvers: [],
              status: values[8],
              approvers_signed: [],
              proposal_dedup_key: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  const unused = () => {
    throw new Error("dependency must not be used by propose attribution tests");
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    audit: { emit: vi.fn(async () => undefined) } as unknown as ExecutionDeps["audit"],
    rails: new RailRegistry([]),
    evaluatePolicy: async () => ({
      outcome: "allow",
      matched_rule_id: null,
      required_approvers: [],
      trace: [],
      policy_version: 1,
    }),
    evaluatePaymentIntent: unused as unknown as ExecutionDeps["evaluatePaymentIntent"],
    resolveAgent: unused as unknown as ExecutionDeps["resolveAgent"],
    resolveAccount: unused as unknown as ExecutionDeps["resolveAccount"],
    resolveCounterparty: unused as unknown as ExecutionDeps["resolveCounterparty"],
    resolvePrincipal: unused as unknown as ExecutionDeps["resolvePrincipal"],
    resolveRole: unused as unknown as ExecutionDeps["resolveRole"],
  };
}

describe("propose route agent attribution", () => {
  it("pins POST /payment-intents to the authenticated agent unless execution admin scope is present", async () => {
    const { service, create } = createService();
    const app = await buildApp(principal(["payment_intent:propose"]));
    await registerPaymentIntentRoutes(app, service);

    const res = await app.inject({
      method: "POST",
      url: "/payment-intents",
      payload: {
        action_type: "ach_outbound",
        source_account_id: ACCT,
        destination_counterparty_id: CP,
        amount: "100.00",
        currency: "USD",
        agent_id: REQUESTED_AGENT,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(create.mock.calls[0]?.[1].agent_id).toBe(AUTH_AGENT);
    await app.close();
  });

  it("allows POST /payment-intents admin callers to attribute an explicit agent", async () => {
    const { service, create } = createService();
    const app = await buildApp(principal(["payment_intent:propose", "execution:admin"]));
    await registerPaymentIntentRoutes(app, service);

    await app.inject({
      method: "POST",
      url: "/payment-intents",
      payload: {
        action_type: "ach_outbound",
        source_account_id: ACCT,
        destination_counterparty_id: CP,
        amount: "100.00",
        currency: "USD",
        agent_id: REQUESTED_AGENT,
      },
    });

    expect(create.mock.calls[0]?.[1].agent_id).toBe(REQUESTED_AGENT);
    await app.close();
  });

  it("pins POST /actions to the authenticated agent", async () => {
    const { service, create } = createService();
    const app = await buildApp(principal(["payment_intent:propose"]));
    await registerActionRoutes(app, service);

    const res = await app.inject({
      method: "POST",
      url: "/actions",
      payload: {
        type: "ach_outbound",
        source_account_id: ACCT,
        to: { counterparty_id: CP },
        amount: "25.00",
        currency: "USD",
        agent_id: REQUESTED_AGENT,
        tenantId: newTenantId(),
      },
    });

    expect(res.statusCode).toBe(201);
    expect(create.mock.calls[0]?.[1].agent_id).toBe(AUTH_AGENT);
    await app.close();
  });

  it("pins POST /execution/propose to the authenticated agent", async () => {
    const captured: string[] = [];
    const app = await buildApp(principal(["execution:propose"]));
    await registerExecutionRoutes(app, executionDeps(captured));

    const res = await app.inject({
      method: "POST",
      url: "/execution/propose",
      payload: {
        action: { kind: "wire" },
        agent_id: REQUESTED_AGENT,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(captured).toEqual([AUTH_AGENT]);
    await app.close();
  });
});
