import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { SurfaceRuntime } from "@brain/core";
import { signToken, withContentHash, type Proposal, type SurfaceConfig } from "@brain/surfaces";
import { buildSurfaceGatewayApp } from "../src/server.js";

const SIGNING_SECRET = "slack_secret";

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
  const app = await buildSurfaceGatewayApp({
    runtime,
    surfaceConfig: surfaceConfig(),
    proposals: proposals as never,
    slackRetries: new MemorySlackRetryStore(),
    approvalBaseUrl: "http://localhost:3000",
    smoke: overrides.smoke,
    logger: memoryLogger(logLines) as never,
  });
  apps.push(app);
  return app;
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
    slack: { enabled: true, signingSecret: SIGNING_SECRET, botToken: "xoxb-test" },
    teams: { enabled: false, appId: "", appPassword: "" },
    email: {
      enabled: true,
      approvalBaseUrl: "http://localhost:3000/surfaces/email/approve",
      tokenSecret: "email_secret",
    },
  };
}

function slackBody(): string {
  return new URLSearchParams({
    payload: JSON.stringify({
      user: { id: "U_1" },
      channel: { id: "C_1" },
      message: { ts: "1700000000.000100" },
      actions: [{ action_id: "brain:approve:tnt_1:prop_1", value: "prop_1" }],
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
    tenantId: "tnt_1",
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
