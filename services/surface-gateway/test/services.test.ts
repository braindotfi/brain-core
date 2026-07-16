import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { InMemoryAuditEmitter, type ServiceCallContext } from "@brain/shared";
import type { PolicyDocument } from "@brain/policy";
import type { ApprovalService as ExecutionApprovalService } from "@brain/execution";
import {
  ApprovalService,
  SurfaceRegistry,
  withContentHash,
  type ActorId,
  type BrainCorePorts,
  type Payee,
  type Proposal,
  type TerminalDecisionRecord,
} from "@brain/surfaces";
import {
  buildSurfaceGatewayServices,
  SurfaceApprovalRecorder,
  SurfaceExecutionQueue,
  SurfacePolicyEngine,
} from "../src/services.js";
import { PostgresSurfaceIdentityStore } from "../src/storage.js";

const TENANT_ID = "tnt_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROPOSAL_ID = "prop_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FINANCE_ACTOR = "user_01ARZ3NDEKTSV4RRFFQ69G5FAV" as ActorId;
const CONTROLLER_ACTOR = "user_01ARZ3NDEKTSV4RRFFQ69G5FAW" as ActorId;

describe("surface gateway approval ordering", () => {
  it("resolves only verified active email recipients", async () => {
    const store = new PostgresSurfaceIdentityStore(
      emailRecipientPool({ verified: true, status: "active" }),
      emailUserPool(),
    );
    const unverified = new PostgresSurfaceIdentityStore(
      emailRecipientPool({ verified: false, status: "pending" }),
      emailUserPool(),
    );
    const disabled = new PostgresSurfaceIdentityStore(
      emailRecipientPool({ verified: true, status: "disabled" }),
      emailUserPool(),
    );

    await expect(
      store.lookupActor({
        tenantId: TENANT_ID,
        surface: "email",
        externalId: "Finance@Example.com",
      }),
    ).resolves.toMatchObject({ actorId: FINANCE_ACTOR, roles: ["finance", "approver"] });
    await expect(
      unverified.lookupActor({
        tenantId: TENANT_ID,
        surface: "email",
        externalId: "finance@example.com",
      }),
    ).resolves.toBeNull();
    await expect(
      disabled.lookupActor({
        tenantId: TENANT_ID,
        surface: "email",
        externalId: "finance@example.com",
      }),
    ).resolves.toBeNull();
  });

  it("keeps evaluateDecision read-only", async () => {
    const approvals = new ApprovalSpy([]);
    const engine = new SurfacePolicyEngine(policyPool(policyWithRequire("finance_approval")));

    const verdict = await engine.evaluateDecision({
      proposal: sampleProposal({ approverRoles: ["finance"] }),
      actor: { actorId: FINANCE_ACTOR, roles: ["finance"] },
      decision: "approved",
    });

    expect(verdict).toMatchObject({ allowed: true, approverRole: "finance" });
    expect(approvals.signCalls).toHaveLength(0);
  });

  it("blocks a surface approver who matches the proposal payee email", async () => {
    const approvals = new ApprovalSpy([]);
    const engine = new SurfacePolicyEngine(policyPool(policyWithRequire("finance_approval")));

    const verdict = await engine.evaluateDecision({
      proposal: sampleProposal({
        approverRoles: ["finance"],
        payee: { kind: "employee", email: "finance+payroll@example.com" },
      }),
      actor: { actorId: FINANCE_ACTOR, roles: ["finance"], email: " Finance@Example.com " },
      decision: "approved",
    });

    expect(verdict).toMatchObject({
      allowed: false,
      reason: "self_approval_blocked",
    });
    expect(approvals.signCalls).toHaveLength(0);
  });

  it("allows a distinct authorized surface approver for a payee proposal", async () => {
    const engine = new SurfacePolicyEngine(policyPool(policyWithRequire("finance_approval")));

    const verdict = await engine.evaluateDecision({
      proposal: sampleProposal({
        approverRoles: ["finance"],
        payee: { kind: "employee", email: "payee@example.com" },
      }),
      actor: { actorId: FINANCE_ACTOR, roles: ["finance"], email: "finance@example.com" },
      decision: "approved",
    });

    expect(verdict).toMatchObject({ allowed: true, approverRole: "finance" });
  });

  it("fails closed for employee payees with unresolved identity", async () => {
    const engine = new SurfacePolicyEngine(policyPool(policyWithRequire("finance_approval")));

    const verdict = await engine.evaluateDecision({
      proposal: sampleProposal({
        approverRoles: ["finance"],
        payee: { kind: "employee" },
      }),
      actor: { actorId: FINANCE_ACTOR, roles: ["finance"], email: "finance@example.com" },
      decision: "approved",
    });

    expect(verdict).toMatchObject({
      allowed: false,
      reason: "self_approval_blocked",
    });
  });

  it("allows vendor payees with unresolved identity as the v1 residual", async () => {
    const engine = new SurfacePolicyEngine(policyPool(policyWithRequire("finance_approval")));

    const verdict = await engine.evaluateDecision({
      proposal: sampleProposal({
        approverRoles: ["finance"],
        payee: { kind: "vendor", counterpartyId: "cp_vendor" },
      }),
      actor: { actorId: FINANCE_ACTOR, roles: ["finance"], email: "finance@example.com" },
      decision: "approved",
    });

    expect(verdict).toMatchObject({ allowed: true, approverRole: "finance" });
  });

  it("uses the stored proposal payee instead of inbound surface context", async () => {
    const proposal = sampleProposal({
      approverRoles: ["finance"],
      payee: { kind: "employee", email: "finance@example.com" },
    });
    const approvals = new ApprovalSpy([]);
    const engine = new SurfacePolicyEngine(policyPool(policyWithRequire("finance_approval")));
    const service = new ApprovalService(
      {
        identity: {
          async resolve() {
            return { actorId: FINANCE_ACTOR, roles: ["finance"], email: "finance@example.com" };
          },
        },
        policy: {
          async canDecide(input) {
            return engine.evaluateDecision(input);
          },
        },
        audit: {
          async record() {
            throw new Error("self approval must not audit");
          },
        },
        approvals: new SurfaceApprovalRecorder(approvals.asExecutionApprovals()),
        execution: {
          async enqueue() {
            throw new Error("self approval must not execute");
          },
        },
        decisions: memoryDecisions(),
      },
      new SurfaceRegistry(),
      async () => proposal,
    );

    const outcome = await service.handle({
      surface: "slack",
      tenantId: TENANT_ID,
      proposalId: PROPOSAL_ID,
      externalActorId: "U_finance",
      decision: "approved",
      context: { payeeEmail: "other@example.com" },
    });

    expect(outcome).toEqual({ status: "denied", reason: "self_approval_blocked" });
    expect(approvals.signCalls).toHaveLength(0);
  });

  it("records dual approval signatures after each audit and signs once per actor", async () => {
    const proposal = sampleProposal({
      approverRoles: ["finance", "controller"],
      requiresDualApproval: true,
    });
    const order: string[] = [];
    const approvals = new ApprovalSpy([], order);
    const engine = new SurfacePolicyEngine(policyPool(policyWithRequire("finance_and_controller")));
    const service = new ApprovalService(
      {
        identity: {
          async resolve(input) {
            if (input.externalId === "U_finance") {
              return { actorId: FINANCE_ACTOR, roles: ["finance"] };
            }
            return { actorId: CONTROLLER_ACTOR, roles: ["controller"] };
          },
        },
        policy: {
          async canDecide(input) {
            return engine.evaluateDecision(input);
          },
        },
        audit: {
          async record(event) {
            order.push(`audit:${event.actorId}`);
          },
        },
        approvals: new SurfaceApprovalRecorder(approvals.asExecutionApprovals()),
        execution: {
          async enqueue(input) {
            order.push(`execute:${input.actorId}`);
            await new SurfaceExecutionQueue().enqueueIdempotent({
              proposalId: input.proposal.id,
              proposal: input.proposal,
              actorId: input.actorId,
            });
          },
        },
        decisions: memoryDecisions(),
      },
      new SurfaceRegistry(),
      async () => proposal,
    );

    const first = await service.handle({
      surface: "slack",
      tenantId: TENANT_ID,
      proposalId: PROPOSAL_ID,
      externalActorId: "U_finance",
      decision: "approved",
    });
    expect(approvals.signCalls).toEqual([{ actor: FINANCE_ACTOR, role: "finance" }]);
    const second = await service.handle({
      surface: "slack",
      tenantId: TENANT_ID,
      proposalId: PROPOSAL_ID,
      externalActorId: "U_controller",
      decision: "approved",
    });

    expect(first.status).toBe("awaiting_second_approval");
    expect(second.status).toBe("applied");
    expect(order).toEqual([
      `audit:${FINANCE_ACTOR}`,
      `sign:finance:${FINANCE_ACTOR}`,
      `audit:${CONTROLLER_ACTOR}`,
      `sign:controller:${CONTROLLER_ACTOR}`,
      `execute:${CONTROLLER_ACTOR}`,
    ]);
    expect(approvals.signCalls).toEqual([
      { actor: FINANCE_ACTOR, role: "finance" },
      { actor: CONTROLLER_ACTOR, role: "controller" },
    ]);
  });

  it("signs exactly once for a terminal single approval", async () => {
    const proposal = sampleProposal({ approverRoles: ["finance"] });
    const order: string[] = [];
    const approvals = new ApprovalSpy([], order);
    const engine = new SurfacePolicyEngine(policyPool(policyWithRequire("finance_approval")));
    const service = new ApprovalService(
      {
        identity: {
          async resolve() {
            return { actorId: FINANCE_ACTOR, roles: ["finance"] };
          },
        },
        policy: {
          async canDecide(input) {
            return engine.evaluateDecision(input);
          },
        },
        audit: {
          async record(event) {
            order.push(`audit:${event.actorId}`);
          },
        },
        approvals: new SurfaceApprovalRecorder(approvals.asExecutionApprovals()),
        execution: {
          async enqueue(input) {
            order.push(`execute:${input.actorId}`);
          },
        },
        decisions: memoryDecisions(),
      },
      new SurfaceRegistry(),
      async () => proposal,
    );

    const outcome = await service.handle({
      surface: "slack",
      tenantId: TENANT_ID,
      proposalId: PROPOSAL_ID,
      externalActorId: "U_finance",
      decision: "approved",
    });

    expect(outcome.status).toBe("applied");
    expect(order).toEqual([
      `audit:${FINANCE_ACTOR}`,
      `sign:finance:${FINANCE_ACTOR}`,
      `execute:${FINANCE_ACTOR}`,
    ]);
    expect(approvals.signCalls).toEqual([{ actor: FINANCE_ACTOR, role: "finance" }]);
  });

  it("denies roleless actors when signer is required", async () => {
    const approvals = new ApprovalSpy([]);
    const engine = new SurfacePolicyEngine(policyPool(policyWithRequire("single_signer")));

    const verdict = await engine.evaluateDecision({
      proposal: sampleProposal({ approverRoles: ["signer"] }),
      actor: { actorId: FINANCE_ACTOR, roles: [] },
      decision: "approved",
    });

    expect(verdict).toMatchObject({
      allowed: false,
      reason: "Actor lacks an approver role for this proposal",
    });
    expect(approvals.signCalls).toHaveLength(0);
  });

  it("rejects disabled users when recording approval signatures", async () => {
    const { services } = buildSurfaceGatewayServices({
      pool: disabledUserPool(),
      auditPool: disabledUserPool(),
      audit: new InMemoryAuditEmitter(),
    });

    await expect(
      services.approvals.recordApproval({
        proposal: sampleProposal({ approverRoles: ["finance"] }),
        actorId: FINANCE_ACTOR,
        surface: "slack",
        approverRole: "finance",
      }),
    ).rejects.toMatchObject({ code: "approval_signer_revoked" });
  });
});

