import { createHmac } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ApprovalService,
  SurfaceRegistry,
  buildInvoiceProposal,
  handleEmailApproval,
  signToken,
  toActorId,
  verifySlackRequest,
  withContentHash,
  type BrainCorePorts,
  type Proposal,
  type TerminalDecisionRecord,
} from "../src/index.js";

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

function decisions(): BrainCorePorts["decisions"] {
  const records = new Map<string, TerminalDecisionRecord>();
  return {
    async claimTerminal(record) {
      const key = `${record.tenantId}:${record.proposalId}`;
      const existing = records.get(key);
      if (existing) return { status: "already_decided", record: existing };
      records.set(key, record);
      return { status: "claimed" };
    },
    async markTerminalApplied() {},
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

test("Email approval token accepts valid links", async () => {
  const proposal = sampleProposal();
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
    url: `https://approvals.example.test/?t=${encodeURIComponent(token)}`,
    tokenSecret: "email_secret",
    approvals: approvalService({ proposal }),
  });

  assert.equal(response.status, 200);
  assert.match(response.body, /Approved/);
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
    url: `https://approvals.example.test/?t=${expired}`,
    tokenSecret: "email_secret",
    approvals: service,
  });
  const wrongSecretResponse = await handleEmailApproval({
    url: `https://approvals.example.test/?t=${valid}`,
    tokenSecret: "wrong",
    approvals: service,
  });
  const tamperedResponse = await handleEmailApproval({
    url: `https://approvals.example.test/?t=${valid.slice(0, -1)}x`,
    tokenSecret: "email_secret",
    approvals: service,
  });

  assert.equal(expiredResponse.status, 400);
  assert.equal(wrongSecretResponse.status, 400);
  assert.equal(tamperedResponse.status, 400);
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
