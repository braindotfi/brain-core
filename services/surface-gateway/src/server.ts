import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import {
  handleEmailApproval,
  handleSlackInteraction,
  type SurfaceConfig,
  type TeamsActivityVerifier,
  parseProposal,
  type DeliveryTarget,
} from "@brain/surfaces";
import type { SurfaceRuntime } from "@brain/core";
import type { PostgresSurfaceProposalStore } from "./storage.js";

export interface SlackRetryStore {
  claim(retryKey: string): Promise<boolean>;
}

export interface BuildSurfaceGatewayAppOptions {
  runtime: SurfaceRuntime;
  surfaceConfig: SurfaceConfig;
  proposals: PostgresSurfaceProposalStore;
  slackRetries: SlackRetryStore;
  teamsVerifier?: TeamsActivityVerifier | undefined;
  approvalBaseUrl: string;
  smoke?: { enabled: boolean; secret?: string | undefined } | undefined;
  logger?: ReturnType<typeof Fastify>["log"];
}

export async function buildSurfaceGatewayApp(
  opts: BuildSurfaceGatewayAppOptions,
): Promise<FastifyInstance> {
  const app = Fastify({
    ...(opts.logger !== undefined
      ? { loggerInstance: opts.logger }
      : { logger: { level: process.env.LOG_LEVEL ?? "info" } }),
    bodyLimit: 256 * 1024,
    disableRequestLogging: true,
  });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
    done(null, body),
  );
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  await app.register(fastifyHelmet);
  await app.register(fastifyRateLimit, {
    max: 120,
    timeWindow: "1 minute",
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/surfaces/slack/interactions", async (request, reply) => {
    const rawBody = requireRawBody(request.body);
    const retryNum = header(request.headers, "x-slack-retry-num");
    if (retryNum !== undefined) {
      const retryKey = slackRetryKey(request.headers, rawBody);
      const claimed = await opts.slackRetries.claim(retryKey);
      if (!claimed) {
        reply.status(200);
        return "";
      }
    }

    const response = await handleSlackInteraction({
      rawBody,
      headers: request.headers,
      signingSecret: opts.surfaceConfig.slack.signingSecret,
      approvals: opts.runtime.approvals,
      logger: app.log,
    });
    reply.status(response.status);
    return response.body;
  });

  app.route({
    method: ["GET", "HEAD", "POST"],
    url: "/surfaces/email/approve",
    handler: async (request, reply) => {
      const response = await handleEmailApproval({
        method: request.method as "GET" | "HEAD" | "POST",
        url: new URL(request.url, opts.approvalBaseUrl),
        body: request.method === "POST" ? requireRawBody(request.body) : undefined,
        tokenSecret: opts.surfaceConfig.email.tokenSecret,
        approvals: opts.runtime.approvals,
        loadProposalTitle: async (input) => {
          const proposal = await opts.proposals.load(input);
          return proposal?.title ?? null;
        },
      });
      for (const [key, value] of Object.entries(response.headers)) {
        reply.header(key, value);
      }
      reply.status(response.status);
      return response.body;
    },
  });

  app.post("/surfaces/teams/messages", async (request, reply) => {
    if (opts.teamsVerifier === undefined) {
      reply.status(503);
      return "teams disabled";
    }
    const verified = await opts.teamsVerifier.verify({
      authorization: header(request.headers, "authorization"),
      rawBody: requireRawBody(request.body),
    });
    if (verified === null) {
      reply.status(401);
      return "unauthorized";
    }
    if (
      verified.submit.proposalId === undefined ||
      verified.submit.tenantId === undefined ||
      verified.submit.brainDecision === undefined
    ) {
      reply.status(400);
      return "unknown teams action";
    }
    const outcome = await opts.runtime.approvals.handle(
      {
        surface: "teams",
        proposalId: verified.submit.proposalId,
        tenantId: verified.submit.tenantId,
        externalActorId: verified.aadObjectId,
        decision: verified.submit.brainDecision,
        context: { to: verified.conversationRef },
      },
      verified.activityId,
    );
    reply.status(200);
    return outcome.status;
  });

  app.post("/surfaces/smoke/proposals", async (request, reply) => {
    if (opts.smoke?.enabled !== true) {
      reply.status(404);
      return { error: "not_found" };
    }
    if (
      opts.smoke.secret &&
      header(request.headers, "x-brain-smoke-secret") !== opts.smoke.secret
    ) {
      reply.status(401);
      return { error: "unauthorized" };
    }
    const body = parseJsonObject(requireRawBody(request.body));
    const proposal = parseProposal(body["proposal"]);
    const saved = await opts.proposals.save({ proposal });
    const targets = parseTargets(body["targets"]);
    const results = await opts.runtime.dispatcher.dispatch(saved, targets);
    reply.status(202);
    return { proposal_id: saved.id, content_hash: saved.contentHash, results };
  });

  return app;
}

function requireRawBody(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body === undefined || body === null) return Buffer.alloc(0);
  return Buffer.from(JSON.stringify(body), "utf8");
}

function header(headers: FastifyRequest["headers"], name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function slackRetryKey(headers: FastifyRequest["headers"], rawBody: Buffer): string {
  const signature = header(headers, "x-slack-signature") ?? "";
  const timestamp = header(headers, "x-slack-request-timestamp") ?? "";
  const retryNum = header(headers, "x-slack-retry-num") ?? "";
  return createHash("sha256")
    .update(`${signature}:${timestamp}:${retryNum}:`)
    .update(rawBody)
    .digest("hex");
}

function parseJsonObject(body: Buffer): Record<string, unknown> {
  const parsed = JSON.parse(body.toString("utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected_json_object");
  }
  return parsed as Record<string, unknown>;
}

function parseTargets(value: unknown): DeliveryTarget[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const surface = (item as Record<string, unknown>)["surface"];
    const to = (item as Record<string, unknown>)["to"];
    if (
      (surface === "slack" || surface === "teams" || surface === "email") &&
      typeof to === "string"
    ) {
      return [{ surface, to }];
    }
    return [];
  });
}
