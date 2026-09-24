import { brainError, requireScope, withTenantScope, type ServiceCallContext } from "@brain/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { NylasHttpError, type NylasAdapter, type NylasMessage } from "./adapter.js";

interface ProposalThreadRow {
  readonly id: string;
  readonly sent_thread_id: string | null;
  readonly delivery_status: string | null;
}

interface GrantRow {
  readonly grant_id: string;
  readonly email: string;
  readonly disconnected_at: Date | null;
}

export interface ProposalThreadRoutesDeps {
  readonly pool: Pool;
  readonly adapter: NylasAdapter;
}

export async function registerProposalThreadRoute(
  app: FastifyInstance,
  deps: ProposalThreadRoutesDeps,
): Promise<void> {
  app.get(
    "/proposals/:id/thread",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, "execution:read");
      try {
        const result = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
          const proposal = await loadProposal(client, request.params.id);
          if (proposal === null) {
            throw brainError("execution_proposal_not_found", "no such proposal");
          }
          if (proposal.delivery_status === null || proposal.sent_thread_id === null) {
            throw brainError("execution_proposal_invalid_state", "proposal has not sent email", {
              statusOverride: 409,
            });
          }
          const grant = await loadGrant(client);
          if (grant === null || grant.disconnected_at !== null) {
            throw brainError("dependency_unavailable", "email grant is disconnected", {
              statusOverride: 424,
            });
          }
          const messages = await deps.adapter.listMessages({
            grantId: grant.grant_id,
            threadId: proposal.sent_thread_id,
          });
          return {
            thread_id: proposal.sent_thread_id,
            messages: messages.map((message) => toResponseMessage(message, grant.email)),
          };
        });
        reply.status(200);
        return result;
      } catch (err) {
        if (err instanceof NylasHttpError && err.status === 429) {
          if (err.retryAfter !== null) reply.header("retry-after", err.retryAfter);
          reply.status(429);
          return {
            error: {
              code: "rate_limit_exceeded",
              message: "Nylas rate limit exceeded",
              details: {
                ...(err.retryAfter !== null ? { retry_after: err.retryAfter } : {}),
              },
              request_id: request.id,
            },
          };
        }
        throw err;
      }
    },
  );
}

async function loadProposal(
  client: { query: <T>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }> },
  id: string,
): Promise<ProposalThreadRow | null> {
  const { rows } = await client.query<ProposalThreadRow>(
    `SELECT id, sent_thread_id, delivery_status
       FROM proposals
      WHERE id = $1
        AND tenant_id = current_setting('app.tenant_id', true)
      LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

async function loadGrant(
  client: { query: <T>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }> },
): Promise<GrantRow | null> {
  const { rows } = await client.query<GrantRow>(
    `SELECT grant_id, email, disconnected_at
       FROM nylas_grants
      WHERE tenant_id = current_setting('app.tenant_id', true)
      LIMIT 1`,
  );
  return rows[0] ?? null;
}

function toResponseMessage(message: NylasMessage, accountEmail: string) {
  const fromEmail = message.from.email.trim().toLowerCase();
  const grantEmail = accountEmail.trim().toLowerCase();
  return {
    id: message.id,
    from: participant(message.from),
    to: message.to.map(participant),
    subject: message.subject,
    snippet: message.snippet,
    body_html: message.bodyHtml ?? "",
    body_text: message.bodyText ?? "",
    received_at: message.receivedAt,
    direction: fromEmail === grantEmail ? "outbound" : "inbound",
  };
}

function participant(input: { readonly name?: string; readonly email: string }) {
  return {
    name: input.name ?? "",
    email: input.email,
  };
}

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
