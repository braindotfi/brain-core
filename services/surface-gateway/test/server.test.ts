import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ConversationReference } from "botbuilder";
import type { SurfaceRuntime } from "@brain/core";
import { brainError, type Principal, type Scope } from "@brain/shared";
import {
  signVerificationToken,
  signToken,
  withContentHash,
  type ConversationReferenceStore,
  type EmailVerificationTokenClaims,
  type Proposal,
  type SurfaceConfig,
  type TeamsActivityVerifier,
  type VerifiedTeamsSubmit,
} from "@brain/surfaces";
import {
  buildSurfaceGatewayApp,
  type EmailOnboardingStore,
  type EmailVerificationSender,
  type OnboardingAdminVerifier,
  type SlackInstallationStore,
  type TeamsInstallationStore,
} from "../src/server.js";
import type { DomainVerifier } from "../src/domain-verifier.js";
import { SLACK_BOT_SCOPES, type SlackOAuthClient } from "../src/slack-oauth.js";
import { SlackInstallationTokenProvider } from "../src/storage.js";

const SIGNING_SECRET = "slack_secret";
const TENANT_ID = "tnt_1";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
});

describe("surface gateway server", () => {
  it("dedupes repeated Slack retry deliveries", async () => {
    const calls: unknown[] = [];
    const app = await makeApp({
      approvals: {
        async handle(input: unknown) {
          calls.push(input);
          return { status: "applied", decision: "approved", actorLabel: "usr_1" };
        },
      },
    });
    const body = slackBody();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": slackSignature(body, timestamp),
      "x-slack-retry-num": "1",
    };

    const first = await app.inject({
      method: "POST",
      url: "/surfaces/slack/interactions",
      headers,
      payload: body,
    });
    const second = await app.inject({
      method: "POST",
      url: "/surfaces/slack/interactions",
      headers,
      payload: body,
    });

    await flushBackground();
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("rejects Slack interactions whose team does not match the action tenant", async () => {
    const calls: unknown[] = [];
    const app = await makeApp({
      approvals: {
        async handle(input: unknown) {
          calls.push(input);
          return { status: "applied", decision: "approved", actorLabel: "usr_1" };
        },
      },
    });
    const body = slackBody("T_wrong");
    const timestamp = String(Math.floor(Date.now() / 1000));

    const res = await app.inject({
      method: "POST",
      url: "/surfaces/slack/interactions",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": slackSignature(body, timestamp),
      },
      payload: body,
    });

    await flushBackground();
    expect(res.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("completes Slack OAuth callback, persists installation, and rejects state replay", async () => {
    const lines: string[] = [];
    const installations = new MemorySlackInstallationStore();
    const oauth = new MemorySlackOAuthClient();
    const app = await makeApp(
      { slackInstallations: installations, slackOAuthClient: oauth },
      lines,
    );

    const init = await app.inject({
      method: "POST",
      url: "/surfaces/slack/oauth/install",
      headers: {
        "content-type": "application/json",
        authorization: bearer(),
      },
      payload: JSON.stringify({ tenantId: "tnt_wrong", installedBy: "user_admin" }),
    });
    expect(init.statusCode).toBe(302);
    const location = init.headers.location;
    expect(typeof location).toBe("string");
    const state = new URL(location as string).searchParams.get("state");
    expect(state).toBeTruthy();

    const callback = await app.inject({
      method: "GET",
      url: `/surfaces/slack/oauth/callback?code=oauth-code&state=${encodeURIComponent(state!)}`,
    });
    const replay = await app.inject({
      method: "GET",
      url: `/surfaces/slack/oauth/callback?code=oauth-code&state=${encodeURIComponent(state!)}`,
    });

    expect(callback.statusCode).toBe(200);
    expect(replay.statusCode).toBe(400);
    expect(oauth.exchangeCalls).toEqual(["oauth-code"]);
    expect(installations.installed).toMatchObject({
      tenantId: TENANT_ID,
      teamId: "T_oauth",
      botToken: "xoxb-oauth-token",
      botUserId: "B_oauth",
      installedBy: "user_admin",
    });
    expect(installations.createdNonces[0]).toMatchObject({
      tenantId: TENANT_ID,
      installedBy: "user_admin",
    });
    expect(lines.join("\n")).not.toContain("xoxb-oauth-token");
  });

  it("rejects onboarding endpoints without tenant-admin bearer auth", async () => {
    const onboarding = new MemoryEmailOnboardingStore();
    const routes = [
      {
        url: "/surfaces/slack/oauth/install",
        payload: { tenantId: TENANT_ID, installedBy: "tenant_admin" },
      },
      {
        url: "/surfaces/teams/install",
        payload: { brainTenantId: TENANT_ID, aadTenantId: "aad-tenant-1" },
      },
      { url: "/surfaces/teams/revoke", payload: { aadTenantId: "aad-tenant-1" } },
      {
        url: "/surfaces/email/recipients/verify/start",
        payload: { email: "approver@example.com", actorId: "user_1", roles: ["finance"] },
      },
      {
        url: "/surfaces/email/routes",
        payload: { agent: "invoice", recipients: ["approver@example.com"] },
      },
      { url: "/surfaces/email/domains", payload: { domain: "example.com" } },
    ];
    const app = await makeApp({
      teamsInstallations: new MemoryTeamsInstallationStore(),
      emailOnboarding: onboarding,
      emailVerificationSender: new MemoryEmailSender(),
      emailDomainVerifier: new MemoryDomainVerifier(),
    });

    for (const route of routes) {
      const res = await app.inject({
        method: "POST",
        url: route.url,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(route.payload),
      });
      expect(res.statusCode, route.url).toBe(401);
    }
  });

  it("rejects invalid and non-admin onboarding bearer tokens", async () => {
    const app = await makeApp({
      onboardingAdminVerifier: new MemoryOnboardingAdminVerifier("bad-token"),
      teamsInstallations: new MemoryTeamsInstallationStore(),
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/surfaces/teams/install",
      headers: { "content-type": "application/json", authorization: "Bearer bad-token" },
      payload: JSON.stringify({ aadTenantId: "aad-tenant-1" }),
    });
    const missingScope = await app.inject({
      method: "POST",
      url: "/surfaces/teams/install",
      headers: { "content-type": "application/json", authorization: bearer("tenant-reader") },
      payload: JSON.stringify({ aadTenantId: "aad-tenant-1" }),
    });

    expect(invalid.statusCode).toBe(401);
    expect(missingScope.statusCode).toBe(403);
  });

  it("marks Slack installations revoked on app_uninstalled and sends fail closed", async () => {
    const installations = new MemorySlackInstallationStore();
    installations.addActive(TENANT_ID, "T_1", "xoxb-active-token");
    const app = await makeApp({ slackInstallations: installations });
    const eventBody = JSON.stringify({
      type: "event_callback",
      team_id: "T_1",
      event: { type: "app_uninstalled" },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));

    const res = await app.inject({
      method: "POST",
      url: "/surfaces/slack/events",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": slackSignature(eventBody, timestamp),
      },
      payload: eventBody,
    });
    const provider = new SlackInstallationTokenProvider(installations);

    expect(res.statusCode).toBe(200);
    expect(installations.revokedTeams).toEqual(["T_1"]);
    await expect(provider.tokenForTenant(TENANT_ID)).rejects.toThrow(
      "slack_installation_not_found",
    );
  });

  it("captures an admin-approved Teams installation mapping", async () => {
    const installations = new MemoryTeamsInstallationStore();
    const app = await makeApp({
      surfaceConfig: teamsSurfaceConfig(),
      teamsInstallations: installations,
      teamsVerifier: new MemoryTeamsVerifier(null),
    });

    const res = await app.inject({
      method: "POST",
      url: "/surfaces/teams/install",
      headers: {
        "content-type": "application/json",
        authorization: bearer(),
      },
      payload: JSON.stringify({
        brainTenantId: "tnt_wrong",
        aadTenantId: "aad-tenant-1",
        installedBy: "tenant_admin",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
      }),
    });

    expect(res.statusCode).toBe(201);
    await expect(installations.resolveBrainTenant("aad-tenant-1")).resolves.toMatchObject({
      brainTenantId: TENANT_ID,
      aadTenantId: "aad-tenant-1",
      status: "active",
    });
  });

  it("rejects Teams approvals when the AAD tenant maps to a different Brain tenant", async () => {
    const calls: unknown[] = [];
    const installations = new MemoryTeamsInstallationStore();
    await installations.upsertInstallation({
      brainTenantId: TENANT_ID,
      aadTenantId: "aad-tenant-1",
      installedBy: "tenant_admin",
    });
    const app = await makeApp({
      surfaceConfig: teamsSurfaceConfig(),
      teamsInstallations: installations,
      teamsVerifier: new MemoryTeamsVerifier(teamsSubmit({ tenantId: "tnt_other" })),
      approvals: {
        async handle(input: unknown) {
          calls.push(input);
          return { status: "applied", decision: "approved", actorLabel: "usr_1" };
        },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/surfaces/teams/messages",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      payload: JSON.stringify({ type: "message" }),
    });

    expect(res.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("accepts Teams approvals only for active mapped tenants and stores the conversation ref", async () => {
    const calls: unknown[] = [];
    const refs = new MemoryConversationReferenceStore();
    const installations = new MemoryTeamsInstallationStore();
    await installations.upsertInstallation({
      brainTenantId: TENANT_ID,
      aadTenantId: "aad-tenant-1",
      installedBy: "tenant_admin",
    });
    const app = await makeApp({
      surfaceConfig: teamsSurfaceConfig(),
      teamsInstallations: installations,
      teamsConversationReferences: refs,
      teamsVerifier: new MemoryTeamsVerifier(teamsSubmit()),
      approvals: {
        async handle(input: unknown) {
          calls.push(input);
          return { status: "applied", decision: "approved", actorLabel: "usr_1" };
        },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/surfaces/teams/messages",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      payload: JSON.stringify({ type: "message" }),
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([
      expect.objectContaining({
        surface: "teams",
        tenantId: TENANT_ID,
        externalActorId: "aad-user-1",
        context: { to: `${TENANT_ID}:teams-conv-1` },
      }),
    ]);
    await expect(refs.get(`${TENANT_ID}:teams-conv-1`)).resolves.toMatchObject({
      conversation: { id: "teams-conv-1" },
    });
    expect(installations.lastActivity).toMatchObject({
      brainTenantId: TENANT_ID,
      aadTenantId: "aad-tenant-1",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
    });
  });

  it("fails closed for revoked Teams installations", async () => {
    const calls: unknown[] = [];
    const installations = new MemoryTeamsInstallationStore();
    await installations.upsertInstallation({
      brainTenantId: TENANT_ID,
      aadTenantId: "aad-tenant-1",
      installedBy: "tenant_admin",
    });
    await installations.revoke("aad-tenant-1");
    const app = await makeApp({
      surfaceConfig: teamsSurfaceConfig(),
      teamsInstallations: installations,
      teamsVerifier: new MemoryTeamsVerifier(teamsSubmit()),
      approvals: {
        async handle(input: unknown) {
          calls.push(input);
          return { status: "applied", decision: "approved", actorLabel: "usr_1" };
        },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/surfaces/teams/messages",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      payload: JSON.stringify({ type: "message" }),
    });

    expect(res.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("handles email approval POST without logging approval tokens", async () => {
    const lines: string[] = [];
    const proposal = sampleProposal();
    const app = await makeApp(
      {
        approvals: {
          async handle() {
            return { status: "applied", decision: "approved", actorLabel: "usr_1" };
          },
        },
        proposals: {
          async load() {
            return proposal;
          },
        },
      },
      lines,
    );
    const token = signToken(
      {
        tenantId: proposal.tenantId,
        proposalId: proposal.id,
        recipient: "approver@example.com",
        decision: "approved",
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      "email_secret",
    );
    const res = await app.inject({
      method: "POST",
      url: "/surfaces/email/approve",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ t: token }).toString(),
    });

    expect(res.statusCode).toBe(200);
    expect(lines.join("\n")).not.toContain(token);
  });

  it("verifies email recipients only on POST confirmation", async () => {
    const onboarding = new MemoryEmailOnboardingStore();
    const sender = new MemoryEmailSender();
    const app = await makeApp({
      emailOnboarding: onboarding,
      emailVerificationSender: sender,
    });

    const init = await app.inject({
      method: "POST",
      url: "/surfaces/email/recipients/verify/start",
      headers: {
        "content-type": "application/json",
        authorization: bearer(),
      },
      payload: JSON.stringify({
        tenantId: "tnt_wrong",
        email: "Approver@Example.com",
        actorId: "user_approver",
        roles: ["finance"],
      }),
    });
    const token = extractToken(sender.sent[0]?.text ?? "");

    const get = await app.inject({ method: "GET", url: `/surfaces/email/verify?t=${token}` });
    const head = await app.inject({ method: "HEAD", url: `/surfaces/email/verify?t=${token}` });
    expect(init.statusCode).toBe(202);
    expect(get.statusCode).toBe(200);
    expect(head.statusCode).toBe(200);
    expect(await onboarding.isVerified(TENANT_ID, "approver@example.com")).toBe(false);

    const post = await app.inject({
      method: "POST",
      url: "/surfaces/email/verify",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ t: token }).toString(),
    });

    expect(post.statusCode).toBe(200);
    expect(await onboarding.isVerified(TENANT_ID, "approver@example.com")).toBe(true);
  });

  it("verifies email domains from DNS checks before activating custom sender", async () => {
    const onboarding = new MemoryEmailOnboardingStore();
    const app = await makeApp({
      emailOnboarding: onboarding,
      emailVerificationSender: new MemoryEmailSender(),
      emailDomainVerifier: new MemoryDomainVerifier({
        domain: "Example.com",
        spfOk: true,
        dkimOk: true,
        dmarcOk: true,
      }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/surfaces/email/domains",
      headers: { "content-type": "application/json", authorization: bearer() },
      payload: JSON.stringify({
        tenantId: "tnt_wrong",
        domain: "Example.com",
        spfOk: false,
        dkimOk: false,
        dmarcOk: false,
      }),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      tenantId: TENANT_ID,
      domain: "example.com",
      verified: true,
      checks: { spf: true, dkim: true, dmarc: true },
    });
    expect(await onboarding.senderForTenant(TENANT_ID)).toBe("noreply@example.com");
    expect(await onboarding.senderForTenant("tnt_wrong")).toBeNull();
  });

  it("rejects expired or tampered email verification tokens", async () => {
    const onboarding = new MemoryEmailOnboardingStore();
    const app = await makeApp({ emailOnboarding: onboarding });
    const expired = signVerificationToken(
      verificationClaims({ exp: Math.floor(Date.now() / 1000) - 1 }),
      "email_secret",
    );
    const valid = signVerificationToken(
      verificationClaims({ exp: Math.floor(Date.now() / 1000) + 60 }),
      "email_secret",
    );

    const expiredRes = await app.inject({
      method: "POST",
      url: "/surfaces/email/verify",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ t: expired }).toString(),
    });
    const tampered = await app.inject({
      method: "POST",
      url: "/surfaces/email/verify",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ t: `${valid.slice(0, -1)}x` }).toString(),
    });

    expect(expiredRes.statusCode).toBe(400);
    expect(tampered.statusCode).toBe(400);
    expect(await onboarding.isVerified(TENANT_ID, "approver@example.com")).toBe(false);
  });

  it("expands smoke email routes to verified recipients only", async () => {
    const onboarding = new MemoryEmailOnboardingStore();
    await onboarding.verifyRecipient({
      tenantId: TENANT_ID,
      email: "verified@example.com",
      actorId: "user_verified",
      roles: ["finance"],
    });
    await onboarding.upsertRecipient({
      tenantId: TENANT_ID,
      email: "pending@example.com",
      actorId: "user_pending",
      roles: ["finance"],
    });
    await onboarding.setRoute({
      tenantId: TENANT_ID,
      agent: "invoice",
      recipients: ["verified@example.com", "pending@example.com"],
    });
    const targets: unknown[] = [];
    const app = await makeApp({
      emailOnboarding: onboarding,
      dispatcher: {
        async dispatch(_proposal: Proposal, deliveryTargets: unknown[]) {
          targets.push(...deliveryTargets);
          return [{ surface: "email", target: "verified@example.com", ok: true }];
        },
      },
      smoke: { enabled: true, secret: "smoke_secret" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/surfaces/smoke/proposals",
      headers: { "content-type": "application/json", "x-brain-smoke-secret": "smoke_secret" },
      payload: JSON.stringify({ proposal: sampleProposal() }),
    });

    expect(res.statusCode).toBe(202);
    expect(targets).toEqual([{ surface: "email", to: "verified@example.com" }]);
  });

  it("disables email recipients on bounce or complaint events and later skips sends", async () => {
    const onboarding = new MemoryEmailOnboardingStore();
    await onboarding.verifyRecipient({
      tenantId: TENANT_ID,
      email: "verified@example.com",
      actorId: "user_verified",
      roles: ["finance"],
    });
    await onboarding.setRoute({
      tenantId: TENANT_ID,
      agent: "invoice",
      recipients: ["verified@example.com"],
    });
    const targets: unknown[] = [];
    const app = await makeApp({
      emailOnboarding: onboarding,
      dispatcher: {
        async dispatch(_proposal: Proposal, deliveryTargets: unknown[]) {
          targets.push(...deliveryTargets);
          return [];
        },
      },
      smoke: { enabled: true, secret: "smoke_secret" },
    });
    const eventBody = JSON.stringify({
      type: "bounce",
      tenantId: TENANT_ID,
      email: "verified@example.com",
    });

    const event = await app.inject({
      method: "POST",
      url: "/surfaces/email/events",
      headers: {
        "content-type": "application/json",
        "x-brain-email-signature": emailEventSignature(eventBody),
      },
      payload: eventBody,
    });
    const smoke = await app.inject({
      method: "POST",
      url: "/surfaces/smoke/proposals",
      headers: { "content-type": "application/json", "x-brain-smoke-secret": "smoke_secret" },
      payload: JSON.stringify({ proposal: sampleProposal() }),
    });

    expect(event.statusCode).toBe(200);
    expect(smoke.statusCode).toBe(202);
    expect(targets).toEqual([]);
  });

  it("persists and dispatches a smoke proposal when explicitly enabled", async () => {
    const saved: Proposal[] = [];
    const dispatched: Proposal[] = [];
    const proposal = sampleProposal();
    const app = await makeApp({
      proposals: {
        async save({ proposal: p }: { proposal: Proposal }) {
          const hashed = withContentHash(p);
          saved.push(hashed);
          return hashed;
        },
      },
      dispatcher: {
        async dispatch(p: Proposal) {
          dispatched.push(p);
          return [{ surface: "email", target: "ops@example.com", ok: true }];
        },
      },
      smoke: { enabled: true, secret: "smoke_secret" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/surfaces/smoke/proposals",
      headers: { "content-type": "application/json", "x-brain-smoke-secret": "smoke_secret" },
      payload: JSON.stringify({
        proposal,
        targets: [{ surface: "email", to: "ops@example.com" }],
      }),
    });

    expect(res.statusCode).toBe(202);
    expect(saved).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
    expect(res.json()).toMatchObject({ proposal_id: proposal.id });
  });

  it("refuses to boot smoke proposals when enabled without a secret", async () => {
    await expect(makeApp({ smoke: { enabled: true } })).rejects.toThrow(
      /BRAIN_SURFACE_SMOKE_SECRET/,
    );
  });

  it("rejects smoke proposals with an invalid secret", async () => {
    const app = await makeApp({ smoke: { enabled: true, secret: "smoke_secret" } });

    const res = await app.inject({
      method: "POST",
      url: "/surfaces/smoke/proposals",
      headers: { "content-type": "application/json", "x-brain-smoke-secret": "wrong_secret" },
      payload: JSON.stringify({ proposal: sampleProposal() }),
    });

    expect(res.statusCode).toBe(401);
  });
});

async function makeApp(
  overrides: {
    approvals?: Partial<SurfaceRuntime["approvals"]>;
    dispatcher?: Partial<SurfaceRuntime["dispatcher"]>;
    proposals?: Record<string, unknown>;
    smoke?: { enabled: boolean; secret?: string };
    slackInstallations?: SlackInstallationStore | undefined;
    slackOAuthClient?: SlackOAuthClient | undefined;
    surfaceConfig?: SurfaceConfig | undefined;
    teamsVerifier?: TeamsActivityVerifier | undefined;
    teamsInstallations?: TeamsInstallationStore | undefined;
    teamsConversationReferences?: ConversationReferenceStore | undefined;
    emailOnboarding?: EmailOnboardingStore | undefined;
    emailVerificationSender?: EmailVerificationSender | undefined;
    emailDomainVerifier?: DomainVerifier | undefined;
    onboardingAdminVerifier?: OnboardingAdminVerifier | undefined;
  } = {},
  logLines: string[] = [],
): Promise<FastifyInstance> {
  const runtime = {
    approvals: {
      async handle() {
        return { status: "denied", reason: "test" };
      },
      ...overrides.approvals,
    },
    dispatcher: {
      async dispatch() {
        return [];
      },
      ...overrides.dispatcher,
    },
    surfaces: {},
  } as unknown as SurfaceRuntime;
  const proposals = {
    async load() {
      return sampleProposal();
    },
    async save({ proposal }: { proposal: Proposal }) {
      return withContentHash(proposal);
    },
    async saveDeliveredRef() {},
    ...overrides.proposals,
  };
  let slackInstallations = overrides.slackInstallations;
  if (slackInstallations === undefined) {
    const memoryInstallations = new MemorySlackInstallationStore();
    memoryInstallations.addActive(TENANT_ID, "T_1", "xoxb-test");
    slackInstallations = memoryInstallations;
  }
  const app = await buildSurfaceGatewayApp({
    runtime,
    surfaceConfig: overrides.surfaceConfig ?? surfaceConfig(),
    proposals: proposals as never,
    slackRetries: new MemorySlackRetryStore(),
    slackInstallations,
    slackOAuthClient: overrides.slackOAuthClient,
    teamsVerifier: overrides.teamsVerifier,
    teamsInstallations: overrides.teamsInstallations,
    teamsConversationReferences: overrides.teamsConversationReferences,
    emailOnboarding: overrides.emailOnboarding,
    emailVerificationSender: overrides.emailVerificationSender,
    emailDomainVerifier: overrides.emailDomainVerifier,
    onboardingAdminVerifier:
      overrides.onboardingAdminVerifier ?? new MemoryOnboardingAdminVerifier(),
    approvalBaseUrl: "http://localhost:3000",
    smoke: overrides.smoke,
    logger: memoryLogger(logLines) as never,
  });
  apps.push(app);
  return app;
}

class MemorySlackInstallationStore implements SlackInstallationStore {
  public installed:
    | {
        tenantId: string;
        teamId: string;
        botToken: string;
        botUserId: string;
        scopes: string[];
        installedBy: string;
      }
    | undefined;
  public readonly revokedTeams: string[] = [];
  public readonly createdNonces: Array<{
    tenantId: string;
    nonce: string;
    installedBy: string;
    expiresAt: Date;
  }> = [];
  private readonly nonces = new Map<string, { expiresAt: Date; consumed: boolean }>();
  private readonly installations = new Map<
    string,
    { tenantId: string; teamId: string; botToken: string; status: "active" | "revoked" }
  >();

  public addActive(tenantId: string, teamId: string, botToken: string): void {
    this.installations.set(teamId, { tenantId, teamId, botToken, status: "active" });
  }

  public async createInstallNonce(input: {
    tenantId: string;
    nonce: string;
    installedBy: string;
    expiresAt: Date;
  }): Promise<void> {
    this.createdNonces.push(input);
    this.nonces.set(`${input.tenantId}:${input.nonce}`, {
      expiresAt: input.expiresAt,
      consumed: false,
    });
  }

  public async consumeInstallNonce(input: {
    tenantId: string;
    nonce: string;
    now: Date;
  }): Promise<boolean> {
    const key = `${input.tenantId}:${input.nonce}`;
    const existing = this.nonces.get(key);
    if (existing === undefined || existing.consumed || existing.expiresAt <= input.now) {
      return false;
    }
    existing.consumed = true;
    return true;
  }

  public async upsertInstallation(input: {
    tenantId: string;
    teamId: string;
    botToken: string;
    botUserId: string;
    scopes: string[];
    installedBy: string;
  }): Promise<void> {
    this.installed = input;
    this.addActive(input.tenantId, input.teamId, input.botToken);
  }

  public async getInstallationForTenantTeam(input: {
    tenantId: string;
    teamId: string;
  }): Promise<{ status: "active" | "revoked" } | null> {
    const installation = this.installations.get(input.teamId);
    if (installation === undefined || installation.tenantId !== input.tenantId) return null;
    return { status: installation.status };
  }

  public async getInstallationByTeam(teamId: string): Promise<{ tenantId: string } | null> {
    const installation = this.installations.get(teamId);
    if (installation === undefined) return null;
    return { tenantId: installation.tenantId };
  }

  public async revoke(teamId: string): Promise<void> {
    const installation = this.installations.get(teamId);
    if (installation !== undefined) installation.status = "revoked";
    this.revokedTeams.push(teamId);
  }

  public async getTokenForTenant(tenantId: string): Promise<string | null> {
    for (const installation of this.installations.values()) {
      if (installation.tenantId === tenantId && installation.status === "active") {
        return installation.botToken;
      }
    }
    return null;
  }
}

class MemorySlackOAuthClient implements SlackOAuthClient {
  public readonly exchangeCalls: string[] = [];

  public async exchangeCode(input: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri?: string | undefined;
  }): Promise<{ teamId: string; botToken: string; botUserId: string; scopes: string[] }> {
    this.exchangeCalls.push(input.code);
    return {
      teamId: "T_oauth",
      botToken: "xoxb-oauth-token",
      botUserId: "B_oauth",
      scopes: [...SLACK_BOT_SCOPES],
    };
  }
}

class MemoryTeamsInstallationStore implements TeamsInstallationStore {
  public lastActivity:
    | { brainTenantId: string; aadTenantId: string; serviceUrl?: string | undefined }
    | undefined;
  private readonly installations = new Map<
    string,
    {
      brainTenantId: string;
      aadTenantId: string;
      serviceUrl?: string | undefined;
      installedBy: string;
      status: "active" | "revoked";
    }
  >();

  public async upsertInstallation(input: {
    brainTenantId: string;
    aadTenantId: string;
    serviceUrl?: string | undefined;
    installedBy: string;
  }): Promise<void> {
    this.installations.set(input.aadTenantId, { ...input, status: "active" });
  }

  public async resolveBrainTenant(aadTenantId: string): Promise<{
    brainTenantId: string;
    aadTenantId: string;
    serviceUrl?: string | undefined;
    status: "active" | "revoked";
  } | null> {
    return this.installations.get(aadTenantId) ?? null;
  }

  public async recordActivity(input: {
    brainTenantId: string;
    aadTenantId: string;
    serviceUrl?: string | undefined;
  }): Promise<void> {
    this.lastActivity = input;
  }

  public async revoke(aadTenantId: string): Promise<void> {
    const installation = this.installations.get(aadTenantId);
    if (installation !== undefined) installation.status = "revoked";
  }
}

class MemoryConversationReferenceStore implements ConversationReferenceStore {
  private readonly refs = new Map<string, Partial<ConversationReference>>();

  public async get(to: string): Promise<Partial<ConversationReference> | null> {
    return this.refs.get(to) ?? null;
  }

  public async set(to: string, reference: Partial<ConversationReference>): Promise<void> {
    this.refs.set(to, reference);
  }
}

class MemoryTeamsVerifier implements TeamsActivityVerifier {
  public constructor(private readonly result: VerifiedTeamsSubmit | null) {}

  public async verify(): Promise<VerifiedTeamsSubmit | null> {
    return this.result;
  }
}

class MemoryEmailOnboardingStore implements EmailOnboardingStore {
  private readonly recipients = new Map<
    string,
    {
      actorId: string;
      roles: string[];
      verified: boolean;
      status: "pending" | "active" | "disabled";
    }
  >();
  private readonly routes = new Map<string, string[]>();
  private readonly domains = new Map<
    string,
    { domain: string; verified: boolean; status: "pending" | "active" | "disabled" }
  >();

  public async upsertRecipient(input: {
    tenantId: string;
    email: string;
    actorId: string;
    roles: string[];
  }): Promise<void> {
    this.recipients.set(recipientKey(input.tenantId, input.email), {
      actorId: input.actorId,
      roles: input.roles,
      verified: false,
      status: "pending",
    });
  }

  public async verifyRecipient(input: {
    tenantId: string;
    email: string;
    actorId: string;
    roles: string[];
  }): Promise<void> {
    this.recipients.set(recipientKey(input.tenantId, input.email), {
      actorId: input.actorId,
      roles: input.roles,
      verified: true,
      status: "active",
    });
  }

  public async disableRecipient(input: { tenantId: string; email: string }): Promise<void> {
    const existing = this.recipients.get(recipientKey(input.tenantId, input.email));
    if (existing !== undefined) existing.status = "disabled";
  }

  public async setRoute(input: {
    tenantId: string;
    agent: "invoice" | "collections" | "cash" | "close";
    recipients: string[];
  }): Promise<void> {
    this.routes.set(`${input.tenantId}:${input.agent}`, input.recipients.map(normalizeEmail));
  }

  public async resolveRoute(input: {
    tenantId: string;
    agent: "invoice" | "collections" | "cash" | "close";
  }): Promise<string[]> {
    return this.filterVerifiedRecipients({
      tenantId: input.tenantId,
      recipients: this.routes.get(`${input.tenantId}:${input.agent}`) ?? [],
    });
  }

  public async filterVerifiedRecipients(input: {
    tenantId: string;
    recipients: string[];
  }): Promise<string[]> {
    return input.recipients.map(normalizeEmail).filter((email) => {
      const recipient = this.recipients.get(recipientKey(input.tenantId, email));
      return recipient?.verified === true && recipient.status === "active";
    });
  }

  public async upsertDomain(input: {
    tenantId: string;
    domain: string;
    spfOk: boolean;
    dkimOk: boolean;
    dmarcOk: boolean;
    status?: "pending" | "active" | "disabled" | undefined;
  }): Promise<void> {
    const verified = input.spfOk && input.dkimOk && input.dmarcOk;
    this.domains.set(`${input.tenantId}:${input.domain.toLowerCase()}`, {
      domain: input.domain.toLowerCase(),
      verified,
      status: input.status ?? (verified ? "active" : "pending"),
    });
  }

  public async senderForTenant(tenantId: string): Promise<string | null> {
    for (const [key, domain] of this.domains.entries()) {
      if (key.startsWith(`${tenantId}:`) && domain.verified && domain.status === "active") {
        return `noreply@${domain.domain}`;
      }
    }
    return null;
  }

  public async isVerified(tenantId: string, email: string): Promise<boolean> {
    const recipient = this.recipients.get(recipientKey(tenantId, email));
    return recipient?.verified === true && recipient.status === "active";
  }
}

class MemoryOnboardingAdminVerifier implements OnboardingAdminVerifier {
  public constructor(private readonly invalidToken: string | null = null) {}

  public async verify(token: string): Promise<Principal> {
    if (token === this.invalidToken) {
      throw brainError("auth_token_invalid", "invalid token");
    }
    const scopes: Scope[] = token === "tenant-reader" ? ["audit:read"] : ["surfaces:admin"];
    return {
      id: "user_admin",
      type: "user",
      tenantId: TENANT_ID,
      scopes,
      tokenId: "token_admin",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    };
  }
}

class MemoryDomainVerifier implements DomainVerifier {
  public constructor(
    private readonly result = {
      domain: "example.com",
      spfOk: true,
      dkimOk: true,
      dmarcOk: true,
    },
  ) {}

  public async verify(): Promise<{
    domain: string;
    spfOk: boolean;
    dkimOk: boolean;
    dmarcOk: boolean;
  }> {
    return { ...this.result, domain: this.result.domain.toLowerCase() };
  }
}

class MemoryEmailSender implements EmailVerificationSender {
  public readonly sent: Array<{
    tenantId: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }> = [];

  public async send(input: {
    tenantId: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    this.sent.push(input);
    return { ok: true, messageId: "msg_1" };
  }
}

class MemorySlackRetryStore {
  private readonly seen = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

function memoryLogger(lines: string[]): Record<string, unknown> {
  return {
    info(value: unknown) {
      lines.push(JSON.stringify(value));
    },
    error(value: unknown) {
      lines.push(JSON.stringify(value));
    },
    warn(value: unknown) {
      lines.push(JSON.stringify(value));
    },
    debug(value: unknown) {
      lines.push(JSON.stringify(value));
    },
    trace(value: unknown) {
      lines.push(JSON.stringify(value));
    },
    fatal(value: unknown) {
      lines.push(JSON.stringify(value));
    },
    child() {
      return memoryLogger(lines);
    },
  };
}

function surfaceConfig(): SurfaceConfig {
  return {
    slack: {
      enabled: true,
      signingSecret: SIGNING_SECRET,
      botToken: "xoxb-test",
      clientId: "slack-client-id",
      clientSecret: "slack-client-secret",
      installStateSecret: "slack-install-state-secret",
    },
    teams: { enabled: false, appId: "", appPassword: "" },
    email: {
      enabled: true,
      approvalBaseUrl: "http://localhost:3000/surfaces/email/approve",
      tokenSecret: "email_secret",
      espWebhookSecret: "email-event-secret",
    },
  };
}

function teamsSurfaceConfig(): SurfaceConfig {
  return {
    ...surfaceConfig(),
    teams: {
      enabled: true,
      appId: "teams-app-id",
      appPassword: "teams-app-password",
    },
  };
}

function teamsSubmit(
  overrides: Partial<NonNullable<VerifiedTeamsSubmit["submit"]>> = {},
): VerifiedTeamsSubmit {
  return {
    submit: {
      brainDecision: "approved",
      tenantId: TENANT_ID,
      proposalId: "prop_1",
      ...overrides,
    },
    aadObjectId: "aad-user-1",
    aadTenantId: "aad-tenant-1",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    conversationId: "teams-conv-1",
    conversationRef: `${TENANT_ID}:teams-conv-1`,
    conversationReference: {
      channelId: "msteams",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      conversation: {
        id: "teams-conv-1",
        isGroup: true,
        conversationType: "channel",
        name: "Finance",
      },
    },
    activityId: "activity-1",
  };
}

function slackBody(teamId = "T_1"): string {
  return new URLSearchParams({
    payload: JSON.stringify({
      team: { id: teamId },
      user: { id: "U_1" },
      channel: { id: "C_1" },
      message: { ts: "1700000000.000100" },
      actions: [{ action_id: `brain:approve:${TENANT_ID}:prop_1`, value: "prop_1" }],
    }),
  }).toString();
}

function slackSignature(rawBody: string, timestamp: string): string {
  return `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
}

function emailEventSignature(rawBody: string): string {
  return `v1=${createHmac("sha256", "email-event-secret").update(rawBody).digest("hex")}`;
}

function bearer(token = "tenant-admin"): string {
  return `Bearer ${token}`;
}

function extractToken(text: string): string {
  const match = /[?&]t=(\S+)/.exec(text);
  expect(match?.[1]).toBeTruthy();
  return match![1]!;
}

function verificationClaims(
  overrides: Partial<EmailVerificationTokenClaims> = {},
): EmailVerificationTokenClaims {
  return {
    purpose: "email_recipient_verification",
    tenantId: TENANT_ID,
    email: "approver@example.com",
    actorId: "user_approver",
    roles: ["finance"],
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  };
}

function recipientKey(tenantId: string, email: string): string {
  return `${tenantId}:${normalizeEmail(email)}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sampleProposal(): Proposal {
  return withContentHash({
    id: "prop_1",
    tenantId: TENANT_ID,
    agent: "invoice",
    severity: "warning",
    title: "Duplicate invoice",
    claim: "Vendor invoice appears to be a duplicate.",
    evidence: [{ label: "Invoice", value: "INV-1" }],
    action: { summary: "Hold payment", handoff: "erp", payload: {} },
    policy: { gates: ["ROLE"], approverRoles: ["approver"], requiresDualApproval: false },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  });
}

async function flushBackground(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
