import { test } from "node:test";
import assert from "node:assert/strict";

import { buildInvoiceProposal } from "../src/agents/invoice.js";
import { hashProposal, withContentHash } from "../src/proposal/hash.js";
import { SurfaceRegistry } from "../src/core/registry.js";
import { Dispatcher } from "../src/core/dispatcher.js";
import { ApprovalService } from "../src/core/approval.js";
import type { SurfaceAdapter } from "../src/surfaces/surface.js";
import type { Proposal } from "../src/proposal/schema.js";
import { toActorId } from "../src/proposal/schema.js";
import type { BrainCorePorts } from "../src/core/ports.js";
import type { TerminalDecisionRecord } from "../src/core/ports.js";

function sampleProposal(): Proposal {
  return buildInvoiceProposal({
    tenantId: "t_1",
    vendorName: "Acme Supplies",
    invoiceNumber: "INV-4821",
    amountMinorUnits: 1250000,
    currency: "USD",
    reason: "duplicate",
    handoffPayload: { billId: "b_99" },
    approverRoles: ["ap_lead", "controller"],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
}

function memoryDecisions(): BrainCorePorts["decisions"] {
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

test("hash is deterministic and ignores field order", () => {
  const p = sampleProposal();
  const a = hashProposal(p);
  const reordered: Proposal = {
    ...p,
    evidence: [...p.evidence],
  };
  assert.equal(a, hashProposal(reordered));
});

test("dispatcher validates, hashes, and delivers to a surface", async () => {
  const delivered: Proposal[] = [];
  const persisted: string[] = [];
  const stub: SurfaceAdapter = {
    name: "slack",
    async deliver(p, to) {
      delivered.push(p);
      return { surface: "slack", target: to, ok: true, ref: "ts_1" };
    },
    async updateDecision() {},
  };
  const registry = new SurfaceRegistry().register(stub);
  const dispatcher = new Dispatcher(registry, {
    async onDelivered({ result }) {
      if (result.ref) persisted.push(result.ref);
    },
  });

  const results = await dispatcher.dispatch(sampleProposal(), [{ surface: "slack", to: "C123" }]);

  assert.equal(results[0]?.ok, true);
  assert.equal(delivered.length, 1);
  assert.ok(delivered[0]?.contentHash, "proposal should be hashed before delivery");
  assert.deepEqual(persisted, ["ts_1"]);
});

test("approval pipeline denies an actor the policy gate rejects", async () => {
  const proposal = withContentHash(sampleProposal());
  let executed = false;
  let audited = false;

  const ports: BrainCorePorts = {
    identity: {
      async resolve() {
        return { actorId: toActorId("a_1"), roles: ["viewer"] };
      },
    },
    policy: {
      async canDecide() {
        return { allowed: false, reason: "viewer cannot approve payments" };
      },
    },
    audit: {
      async record() {
        audited = true;
      },
    },
    execution: {
      async enqueue() {
        executed = true;
      },
    },
    decisions: memoryDecisions(),
  };

  const registry = new SurfaceRegistry();
  const service = new ApprovalService(ports, registry, async () => proposal);

  const outcome = await service.handle({
    surface: "slack",
    proposalId: proposal.id,
    tenantId: proposal.tenantId,
    externalActorId: "U_slack",
    decision: "approved",
  });

  assert.equal(outcome.status, "denied");
  assert.equal(audited, false, "denied decision must not be audited");
  assert.equal(executed, false, "denied decision must never reach execution");
});

test("approval pipeline audits before it ever hands off", async () => {
  const proposal = withContentHash(sampleProposal());
  const order: string[] = [];

  const ports: BrainCorePorts = {
    identity: {
      async resolve() {
        return { actorId: toActorId("a_1"), roles: ["ap_lead"] };
      },
    },
    policy: {
      async canDecide() {
        return { allowed: true };
      },
    },
    audit: {
      async record() {
        order.push("audit");
      },
    },
    execution: {
      async enqueue() {
        order.push("execute");
      },
    },
    decisions: {
      async claimTerminal() {
        return { status: "claimed" };
      },
      async markTerminalApplied() {
        order.push("mark");
      },
    },
  };

  const registry = new SurfaceRegistry();
  const service = new ApprovalService(ports, registry, async () => proposal);

  const outcome = await service.handle({
    surface: "slack",
    proposalId: proposal.id,
    tenantId: proposal.tenantId,
    externalActorId: "U_slack",
    decision: "approved",
  });

  assert.equal(outcome.status, "applied");
  assert.deepEqual(order, ["audit", "execute", "mark"]);
});

test("approval pipeline makes terminal decisions idempotent", async () => {
  const proposal = withContentHash(sampleProposal());
  let auditCount = 0;
  let executionCount = 0;

  const ports: BrainCorePorts = {
    identity: {
      async resolve() {
        return { actorId: toActorId("a_1"), roles: ["ap_lead"] };
      },
    },
    policy: {
      async canDecide() {
        return { allowed: true };
      },
    },
    audit: {
      async record() {
        auditCount += 1;
      },
    },
    execution: {
      async enqueue() {
        executionCount += 1;
      },
    },
    decisions: memoryDecisions(),
  };

  const service = new ApprovalService(ports, new SurfaceRegistry(), async () => proposal);
  const incoming = {
    surface: "slack" as const,
    proposalId: proposal.id,
    tenantId: proposal.tenantId,
    externalActorId: "U_slack",
    decision: "approved" as const,
  };

  const first = await service.handle(incoming);
  const second = await service.handle(incoming);

  assert.equal(first.status, "applied");
  assert.equal(second.status, "already_decided");
  assert.equal(auditCount, 1);
  assert.equal(executionCount, 1);
});

test("approval pipeline re-drives unapplied approved terminal decisions", async () => {
  const proposal = withContentHash(sampleProposal());
  const order: string[] = [];
  const stored: TerminalDecisionRecord = {
    proposalId: proposal.id,
    tenantId: proposal.tenantId,
    decision: "approved",
    actorId: toActorId("a_original"),
    decidedAt: new Date().toISOString(),
    applied: false,
  };

  const ports: BrainCorePorts = {
    identity: {
      async resolve() {
        return { actorId: toActorId("a_1"), roles: ["ap_lead"] };
      },
    },
    policy: {
      async canDecide() {
        return { allowed: true };
      },
    },
    audit: {
      async record() {
        order.push("audit");
      },
    },
    execution: {
      async enqueue() {
        order.push("execute");
      },
    },
    decisions: {
      async claimTerminal() {
        return { status: "already_decided", record: stored };
      },
      async markTerminalApplied() {
        order.push("mark");
      },
    },
  };

  const service = new ApprovalService(ports, new SurfaceRegistry(), async () => proposal);
  const outcome = await service.handle({
    surface: "slack",
    proposalId: proposal.id,
    tenantId: proposal.tenantId,
    externalActorId: "U_slack",
    decision: "approved",
  });

  assert.equal(outcome.status, "already_decided");
  assert.deepEqual(order, ["audit", "execute", "mark"]);
});

test("approval pipeline does not re-drive applied terminal decisions", async () => {
  const proposal = withContentHash(sampleProposal());
  const order: string[] = [];
  const stored: TerminalDecisionRecord = {
    proposalId: proposal.id,
    tenantId: proposal.tenantId,
    decision: "approved",
    actorId: toActorId("a_original"),
    decidedAt: new Date().toISOString(),
    applied: true,
  };

  const ports: BrainCorePorts = {
    identity: {
      async resolve() {
        return { actorId: toActorId("a_1"), roles: ["ap_lead"] };
      },
    },
    policy: {
      async canDecide() {
        return { allowed: true };
      },
    },
    audit: {
      async record() {
        order.push("audit");
      },
    },
    execution: {
      async enqueue() {
        order.push("execute");
      },
    },
    decisions: {
      async claimTerminal() {
        return { status: "already_decided", record: stored };
      },
      async markTerminalApplied() {
        order.push("mark");
      },
    },
  };

  const service = new ApprovalService(ports, new SurfaceRegistry(), async () => proposal);
  const outcome = await service.handle({
    surface: "slack",
    proposalId: proposal.id,
    tenantId: proposal.tenantId,
    externalActorId: "U_slack",
    decision: "approved",
  });

  assert.equal(outcome.status, "already_decided");
  assert.deepEqual(order, []);
});
