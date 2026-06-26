import { createHmac } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ApprovalService,
  SurfaceRegistry,
  buildInvoiceProposal,
  handleEmailApproval,
  handleSlackInteraction,
  signToken,
  toActorId,
  toPlainOutcome,
  verifySlackRequest,
  withContentHash,
  type ApprovalOutcome,
  type BrainCorePorts,
  type Proposal,
  type TerminalDecisionRecord,
} from "../src/index.js";
import { encodeAction } from "../src/surfaces/slack/blockkit.js";

const SIGNING_SECRET = "slack_secret";

function sampleProposal(expiresAt = new Date(Date.now() + 86_400_000).toISOString()): Proposal {
  return withContentHash(
    buildInvoiceProposal({
      tenantId: "t_1",
      vendorName: "Acme Supplies",
      invoiceNumber: "INV-4821",
      amountMinorUnits: 1_250_000,
      currency: "USD",
      reason: "duplicate",
      handoffPayload: { billId: "b_99" },
      approverRoles: ["ap_lead"],
      expiresAt,
    }),
  );
}

function makeSlackSignature(rawBody: string, timestamp: string): string {
  return `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
}

function slackBody(proposal: Proposal, responseUrl = "https://hooks.slack.test/response"): string {
  const payload = {
    user: { id: "U_slack" },
    channel: { id: "C_ap" },
    message: { ts: "1700000000.000100" },
    response_url: responseUrl,
    actions: [{ action_id: encodeAction("approve", proposal), value: proposal.id }],
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

function fakeApprovals(handle: ApprovalService["handle"]): ApprovalService {
  return { handle } as unknown as ApprovalService;
}

async function flushBackground(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function decisions(): BrainCorePorts["decisions"] {
  const records = new Map<string, TerminalDecisionRecord>();
  return {
    async claimTerminal(record) {
      const key = `${record.tenantId}:${record.proposalId}`;
      const existing = records.get(key);
      if (existing) return { status: "already_decided", record: existing };
      records.set(key, { ...record, applied: false });
      return { status: "claimed" };
    },
    async markTerminalApplied(record) {
      const key = `${record.tenantId}:${record.proposalId}`;
      records.set(key, { ...record, applied: true });
    },
  };
}

function approvalService(input: {
  proposal: Proposal;
  policy?: BrainCorePorts["policy"] | undefined;
  counters?: { audit: number; execute: number } | undefined;
}): ApprovalService {
  const counters = input.counters ?? { audit: 0, execute: 0 };
  const ports: BrainCorePorts = {
    identity: {
      async resolve() {
        return { actorId: toActorId("a_1"), roles: ["ap_lead"] };
      },
    },
    policy:
      input.policy ??
      ({
        async canDecide() {
          return { allowed: true };
        },
      } satisfies BrainCorePorts["policy"]),
    audit: {
      async record() {
        counters.audit += 1;
      },
    },
    execution: {
      async enqueue() {
        counters.execute += 1;
      },
    },
    decisions: decisions(),
  };
  return new ApprovalService(ports, new SurfaceRegistry(), async () => input.proposal);
}

test("Slack request verification accepts a valid signature", () => {
  const rawBody = "payload=%7B%7D";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const result = verifySlackRequest({
    rawBody,
    timestamp,
    signature: makeSlackSignature(rawBody, timestamp),
    signingSecret: SIGNING_SECRET,
  });
  assert.deepEqual(result, { ok: true });
});

test("Slack request verification rejects stale and tampered requests", () => {
  const rawBody = "payload=%7B%7D";
  const nowMs = Date.now();
  const staleTimestamp = String(Math.floor((nowMs - 301_000) / 1000));
  const freshTimestamp = String(Math.floor(nowMs / 1000));

  assert.deepEqual(
    verifySlackRequest({
      rawBody,
      timestamp: staleTimestamp,
      signature: makeSlackSignature(rawBody, staleTimestamp),
      signingSecret: SIGNING_SECRET,
      nowMs,
    }),
    { ok: false, reason: "stale" },
  );

  assert.deepEqual(
    verifySlackRequest({
      rawBody: `${rawBody}tampered`,
      timestamp: freshTimestamp,
      signature: makeSlackSignature(rawBody, freshTimestamp),
      signingSecret: SIGNING_SECRET,
      nowMs,
    }),
    { ok: false, reason: "bad_signature" },
  );
});

test("Slack interaction acks before approval handling settles", async () => {
  const proposal = sampleProposal();
  const rawBody = slackBody(proposal);
  const timestamp = String(Math.floor(Date.now() / 1000));
  let settled = false;
  let release!: (outcome: ApprovalOutcome) => void;
  const approvalPromise = new Promise<ApprovalOutcome>((resolve) => {
    release = resolve;
  });

  const response = await handleSlackInteraction({
    rawBody,
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": makeSlackSignature(rawBody, timestamp),
    },
    signingSecret: SIGNING_SECRET,
    approvals: fakeApprovals(async () => {
      const outcome = await approvalPromise;
      settled = true;
      return outcome;
    }),
    async outcomePoster() {},
  });

  assert.equal(response.status, 200);
  assert.equal(settled, false);
  release({ status: "applied", decision: "approved", actorLabel: "a_1" });
  await flushBackground();
  assert.equal(settled, true);
});

test("Slack interaction catches and logs approval errors", async () => {
  const proposal = sampleProposal();
  const rawBody = slackBody(proposal);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const logged: unknown[] = [];

  const response = await handleSlackInteraction({
    rawBody,
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": makeSlackSignature(rawBody, timestamp),
    },
    signingSecret: SIGNING_SECRET,
    approvals: fakeApprovals(async () => {
      throw new Error("boom");
    }),
    logger: {
      error(_message, error) {
        logged.push(error);
      },
    },
    async outcomePoster() {
      throw new Error("should_not_post");
    },
  });

  assert.equal(response.status, 200);
  await flushBackground();
  assert.equal(logged.length, 1);
});

test("Slack interaction posts mapped outcomes", async () => {
  const proposal = sampleProposal();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const outcomes: ApprovalOutcome[] = [
    { status: "applied", decision: "approved", actorLabel: "a_1" },
    { status: "denied", reason: "not authorized" },
    { status: "expired" },
    {
      status: "already_decided",
      decision: "approved",
      actorLabel: "a_2",
      decidedAt: new Date().toISOString(),
    },
  ];
  const expected = [/Approved/, /Denied. not authorized/, /Expired/, /Already decided by a_2/];

  for (const [index, outcome] of outcomes.entries()) {
    const posted: string[] = [];
    const rawBody = slackBody(proposal, `https://hooks.slack.test/${index}`);
    const response = await handleSlackInteraction({
      rawBody,
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": makeSlackSignature(rawBody, timestamp),
      },
      signingSecret: SIGNING_SECRET,
      approvals: fakeApprovals(async () => outcome),
      async outcomePoster(input) {
        posted.push(input.message.text);
      },
    });

    assert.equal(response.status, 200);
    await flushBackground();
    assert.equal(posted.length, 1);
    assert.match(posted[0] ?? "", expected[index] ?? /$a/);
  }
});

