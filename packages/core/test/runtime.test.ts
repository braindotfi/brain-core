import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildInvoiceProposal,
  withContentHash,
  toActorId,
  type Proposal,
  type SlackClient,
} from "@brain/surfaces";
import { buildSurfaceRuntime } from "../src/composition/surfaceRuntime.js";
import type { CoreServices } from "../src/internal/services.js";

function sampleProposal(): Proposal {
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
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }),
  );
}

/** In-memory stand-ins for the real brain-core services. */
function fakeServices(
  proposal: Proposal,
  record: { audited: boolean; approved: boolean; executed: boolean; deliveredRefs: string[] },
): CoreServices {
  const decisions = new Map<
    string,
    {
      tenantId: string;
      proposalId: string;
      decision: "approved" | "rejected";
      actorId: ReturnType<typeof toActorId>;
      decidedAt: string;
      applied: boolean;
    }
  >();
  return {
    identity: {
      async lookupActor() {
        return { actorId: toActorId("a_1"), roles: ["ap_lead"] };
      },
    },
    policy: {
      async evaluateDecision() {
        return { allowed: true };
      },
    },
    audit: {
      async append() {
        record.audited = true;
      },
    },
    approvals: {
      async recordApproval() {
        record.approved = true;
        return { quorumMet: true };
      },
    },
    execution: {
      async enqueueIdempotent() {
        record.executed = true;
      },
    },
    decisions: {
      async claimTerminal(input) {
        const key = `${input.tenantId}:${input.proposalId}`;
        const existing = decisions.get(key);
        if (existing) return { status: "already_decided", record: existing };
        decisions.set(key, { ...input, applied: false });
        return { status: "claimed" };
      },
      async markTerminalApplied(input) {
        const key = `${input.tenantId}:${input.proposalId}`;
        decisions.set(key, { ...input, applied: true });
      },
    },
    proposals: {
      async load() {
        return proposal;
      },
      async saveDeliveredRef(input) {
        record.deliveredRefs.push(input.ref);
      },
    },
  };
}

test("composed runtime dispatches to Slack and approves end to end", async () => {
  const proposal = sampleProposal();
  const record = {
    audited: false,
    approved: false,
    executed: false,
    deliveredRefs: [] as string[],
  };
  const posted: string[] = [];

  const slack: SlackClient = {
    async postMessage(args) {
      posted.push(args.channel);
      return { ok: true, ts: "ts_1" };
    },
    async update() {
      return { ok: true };
    },
  };

  const runtime = buildSurfaceRuntime({
    services: fakeServices(proposal, record),
    config: {
      slack: { enabled: true, signingSecret: "s", botToken: "b" },
      teams: { enabled: false, appId: "", appPassword: "" },
      email: { enabled: false, approvalBaseUrl: "", tokenSecret: "" },
    },
    clients: { slack },
  });

  const delivery = await runtime.dispatcher.dispatch(proposal, [{ surface: "slack", to: "C_AP" }]);
  assert.equal(delivery[0]?.ok, true);
  assert.deepEqual(posted, ["C_AP"]);
  assert.deepEqual(record.deliveredRefs, ["ts_1"]);

  const outcome = await runtime.approvals.handle(
    {
      surface: "slack",
      proposalId: proposal.id,
      tenantId: proposal.tenantId,
      externalActorId: "U_slack",
      decision: "approved",
    },
    "ts_1",
  );

  assert.equal(outcome.status, "applied");
  assert.equal(record.audited, true);
  assert.equal(record.approved, true);
  assert.equal(record.executed, true);
});
