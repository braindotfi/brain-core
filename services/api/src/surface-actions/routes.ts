import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  brainError,
  extractRawBody,
  singleHeaderValue,
  verifyServiceAuthSignatureV2,
  withTenantScope,
  type ServiceCallContext,
} from "@brain/shared";
import type { ActorResolver, ApprovalService, PaymentIntentService } from "@brain/execution";

const SURFACES = new Set(["slack", "teams", "email"]);

interface SurfaceActionBody {
  tenant_id: string;
  proposal_id: string;
  payment_intent_id: string;
  surface: "slack" | "teams" | "email";
  external_actor_id: string;
  __rawBody?: Buffer;
}

export interface SurfaceActionHandoffDeps {
  pool: Pool;
  paymentIntents: PaymentIntentService;
  approvals: ApprovalService;
  actorResolver: ActorResolver;
  signingSecret: string;
}

export async function registerSurfaceActionHandoffRoutes(
  app: FastifyInstance,
  deps: SurfaceActionHandoffDeps,
): Promise<void> {
  await app.register(async (child) => {
    child.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request: unknown, raw: Buffer, done: (error: Error | null, body?: unknown) => void) => {
        try {
          const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
          parsed["__rawBody"] = raw;
          done(null, parsed);
        } catch (error) {
          done(error as Error, undefined);
        }
      },
    );

    child.post(
      "/internal/surface-actions/approve",
      { config: { skipAuth: true, rateLimit: { max: 120, timeWindow: "1 minute" } } },
      async (request: FastifyRequest<{ Body: SurfaceActionBody }>, reply) => {
        const body = authenticateAndParse(request, deps.signingSecret);
        const ctx = serviceContext(body);
        const intent = await deps.paymentIntents.get(ctx, body.payment_intent_id);
        if (intent === null) {
          throw brainError("execution_proposal_not_found", "no such payment intent");
        }

        if (
          intent.status === "approved" ||
          intent.status === "dispatching" ||
          intent.status === "executed"
        ) {
          const actor = await deps.actorResolver.resolve({
            kind: "surface",
            tenantId: body.tenant_id,
            surface: body.surface,
            externalRef: body.external_actor_id,
          });
          const prior = await deps.approvals.list(ctx, {
            type: "payment_intent",
            id: body.payment_intent_id,
          });
          if (!prior.some((approval) => approval.approver_principal_id === actor.memberId)) {
            throw brainError(
              "payment_intent_invalid_state",
              "payment intent was approved by a different member",
            );
          }
          reply.status(200);
          return { status: intent.status, quorum_met: true };
        }

        const updated = await deps.paymentIntents.approve(ctx, body.payment_intent_id, {
          surfaceIdentity: {
            surface: body.surface,
            externalRef: body.external_actor_id,
          },
        });
        reply.status(200);
        return {
          status: updated.status,
          quorum_met: updated.status === "approved",
        };
      },
    );

    child.post(
      "/internal/surface-actions/execute",
      { config: { skipAuth: true, rateLimit: { max: 120, timeWindow: "1 minute" } } },
      async (request: FastifyRequest<{ Body: SurfaceActionBody }>, reply) => {
        const body = authenticateAndParse(request, deps.signingSecret);
        const lookupCtx = serviceContext(body);
        const intent = await deps.paymentIntents.get(lookupCtx, body.payment_intent_id);
        if (intent === null) {
          throw brainError("execution_proposal_not_found", "no such payment intent");
        }
        if (intent.status === "dispatching" || intent.status === "executed") {
          const existing = await findExecutionOutbox(
            deps.pool,
            body.tenant_id,
            body.payment_intent_id,
          );
          if (existing === null) {
            throw brainError(
              "internal_server_error",
              "payment intent has no durable execution handoff",
            );
          }
          reply.status(200);
          return { status: intent.status, outbox_id: existing };
        }
        if (intent.created_by_agent_id === null) {
          throw brainError(
            "payment_intent_gate_failed",
            "surface execution requires a server-resolved creator agent",
          );
        }
        const result = await deps.paymentIntents.execute(
          {
            tenantId: body.tenant_id,
            actor: intent.created_by_agent_id,
            principalType: "agent",
            scopes: ["payment_intent:execute"],
            requestId: `surface:${body.proposal_id}`,
          },
          body.payment_intent_id,
        );
        reply.status(202);
        return { status: result.status, outbox_id: result.outbox_id };
      },
    );
  });
}

function authenticateAndParse(
  request: FastifyRequest<{ Body: SurfaceActionBody }>,
  secret: string,
): SurfaceActionBody {
  const body = request.body;
  if (
    typeof body?.tenant_id !== "string" ||
    typeof body.proposal_id !== "string" ||
    typeof body.payment_intent_id !== "string" ||
    !/^pi_[A-Za-z0-9]+$/.test(body.payment_intent_id) ||
    !SURFACES.has(body.surface) ||
    typeof body.external_actor_id !== "string" ||
    body.external_actor_id.length === 0
  ) {
    throw brainError("request_body_invalid", "invalid surface action handoff");
  }
  const timestamp = singleHeaderValue(request.headers["x-brain-service-timestamp"]);
  const signature = singleHeaderValue(request.headers["x-brain-service-auth"]);
  const tenant = singleHeaderValue(request.headers["x-brain-write-tenant"]);
  if (
    tenant !== body.tenant_id ||
    !verifyServiceAuthSignatureV2(
      extractRawBody(body),
      signature,
      timestamp,
      body.tenant_id,
      secret,
    )
  ) {
    throw brainError("auth_token_invalid", "surface handoff authentication failed", {
      statusOverride: 401,
    });
  }
  return body;
}

function serviceContext(body: SurfaceActionBody): ServiceCallContext {
  return {
    tenantId: body.tenant_id,
    actor: "surface-gateway",
    principalType: "api_partner",
    scopes: ["payment_intent:approve"],
    requestId: `surface:${body.proposal_id}`,
  };
}

async function findExecutionOutbox(
  pool: Pool,
  tenantId: string,
  paymentIntentId: string,
): Promise<string | null> {
  return withTenantScope(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id
         FROM execution_outbox
        WHERE tenant_id = $1 AND payment_intent_id = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId, paymentIntentId],
    );
    return rows[0]?.id ?? null;
  });
}
