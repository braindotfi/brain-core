import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { SurfaceRuntime } from "@brain/core";
import { signToken, withContentHash, type Proposal, type SurfaceConfig } from "@brain/surfaces";
import { buildSurfaceGatewayApp, type SlackInstallationStore } from "../src/server.js";
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
        "x-brain-slack-install-secret": "install-secret",
      },
      payload: JSON.stringify({ tenantId: TENANT_ID, installedBy: "user_admin" }),
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
    expect(lines.join("\n")).not.toContain("xoxb-oauth-token");
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
});

async function makeApp(
  overrides: {
    approvals?: Partial<SurfaceRuntime["approvals"]>;
    dispatcher?: Partial<SurfaceRuntime["dispatcher"]>;
    proposals?: Record<string, unknown>;
    smoke?: { enabled: boolean; secret?: string };
    slackInstallations?: SlackInstallationStore | undefined;
    slackOAuthClient?: SlackOAuthClient | undefined;
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
    surfaceConfig: surfaceConfig(),
    proposals: proposals as never,
    slackRetries: new MemorySlackRetryStore(),
    slackInstallations,
    slackOAuthClient: overrides.slackOAuthClient,
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
      installAdminSecret: "install-secret",
    },
    teams: { enabled: false, appId: "", appPassword: "" },
    email: {
      enabled: true,
      approvalBaseUrl: "http://localhost:3000/surfaces/email/approve",
      tokenSecret: "email_secret",
    },
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
