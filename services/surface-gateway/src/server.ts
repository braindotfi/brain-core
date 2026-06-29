import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import {
  handleEmailApproval,
  handleSlackInteraction,
  type SurfaceConfig,
  type ConversationReferenceStore,
  type TeamsActivityVerifier,
  parseProposal,
  signVerificationToken,
  type DeliveryTarget,
  verifySlackRequest,
  verifyVerificationToken,
  type Proposal,
  type AgentKind,
} from "@brain/surfaces";
import type { SurfaceRuntime } from "@brain/core";
import type { PostgresSurfaceProposalStore } from "./storage.js";
import {
  buildSlackAuthorizeUrl,
  FetchSlackOAuthClient,
  mintSlackInstallState,
  verifySlackInstallState,
  type SlackOAuthClient,
} from "./slack-oauth.js";

export interface SlackRetryStore {
  claim(retryKey: string): Promise<boolean>;
}

export interface SlackInstallationStore {
  createInstallNonce(input: {
    tenantId: string;
    nonce: string;
    installedBy: string;
    expiresAt: Date;
  }): Promise<void>;
  consumeInstallNonce(input: { tenantId: string; nonce: string; now: Date }): Promise<boolean>;
  upsertInstallation(input: {
    tenantId: string;
    teamId: string;
    botToken: string;
    botUserId: string;
    scopes: string[];
    installedBy: string;
  }): Promise<void>;
  getInstallationForTenantTeam(input: {
    tenantId: string;
    teamId: string;
  }): Promise<{ status: "active" | "revoked" } | null>;
  getInstallationByTeam(teamId: string): Promise<{ tenantId: string } | null>;
  revoke(teamId: string): Promise<void>;
}

export interface TeamsInstallationStore {
  upsertInstallation(input: {
    brainTenantId: string;
    aadTenantId: string;
    serviceUrl?: string | undefined;
    installedBy: string;
  }): Promise<void>;
  resolveBrainTenant(aadTenantId: string): Promise<{
    brainTenantId: string;
    aadTenantId: string;
    serviceUrl?: string | undefined;
    status: "active" | "revoked";
  } | null>;
  recordActivity(input: {
    brainTenantId: string;
    aadTenantId: string;
    serviceUrl?: string | undefined;
  }): Promise<void>;
  revoke(aadTenantId: string): Promise<void>;
}

export interface EmailOnboardingStore {
  upsertRecipient(input: {
    tenantId: string;
    email: string;
    actorId: string;
    roles: string[];
  }): Promise<void>;
  verifyRecipient(input: {
    tenantId: string;
    email: string;
    actorId: string;
    roles: string[];
  }): Promise<void>;
  disableRecipient(input: { tenantId: string; email: string }): Promise<void>;
  setRoute(input: { tenantId: string; agent: AgentKind; recipients: string[] }): Promise<void>;
  resolveRoute(input: { tenantId: string; agent: AgentKind }): Promise<string[]>;
  filterVerifiedRecipients(input: { tenantId: string; recipients: string[] }): Promise<string[]>;
  upsertDomain(input: {
    tenantId: string;
    domain: string;
    spfOk: boolean;
    dkimOk: boolean;
    dmarcOk: boolean;
    status?: "pending" | "active" | "disabled" | undefined;
  }): Promise<void>;
}