test("Email approval GET confirms without applying and POST applies", async () => {
  const proposal = sampleProposal();
  const counters = { audit: 0, execute: 0 };
  const token = signToken(
    {
      tenantId: proposal.tenantId,
      proposalId: proposal.id,
      decision: "approved",
      recipient: "ap@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    "email_secret",
  );

  const getResponse = await handleEmailApproval({
    method: "GET",
    url: `https://approvals.example.test/?t=${encodeURIComponent(token)}`,
    tokenSecret: "email_secret",
    approvals: approvalService({ proposal, counters }),
    async loadProposalTitle() {
      return proposal.title;
    },
  });

  assert.equal(getResponse.status, 200);
  assert.match(getResponse.body, /Confirm approve/);
  assert.match(getResponse.body, new RegExp(proposal.title));
  assert.equal(counters.audit, 0);
  assert.equal(counters.execute, 0);

  const postResponse = await handleEmailApproval({
    method: "POST",
    url: "https://approvals.example.test/",
    body: new URLSearchParams({ t: token }),
    tokenSecret: "email_secret",
    approvals: approvalService({ proposal, counters }),
  });

  assert.equal(postResponse.status, 200);
  assert.match(postResponse.body, /Approved/);
  assert.equal(counters.audit, 1);
  assert.equal(counters.execute, 1);
});

test("Email approval HEAD confirms without applying", async () => {
  const proposal = sampleProposal();
  const counters = { audit: 0, execute: 0 };
  const token = signToken(
    {
      tenantId: proposal.tenantId,
      proposalId: proposal.id,
      decision: "approved",
      recipient: "ap@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    "email_secret",
  );

  const response = await handleEmailApproval({
    method: "HEAD",
    url: `https://approvals.example.test/?t=${encodeURIComponent(token)}`,
    tokenSecret: "email_secret",
    approvals: approvalService({ proposal, counters }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body, "");
  assert.equal(counters.audit, 0);
  assert.equal(counters.execute, 0);
});

test("Email approval token rejects expired, wrong-secret, and tampered links", async () => {
  const proposal = sampleProposal();
  const expired = signToken(
    {
      tenantId: proposal.tenantId,
      proposalId: proposal.id,
      decision: "approved",
      recipient: "ap@example.com",
      exp: Math.floor(Date.now() / 1000) - 1,
    },
    "email_secret",
  );
  const valid = signToken(
    {
      tenantId: proposal.tenantId,
      proposalId: proposal.id,
      decision: "approved",
      recipient: "ap@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    "email_secret",
  );

  const service = approvalService({ proposal });
  const expiredResponse = await handleEmailApproval({
    method: "GET",
    url: `https://approvals.example.test/?t=${expired}`,
    tokenSecret: "email_secret",
    approvals: service,
  });
  const wrongSecretResponse = await handleEmailApproval({
    method: "POST",
    url: `https://approvals.example.test/?t=${valid}`,
    body: new URLSearchParams({ t: valid }),
    tokenSecret: "wrong",
    approvals: service,
  });
  const tamperedResponse = await handleEmailApproval({
    method: "POST",
    url: "https://approvals.example.test/",
    body: new URLSearchParams({ t: `${valid.slice(0, -1)}x` }),
    tokenSecret: "email_secret",
    approvals: service,
  });
  const missingResponse = await handleEmailApproval({
    method: "POST",
    url: "https://approvals.example.test/",
    tokenSecret: "email_secret",
    approvals: service,
  });

  assert.equal(expiredResponse.status, 400);
  assert.equal(wrongSecretResponse.status, 400);
  assert.equal(tamperedResponse.status, 400);
  assert.equal(missingResponse.status, 400);
  assert.match(missingResponse.body, /Unknown/);
});

test("Dual approval does not enqueue until policy returns terminal approval", async () => {
  const proposal = sampleProposal();
  const counters = { audit: 0, execute: 0 };
  const service = approvalService({
    proposal,
    counters,
    policy: {
      async canDecide() {
        return { allowed: true, awaitingSecondApproval: true };
      },
    },
  });

  const outcome = await service.handle({
    surface: "email",
    proposalId: proposal.id,
    tenantId: proposal.tenantId,
    externalActorId: "ap@example.com",
    decision: "approved",
  });

  assert.equal(outcome.status, "awaiting_second_approval");
  assert.equal(counters.audit, 1);
  assert.equal(counters.execute, 0);
  assert.equal(toPlainOutcome(outcome), "pending");
});

test("Expired proposal clicks do not audit or enqueue", async () => {
  const proposal = sampleProposal(new Date(Date.now() - 60_000).toISOString());
  const counters = { audit: 0, execute: 0 };
  const service = approvalService({ proposal, counters });

  const outcome = await service.handle({
    surface: "slack",
    proposalId: proposal.id,
    tenantId: proposal.tenantId,
    externalActorId: "U_slack",
    decision: "approved",
  });

  assert.equal(outcome.status, "expired");
  assert.equal(counters.audit, 0);
  assert.equal(counters.execute, 0);
});