class ApprovalSpy {
  public readonly signCalls: Array<{ actor: ActorId; role: string | undefined }> = [];

  public constructor(
    private readonly signedRoles: string[],
    private readonly order?: string[],
  ) {}

  public asExecutionApprovals(): ExecutionApprovalService {
    return this as unknown as ExecutionApprovalService;
  }

  public async signedValidRoles(): Promise<string[]> {
    return [...this.signedRoles];
  }

  public async signAndCheckRequiredApprovals(
    ctx: ServiceCallContext,
    _subject: { type: "proposal"; id: string },
    requiredRoles: readonly string[],
    role?: string,
  ): Promise<{ quorumMet: boolean }> {
    this.signCalls.push({ actor: ctx.actor as ActorId, role });
    if (role !== undefined) this.signedRoles.push(role);
    this.order?.push(`sign:${role ?? ""}:${ctx.actor}`);
    const signed = new Set(this.signedRoles);
    return { quorumMet: requiredRoles.every((requiredRole) => signed.has(requiredRole)) };
  }
}

function sampleProposal(input: {
  approverRoles: string[];
  requiresDualApproval?: boolean;
  payee?: Payee | undefined;
}): Proposal {
  return withContentHash({
    id: PROPOSAL_ID,
    tenantId: TENANT_ID,
    agent: "invoice",
    severity: "warning",
    title: "Duplicate invoice",
    claim: "Vendor invoice appears to be a duplicate.",
    evidence: [{ label: "Invoice", value: "INV-1" }],
    action: { summary: "Hold payment", handoff: "erp", payload: {} },
    ...(input.payee !== undefined ? { payee: input.payee } : {}),
    policy: {
      gates: ["ROLE"],
      approverRoles: input.approverRoles,
      requiresDualApproval: input.requiresDualApproval ?? false,
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  });
}

function policyWithRequire(requireClause: string): PolicyDocument {
  return {
    version: 1,
    rules: [
      {
        id: "surface-approval",
        applies_to: ["agent_action"],
        when: {},
        require: requireClause,
        execute: "confirm",
      },
    ],
  };
}

function memoryDecisions(): BrainCorePorts["decisions"] {
  const records = new Map<string, TerminalDecisionRecord>();
  return {
    async claimTerminal(record) {
      const key = `${record.tenantId}:${record.proposalId}`;
      const existing = records.get(key);
      if (existing !== undefined) return { status: "already_decided", record: existing };
      records.set(key, { ...record, applied: false });
      return { status: "claimed" };
    },
    async markTerminalApplied(record) {
      const key = `${record.tenantId}:${record.proposalId}`;
      records.set(key, { ...record, applied: true });
    },
  };
}

function policyPool(policy: PolicyDocument): Pool {
  return fakePool((text) => {
    if (text.includes("FROM policies")) {
      return [
        {
          id: "pol_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          tenant_id: TENANT_ID,
          version: 1,
          content: policy,
          content_hash: Buffer.from("hash"),
          signers: null,
          state: "active",
          quorum_required: 1,
          activated_at: new Date(),
          deactivated_at: null,
          created_by: FINANCE_ACTOR,
          created_at: new Date(),
        },
      ];
    }
    return [];
  });
}

function disabledUserPool(): Pool {
  return fakePool((text) => {
    if (text.includes("FROM agents")) return [];
    if (text.includes("FROM users")) {
      return [
        {
          id: FINANCE_ACTOR,
          tenant_id: TENANT_ID,
          email: "disabled@example.com",
          role: "approver",
          status: "disabled",
          created_at: new Date(),
        },
      ];
    }
    return [];
  });
}

function emailRecipientPool(input: {
  verified: boolean;
  status: "pending" | "active" | "disabled";
}): Pool {
  return fakePool((text) => {
    if (!text.includes("FROM surface_email_recipients")) return [];
    if (!input.verified || input.status !== "active") return [];
    return [
      {
        actor_id: FINANCE_ACTOR,
        roles: ["finance"],
      },
    ];
  });
}

function emailUserPool(): Pool {
  return fakePool((text) => {
    if (!text.includes("FROM users")) return [];
    return [{ role: "approver" }];
  });
}

function fakePool(resolveRows: (text: string) => unknown[]): Pool {
  return {
    async connect() {
      return {
        async query<TRow = Record<string, unknown>>(text: string) {
          return { rows: resolveRows(text) as TRow[], rowCount: null };
        },
        release() {},
      };
    },
  } as unknown as Pool;
}