export interface EmailVerificationSender {
  send(args: {
    tenantId: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<{ ok: boolean; messageId?: string; error?: string }>;
}

export interface BuildSurfaceGatewayAppOptions {
  runtime: SurfaceRuntime;
  surfaceConfig: SurfaceConfig;
  proposals: PostgresSurfaceProposalStore;
  slackRetries: SlackRetryStore;
  slackInstallations?: SlackInstallationStore | undefined;
  slackOAuthClient?: SlackOAuthClient | undefined;
  slackOAuthRedirectUri?: string | undefined;
  teamsVerifier?: TeamsActivityVerifier | undefined;
  teamsInstallations?: TeamsInstallationStore | undefined;
  teamsConversationReferences?: ConversationReferenceStore | undefined;
  emailOnboarding?: EmailOnboardingStore | undefined;
  emailVerificationSender?: EmailVerificationSender | undefined;
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
      ...(opts.slackInstallations !== undefined
        ? {
            installationVerifier: async ({ tenantId, teamId }) => {
              const installation = await opts.slackInstallations?.getInstallationForTenantTeam({
                tenantId,
                teamId,
              });
              return installation?.status === "active";
            },
          }
        : {}),
      logger: app.log,
    });
    reply.status(response.status);
    return response.body;
  });

  app.post("/surfaces/slack/oauth/install", async (request, reply) => {
    const slack = opts.surfaceConfig.slack;
    const clientId = slack.clientId;
    const clientSecret = slack.clientSecret;
    const installAdminSecret = slack.installAdminSecret;
    const installations = opts.slackInstallations;
    if (
      clientId === undefined ||
      clientSecret === undefined ||
      installAdminSecret === undefined ||
      installations === undefined
    ) {
      reply.status(404);
      return "slack oauth disabled";
    }
    if (header(request.headers, "x-brain-slack-install-secret") !== installAdminSecret) {
      reply.status(401);
      return "unauthorized";
    }
    const body = parseJsonObject(requireRawBody(request.body));
    const tenantId = stringField(body, "tenantId");
    const installedBy = stringField(body, "installedBy");
    if (tenantId === null || installedBy === null) {
      reply.status(400);
      return "missing tenantId or installedBy";
    }
    const state = mintSlackInstallState({
      tenantId,
      installedBy,
      secret: clientSecret,
    });
    await installations.createInstallNonce({
      tenantId,
      nonce: state.nonce,
      installedBy,
      expiresAt: state.expiresAt,
    });
    const url = buildSlackAuthorizeUrl({
      clientId,
      state: state.token,
      redirectUri: opts.slackOAuthRedirectUri,
    });
    reply.redirect(url, 302);
    return "";
  });

  app.get("/surfaces/slack/oauth/callback", async (request, reply) => {
    const slack = opts.surfaceConfig.slack;
    const clientId = slack.clientId;
    const clientSecret = slack.clientSecret;
    const installations = opts.slackInstallations;
    if (clientId === undefined || clientSecret === undefined || installations === undefined) {
      reply.status(404);
      return "slack oauth disabled";
    }
    const url = new URL(request.url, "http://surface-gateway.local");
    const code = url.searchParams.get("code");
    const stateToken = url.searchParams.get("state");
    if (code === null || stateToken === null) {
      reply.status(400);
      return "missing code or state";
    }
    const state = verifySlackInstallState({ token: stateToken, secret: clientSecret });
    if (!state.ok) {
      reply.status(400);
      return "invalid state";
    }
    const consumed = await installations.consumeInstallNonce({
      tenantId: state.claims.tenantId,
      nonce: state.claims.nonce,
      now: new Date(),
    });
    if (!consumed) {
      reply.status(400);
      return "invalid state";
    }
    const oauth = opts.slackOAuthClient ?? new FetchSlackOAuthClient();
    const access = await oauth.exchangeCode({
      code,
      clientId,
      clientSecret,
      redirectUri: opts.slackOAuthRedirectUri,
    });
    await installations.upsertInstallation({
      tenantId: state.claims.tenantId,
      teamId: access.teamId,
      botToken: access.botToken,
      botUserId: access.botUserId,
      scopes: access.scopes,
      installedBy: state.claims.installedBy,
    });
    reply.header("content-type", "text/plain; charset=utf-8");
    return "Slack workspace connected.";
  });

  app.post("/surfaces/slack/events", async (request, reply) => {
    const rawBody = requireRawBody(request.body);
    const verified = verifySlackRequestForEvents({
      rawBody,
      headers: request.headers,
      signingSecret: opts.surfaceConfig.slack.signingSecret,
    });
    if (!verified) {
      reply.status(401);
      return "invalid slack signature";
    }
    const body = parseJsonObject(rawBody);
    if (body["type"] === "url_verification") {
      const challenge = stringField(body, "challenge");
      if (challenge === null) {
        reply.status(400);
        return "missing challenge";
      }
      return { challenge };
    }
    if (body["type"] !== "event_callback") return { ok: true };
    const event = body["event"];
    if (!isSlackAppUninstalledEvent(event)) return { ok: true };
    const teamId = stringField(body, "team_id");
    if (teamId === null) {
      reply.status(400);
      return "missing team_id";
    }
    if (opts.slackInstallations !== undefined) {
      const installation = await opts.slackInstallations.getInstallationByTeam(teamId);
      if (installation !== null) await opts.slackInstallations.revoke(teamId);
    }
    return { ok: true };
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

  app.post("/surfaces/email/recipients/verify/start", async (request, reply) => {
    const onboarding = opts.emailOnboarding;
    const sender = opts.emailVerificationSender;
    const adminSecret = opts.surfaceConfig.email.onboardingAdminSecret;
    if (onboarding === undefined || sender === undefined || adminSecret === undefined) {
      reply.status(404);
      return "email onboarding disabled";
    }
    if (header(request.headers, "x-brain-email-onboarding-secret") !== adminSecret) {
      reply.status(401);
      return "unauthorized";
    }
    const body = parseJsonObject(requireRawBody(request.body));
    const tenantId = stringField(body, "tenantId");
    const email = stringField(body, "email");
    const actorId = stringField(body, "actorId");
    const roles = stringArrayField(body, "roles");
    if (tenantId === null || email === null || actorId === null || roles === null) {
      reply.status(400);
      return "missing tenantId, email, actorId, or roles";
    }
    const normalizedEmail = normalizeEmail(email);
    await onboarding.upsertRecipient({ tenantId, email: normalizedEmail, actorId, roles });
    const token = signVerificationToken(
      {
        purpose: "email_recipient_verification",
        tenantId,
        email: normalizedEmail,
        actorId,
        roles,
        exp: Math.floor(Date.now() / 1000) + 15 * 60,
      },
      opts.surfaceConfig.email.tokenSecret,
    );
    const verifyUrl = `${emailVerifyBaseUrl(opts.approvalBaseUrl)}?t=${encodeURIComponent(token)}`;
    const sent = await sender.send({
      tenantId,
      to: normalizedEmail,
      subject: "Verify your Brain approval email",
      html: renderVerificationEmail(verifyUrl),
      text: `Verify your Brain approval email: ${verifyUrl}`,
    });
    if (!sent.ok) {
      reply.status(502);
      return "verification email failed";
    }
    reply.status(202);
    return { ok: true, tenantId, email: normalizedEmail };
  });

  app.route({
    method: ["GET", "HEAD", "POST"],
    url: "/surfaces/email/verify",
    handler: async (request, reply) => {
      const onboarding = opts.emailOnboarding;
      if (onboarding === undefined) {
        reply.status(404);
        return "email onboarding disabled";
      }
      const method = request.method as "GET" | "HEAD" | "POST";
      const token =
        method === "POST"
          ? readFormToken(requireRawBody(request.body))
          : new URL(request.url, opts.approvalBaseUrl).searchParams.get("t");
      if (token === null) {
        reply.status(400);
        return renderVerificationPage("unknown", method);
      }
      const claims = verifyVerificationToken(token, opts.surfaceConfig.email.tokenSecret);
      if (claims === null) {
        reply.status(400);
        return renderVerificationPage("unknown", method);
      }
      if (method === "GET" || method === "HEAD") {
        reply.header("content-type", "text/html; charset=utf-8");
        return renderVerificationConfirmPage({ token, email: claims.email, method });
      }
      await onboarding.verifyRecipient({
        tenantId: claims.tenantId,
        email: claims.email,
        actorId: claims.actorId,
        roles: claims.roles,
      });
      reply.header("content-type", "text/html; charset=utf-8");
      return renderVerificationPage("verified", method);
    },
  });

  app.post("/surfaces/email/routes", async (request, reply) => {
    const onboarding = opts.emailOnboarding;
    const adminSecret = opts.surfaceConfig.email.onboardingAdminSecret;
    if (onboarding === undefined || adminSecret === undefined) {
      reply.status(404);
      return "email onboarding disabled";
    }
    if (header(request.headers, "x-brain-email-onboarding-secret") !== adminSecret) {
      reply.status(401);
      return "unauthorized";
    }
    const body = parseJsonObject(requireRawBody(request.body));
    const tenantId = stringField(body, "tenantId");
    const agent = proposalAgentField(body, "agent");
    const recipients = stringArrayField(body, "recipients");
    if (tenantId === null || agent === null || recipients === null) {
      reply.status(400);
      return "missing tenantId, agent, or recipients";
    }
    await onboarding.setRoute({ tenantId, agent, recipients });
    reply.status(201);
    return { ok: true, tenantId, agent, recipients: recipients.map(normalizeEmail) };
  });

  app.post("/surfaces/email/domains", async (request, reply) => {
    const onboarding = opts.emailOnboarding;
    const adminSecret = opts.surfaceConfig.email.onboardingAdminSecret;
    if (onboarding === undefined || adminSecret === undefined) {
      reply.status(404);
      return "email onboarding disabled";
    }
    if (header(request.headers, "x-brain-email-onboarding-secret") !== adminSecret) {
      reply.status(401);
      return "unauthorized";
    }
    const body = parseJsonObject(requireRawBody(request.body));
    const tenantId = stringField(body, "tenantId");
    const domain = stringField(body, "domain");
    const spfOk = booleanField(body, "spfOk");
    const dkimOk = booleanField(body, "dkimOk");
    const dmarcOk = booleanField(body, "dmarcOk");
    if (
      tenantId === null ||
      domain === null ||
      spfOk === null ||
      dkimOk === null ||
      dmarcOk === null
    ) {
      reply.status(400);
      return "missing tenantId, domain, spfOk, dkimOk, or dmarcOk";
    }
    await onboarding.upsertDomain({ tenantId, domain, spfOk, dkimOk, dmarcOk });
    reply.status(201);
    return {
      ok: true,
      tenantId,
      domain: normalizeDomain(domain),
      verified: spfOk && dkimOk && dmarcOk,
    };
  });

  app.post("/surfaces/email/events", async (request, reply) => {
    const onboarding = opts.emailOnboarding;
    const secret = opts.surfaceConfig.email.espWebhookSecret;
    if (onboarding === undefined || secret === undefined) {
      reply.status(404);
      return "email events disabled";
    }
    const rawBody = requireRawBody(request.body);
    if (!verifyEmailEventSignature({ rawBody, headers: request.headers, secret })) {
      reply.status(401);
      return "invalid email event signature";
    }
    const body = parseJsonObject(rawBody);
    const type = stringField(body, "type");
    const tenantId = stringField(body, "tenantId");
    const email = stringField(body, "email");
    if ((type !== "bounce" && type !== "complaint") || tenantId === null || email === null) {
      reply.status(400);
      return "unknown email event";
    }
    await onboarding.disableRecipient({ tenantId, email });
    return { ok: true };
  });

  app.post("/surfaces/teams/messages", async (request, reply) => {
    if (opts.teamsVerifier === undefined) {
      reply.status(503);
      return "teams disabled";
    }
    if (opts.teamsInstallations === undefined) {
      reply.status(503);
      return "teams installation store disabled";
    }
    const verified = await opts.teamsVerifier.verify({
      authorization: header(request.headers, "authorization"),
      rawBody: requireRawBody(request.body),
    });
    if (verified === null) {
      reply.status(401);
      return "unauthorized";
    }
    const installation = await opts.teamsInstallations.resolveBrainTenant(verified.aadTenantId);
    if (installation === null || installation.status !== "active") {
      reply.status(403);
      return "teams installation not active";
    }
    await opts.teamsInstallations.recordActivity({
      brainTenantId: installation.brainTenantId,
      aadTenantId: verified.aadTenantId,
      ...(verified.serviceUrl !== undefined ? { serviceUrl: verified.serviceUrl } : {}),
    });
    if (
      verified.conversationReference !== undefined &&
      opts.teamsConversationReferences !== undefined
    ) {
      await opts.teamsConversationReferences.set(
        `${installation.brainTenantId}:${verified.conversationId}`,
        verified.conversationReference,
      );
    }
    if (verified.submit === undefined) {
      reply.status(200);
      return "ok";
    }
    if (verified.aadObjectId === undefined) {
      reply.status(400);
      return "missing teams actor";
    }
    if (
      verified.submit.proposalId === undefined ||
      verified.submit.tenantId === undefined ||
      verified.submit.brainDecision === undefined
    ) {
      reply.status(400);
      return "unknown teams action";
    }
    if (verified.submit.tenantId !== installation.brainTenantId) {
      reply.status(403);
      return "teams tenant mismatch";
    }
    const conversationRef = `${installation.brainTenantId}:${verified.conversationId}`;
    const outcome = await opts.runtime.approvals.handle(
      {
        surface: "teams",
        proposalId: verified.submit.proposalId,
        tenantId: installation.brainTenantId,
        externalActorId: verified.aadObjectId,
        decision: verified.submit.brainDecision,
        context: { to: conversationRef },
      },
      verified.activityId,
    );
    reply.status(200);
    return outcome.status;
  });

  app.post("/surfaces/teams/install", async (request, reply) => {
    const teams = opts.surfaceConfig.teams;
    const installAdminSecret = teams.installAdminSecret;
    const installations = opts.teamsInstallations;
    if (installAdminSecret === undefined || installations === undefined) {
      reply.status(404);
      return "teams install disabled";
    }
    if (header(request.headers, "x-brain-teams-install-secret") !== installAdminSecret) {
      reply.status(401);
      return "unauthorized";
    }
    const body = parseJsonObject(requireRawBody(request.body));
    const brainTenantId = stringField(body, "brainTenantId");
    const aadTenantId = stringField(body, "aadTenantId");
    const installedBy = stringField(body, "installedBy");
    const serviceUrl = stringField(body, "serviceUrl");
    if (brainTenantId === null || aadTenantId === null || installedBy === null) {
      reply.status(400);
      return "missing brainTenantId, aadTenantId, or installedBy";
    }
    await installations.upsertInstallation({
      brainTenantId,
      aadTenantId,
      installedBy,
      ...(serviceUrl !== null ? { serviceUrl } : {}),
    });
    reply.status(201);
    return { ok: true, brainTenantId, aadTenantId };
  });

  app.post("/surfaces/teams/revoke", async (request, reply) => {
    const installAdminSecret = opts.surfaceConfig.teams.installAdminSecret;
    const installations = opts.teamsInstallations;
    if (installAdminSecret === undefined || installations === undefined) {
      reply.status(404);
      return "teams install disabled";
    }
    if (header(request.headers, "x-brain-teams-install-secret") !== installAdminSecret) {
      reply.status(401);
      return "unauthorized";
    }
    const body = parseJsonObject(requireRawBody(request.body));
    const aadTenantId = stringField(body, "aadTenantId");
    if (aadTenantId === null) {
      reply.status(400);
      return "missing aadTenantId";
    }
    await installations.revoke(aadTenantId);
    return { ok: true, aadTenantId };
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
    const targets = await resolveDispatchTargets({
      proposal: saved,
      rawTargets: body["targets"],
      emailOnboarding: opts.emailOnboarding,
    });
    const results = await opts.runtime.dispatcher.dispatch(saved, targets);
    reply.status(202);
    return { proposal_id: saved.id, content_hash: saved.contentHash, results };
  });

  return app;
}

function verifySlackRequestForEvents(input: {
  rawBody: Buffer;
  headers: FastifyRequest["headers"];
  signingSecret: string;
}): boolean {
  const signature = header(input.headers, "x-slack-signature");
  const timestamp = header(input.headers, "x-slack-request-timestamp");
  const verified = verifySlackRequest({
    rawBody: input.rawBody,
    signature,
    timestamp,
    signingSecret: input.signingSecret,
  });
  return verified.ok;
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

function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArrayField(body: Record<string, unknown>, key: string): string[] | null {
  const value = body[key];
  if (!Array.isArray(value)) return null;
  const strings = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  return strings.length === value.length ? strings : null;
}

function booleanField(body: Record<string, unknown>, key: string): boolean | null {
  const value = body[key];
  return typeof value === "boolean" ? value : null;
}

function proposalAgentField(body: Record<string, unknown>, key: string): AgentKind | null {
  const value = body[key];
  return value === "invoice" || value === "collections" || value === "cash" || value === "close"
    ? value
    : null;
}

function readFormToken(body: Buffer): string | null {
  const params = new URLSearchParams(body.toString("utf8"));
  return params.get("t");
}

function emailVerifyBaseUrl(approvalBaseUrl: string): string {
  const url = new URL(approvalBaseUrl);
  url.pathname = "/surfaces/email/verify";
  url.search = "";
  return url.toString();
}

function renderVerificationEmail(verifyUrl: string): string {
  return `<!doctype html><html><body><main><h1>Verify Brain approval email</h1><p>Confirm this address before Brain sends approval links.</p><p><a href="${escapeHtml(verifyUrl)}">Verify email</a></p></main></body></html>`;
}

function renderVerificationConfirmPage(input: {
  token: string;
  email: string;
  method: "GET" | "HEAD" | "POST";
}): string {
  if (input.method === "HEAD") return "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Verify Brain Email</title></head><body><main><h1>Verify email</h1><p>${escapeHtml(input.email)}</p><form method="post" action="/surfaces/email/verify"><input type="hidden" name="t" value="${escapeHtml(input.token)}"><button type="submit">Confirm email</button></form></main></body></html>`;
}

function renderVerificationPage(
  outcome: "verified" | "unknown",
  method: "GET" | "HEAD" | "POST",
): string {
  if (method === "HEAD") return "";
  const message =
    outcome === "verified"
      ? "Email verified. Brain can now send approval links to this address."
      : "This verification link is invalid or expired.";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Brain Email Verification</title></head><body><main><h1>${escapeHtml(message)}</h1></main></body></html>`;
}

function verifyEmailEventSignature(input: {
  rawBody: Buffer;
  headers: FastifyRequest["headers"];
  secret: string;
}): boolean {
  const signature = header(input.headers, "x-brain-email-signature");
  if (signature === undefined) return false;
  const expected = `v1=${createHmac("sha256", input.secret).update(input.rawBody).digest("hex")}`;
  const actual = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actual.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actual, expectedBuffer);
}

async function resolveDispatchTargets(input: {
  proposal: Proposal;
  rawTargets: unknown;
  emailOnboarding?: EmailOnboardingStore | undefined;
}): Promise<DeliveryTarget[]> {
  const parsed = parseTargets(input.rawTargets);
  if (input.emailOnboarding === undefined) return parsed;
  if (parsed.length === 0) {
    const recipients = await input.emailOnboarding.resolveRoute({
      tenantId: input.proposal.tenantId,
      agent: input.proposal.agent,
    });
    return recipients.map((to) => ({ surface: "email", to }));
  }

  const emailTargets = parsed.filter((target) => target.surface === "email");
  if (emailTargets.length === 0) return parsed;
  const verified = new Set(
    await input.emailOnboarding.filterVerifiedRecipients({
      tenantId: input.proposal.tenantId,
      recipients: emailTargets.map((target) => target.to),
    }),
  );
  return parsed.filter(
    (target) => target.surface !== "email" || verified.has(normalizeEmail(target.to)),
  );
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isSlackAppUninstalledEvent(value: unknown): value is { type: "app_uninstalled" } {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<string, unknown>)["type"] === "app_uninstalled";
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
