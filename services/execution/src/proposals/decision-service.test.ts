import { describe, expect, it, vi } from "vitest";
import {
  brainError,
  newAgentId,
  newAuditEventId,
  newPaymentIntentId,
  newProposalId,
  newTenantId,
  newUserId,
  type AuditEmitter,
  type CardIssuer,
  type DisputeService,
  type LedgerDecisionService,
  type NotificationService,
  type PaymentReversalService,
  type PaymentIntent,
  type ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import type { ActorResolver } from "../members/ActorResolver.js";
import type { ActorContext, UserAgentAuthority } from "../members/types.js";
import type { PaymentIntentService } from "../payment-intents/PaymentIntentService.js";
import type { ProposalRow } from "../repository.js";
import { ProposalDecisionService, type CollectionsEmailSender } from "./decision-service.js";

const TENANT = newTenantId();
const MEMBER = newUserId();
const AGENT = newAgentId();
const PROPOSAL = newProposalId();
const PAYMENT_INTENT = newPaymentIntentId();

function ctx(input: Partial<ServiceCallContext> = {}): ServiceCallContext {
  return {
    tenantId: TENANT,
    actor: MEMBER,
    principalType: "user",
    scopes: ["execution:read", "payment_intent:approve"],
    ...input,
  };
}

function proposal(overrides: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id: PROPOSAL,
    tenant_id: TENANT,
    proposing_agent: AGENT,
    action: { type: "vendor_risk" },
    policy_version: 1,
    policy_decision: "confirm",
    policy_trace: [],
    required_approvers: [],
    status: "pending",
    approvers_signed: [],
    proposal_dedup_key: null,
    decision: null,
    decision_audit_id: null,
    decided_at: null,
    sent_message_id: null,
    sent_thread_id: null,
    delivery_status: null,
    sent_at: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function authorityRow(overrides: Partial<UserAgentAuthority> = {}): UserAgentAuthority {
  return {
    id: "auth_1",
    tenantId: TENANT,
    userId: MEMBER,
    agent: "vendor_risk",
    canApprove: true,
    canEdit: true,
    canReject: true,
    maxAmountCents: null,
    canDelegate: false,
    ...overrides,
  };
}

describe("ProposalDecisionService", () => {
  it("emits proposal.decided before transitioning an agent proposal", async () => {
    const order: string[] = [];
    const row = proposal({ action: { type: "vendor_risk", mode: "notify_only" } });
    const service = serviceFor(row, { order });

    const result = await service.decide(ctx(), PROPOSAL, "acknowledge");

    expect(result).toMatchObject({ id: PROPOSAL, status: "acknowledged", audit_id: "evt_1" });
    expect(order).toEqual(["audit", "transition"]);
    expect(row.status).toBe("acknowledged");
  });

  it("embeds a narrative/severity/rule_id snapshot in proposal.decided for a compliance finding", async () => {
    const row = proposal({
      action: {
        type: "compliance",
        mode: "notify_only",
        agent_kind: "compliance",
        finding_type: "policy_violation",
        severity: "high",
        risk_band: "high",
        rule_id: "cmp_policy_violation",
        narrative: "Compliance review found policy_violation with high severity.",
        summary: "Compliance finding policy_violation severity high.",
        recommended_remediation: "Review the rejected policy decision and keep the action blocked.",
        affected_entities: [{ kind: "policy_decision", ref: "pd_123" }],
      },
    });
    const service = serviceFor(row);

    await service.decide(ctx(), PROPOSAL, "acknowledge");

    const emitted = (service as unknown as { deps: { audit: AuditEmitter } }).deps.audit
      .emit as ReturnType<typeof vi.fn>;
    const [event] = emitted.mock.calls[0] as [Parameters<AuditEmitter["emit"]>[0]];
    expect(event.outputs).toMatchObject({
      proposal_summary: {
        proposing_agent: AGENT,
        finding_type: "policy_violation",
        severity: "high",
        rule_id: "cmp_policy_violation",
        narrative: "Compliance review found policy_violation with high severity.",
        recommended_remediation: "Review the rejected policy decision and keep the action blocked.",
      },
    });
    expect(event.beforeState).toMatchObject({
      finding_type: "policy_violation",
      severity: "high",
      rule_id: "cmp_policy_violation",
    });
    expect(event.inputs).toEqual({ proposal_id: PROPOSAL, decision: "acknowledge" });
  });

  it("sends a collections draft email on approval and audits message details", async () => {
    const row = proposal({
      proposing_agent: "collections",
      action: {
        type: "collections",
        agent_role: "collections",
        draft_email: {
          to: "customer@example.com",
          from: "collections@example.com",
          subject: "Invoice reminder",
          body: ["Hello", "Please send a payment update."],
        },
      },
    });
    const sender: CollectionsEmailSender = {
      send: vi.fn(async (_ctx, input) => {
        row.sent_message_id = "mock_msg_123";
        row.sent_thread_id = "mock_thread_123";
        row.delivery_status = "sent";
        row.sent_at = new Date("2026-01-01T00:01:00.000Z");
        expect(input).toMatchObject({
          proposalId: PROPOSAL,
          to: ["customer@example.com"],
          subject: "Invoice reminder",
          body: "Hello\n\nPlease send a payment update.",
        });
        return {
          messageId: "mock_msg_123",
          threadId: "mock_thread_123",
          sentFrom: "you@example.com",
        };
      }),
    };
    const service = serviceFor(row, { collectionsEmailSender: sender });

    const result = await service.decide(ctx(), PROPOSAL, "approve");

    expect(result).toMatchObject({ status: "executed", audit_id: "evt_1" });
    expect(row).toMatchObject({
      sent_message_id: "mock_msg_123",
      sent_thread_id: "mock_thread_123",
      delivery_status: "sent",
    });
    const emitted = (service as unknown as { deps: { audit: AuditEmitter } }).deps.audit
      .emit as ReturnType<typeof vi.fn>;
    const [event] = emitted.mock.calls[0] as [Parameters<AuditEmitter["emit"]>[0]];
    expect(event.action).toBe("decision.executed");
    expect(event.outputs).toMatchObject({
      outcome: "email_sent",
      details: {
        message_id: "mock_msg_123",
        thread_id: "mock_thread_123",
        sent_from: "you@example.com",
      },
    });
  });

  it("denies an unresolved user before auditing or transitioning", async () => {
    const order: string[] = [];
    const row = proposal();
    const service = serviceFor(row, { order, actor: null });

    await expect(service.decide(ctx(), PROPOSAL, "approve")).rejects.toMatchObject({
      code: "payment_intent_approval_invalid",
    });
    expect(order).toEqual([]);
    expect(row.status).toBe("pending");
  });

  it("denies agent principals at the identity layer", async () => {
    const row = proposal();
    const service = serviceFor(row);

    await expect(
      service.decide(ctx({ actor: AGENT, principalType: "agent" }), PROPOSAL, "approve"),
    ).rejects.toMatchObject({ code: "payment_intent_approval_invalid" });
    expect(row.status).toBe("pending");
  });

  it("blocks approval when per-user agent cap is exceeded", async () => {
    const row = proposal({
      proposing_agent: "treasury",
      action: { type: "treasury", agent_role: "treasury", amount_cents: 1_500_000 },
    });
    const service = serviceFor(row, {
      authorityRows: [
        {
          id: "auth_1",
          tenantId: TENANT,
          userId: MEMBER,
          agent: "treasury",
          canApprove: true,
          canEdit: true,
          canReject: true,
          maxAmountCents: 1_000_000n,
          canDelegate: false,
        },
      ],
    });

    const result = await service.decide(ctx(), PROPOSAL, "approve");

    expect(result).toMatchObject({ status: "blocked", decision: "approve" });
    expect(row.status).toBe("blocked");
    const emitted = (service as unknown as { deps: { audit: AuditEmitter } }).deps.audit
      .emit as ReturnType<typeof vi.fn>;
    const [event] = emitted.mock.calls[0] as [Parameters<AuditEmitter["emit"]>[0]];
    expect(event.action).toBe("decision.denied");
    expect(event.outputs).toMatchObject({
      reason: "user_agent_limit_exceeded",
      detail: {
        amount_cents: "1500000",
        limit_cents: "1000000",
      },
    });
  });

  it.each(["owner", "admin", "approver"] as const)(
    "allows %s to approve when no per-agent row exists",
    async (role) => {
      const row = proposal();
      const service = serviceFor(row, {
        actor: {
          memberId: MEMBER,
          email: "member@example.com",
          role,
          active: true,
          verification: "session",
        },
      });

      const result = await service.decide(ctx(), PROPOSAL, "approve");

      expect(result).toMatchObject({ status: "approved", decision: "approve" });
    },
  );

  it.each(["analyst", "viewer"] as const)("blocks %s approval by global role", async (role) => {
    const row = proposal();
    const service = serviceFor(row, {
      actor: {
        memberId: MEMBER,
        email: "member@example.com",
        role,
        active: true,
        verification: "session",
      },
    });

    const result = await service.decide(ctx(), PROPOSAL, "approve");

    expect(result).toMatchObject({ status: "blocked", decision: "approve" });
    expect(row.status).toBe("blocked");
  });

  it.each([
    {
      decision: "approve" as const,
      field: "canApprove" as const,
      reason: "user_agent_approval_denied",
    },
    {
      decision: "reject" as const,
      field: "canReject" as const,
      reason: "user_agent_reject_denied",
    },
  ])("blocks $decision when per-agent $field is false", async ({ decision, field, reason }) => {
    const row = proposal({
      proposing_agent: "vendor_risk",
      action: { type: "vendor_risk", agent_role: "vendor_risk" },
    });
    const authority = authorityRow({ [field]: false });
    const service = serviceFor(row, { authorityRows: [authority] });

    const result = await service.decide(ctx(), PROPOSAL, decision);

    expect(result).toMatchObject({ status: "blocked", decision });
    const emitted = (service as unknown as { deps: { audit: AuditEmitter } }).deps.audit
      .emit as ReturnType<typeof vi.fn>;
    const [event] = emitted.mock.calls[0] as [Parameters<AuditEmitter["emit"]>[0]];
    expect(event.outputs).toMatchObject({ reason });
  });

  it("blocks domain edits when per-agent edit authority is false", async () => {
    const row = proposal({
      proposing_agent: "fraud_anomaly",
      action: {
        type: "flag_transaction",
        agent_role: "fraud_anomaly",
        transaction_id: "txn_1",
        card_id: "card_1",
      },
    });
    const service = serviceFor(row, {
      authorityRows: [authorityRow({ agent: "fraud_anomaly", canEdit: false })],
    });

    const result = await service.decide(ctx(), PROPOSAL, "freeze_card");

    expect(result).toMatchObject({ status: "blocked", decision: "freeze_card" });
    expect(row.status).toBe("blocked");
  });

  it("does not re-audit a repeated terminal acknowledgement", async () => {
    const order: string[] = [];
    const row = proposal({ action: { type: "vendor_risk", mode: "notify_only" } });
    const service = serviceFor(row, { order });

    const first = await service.decide(ctx(), PROPOSAL, "acknowledge");
    const second = await service.decide(ctx(), PROPOSAL, "acknowledge");

    expect(first.audit_id).toBe("evt_1");
    expect(second.audit_id).toBe("evt_1");
    expect(order).toEqual(["audit", "transition"]);
    expect(row.status).toBe("acknowledged");
  });

  it("rejects undo after a proposal executed", async () => {
    const row = proposal({ status: "executed" });
    const service = serviceFor(row);

    await expect(service.decide(ctx(), PROPOSAL, "undo")).rejects.toMatchObject({
      code: "execution_proposal_invalid_state",
    });
    expect(row.status).toBe("executed");
  });

  it("routes money-path approval through PaymentIntentService and returns awaiting_second_approval", async () => {
    const approve = vi.fn(async () => paymentIntent("awaiting_second_approval"));
    const row = proposal({ id: PAYMENT_INTENT, status: "pending" });
    const service = serviceFor(row, {
      paymentIntentId: PAYMENT_INTENT,
      paymentIntents: { approve } as unknown as PaymentIntentService,
    });

    const result = await service.decide(ctx(), PAYMENT_INTENT, "approve");

    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ actor: MEMBER }),
      PAYMENT_INTENT,
    );
    expect(result).toMatchObject({
      id: PAYMENT_INTENT,
      status: "awaiting_second_approval",
      payment_intent_id: PAYMENT_INTENT,
    });
  });

  it("executes freeze_card through card and dispute adapters", async () => {
    const freeze = vi.fn(async () => ({ reference_id: "freeze_1", status: "frozen" }));
    const file = vi.fn(async () => ({ reference_id: "case_1", status: "filed" }));
    const row = proposal({
      proposing_agent: "fraud_anomaly",
      action: {
        type: "flag_transaction",
        agent_role: "fraud_anomaly",
        transaction_id: "txn_1",
        card_id: "card_1",
        amount: "10.00",
      },
    });
    const service = serviceFor(row, {
      cardIssuer: { freeze } as unknown as CardIssuer,
      disputeService: { file } as unknown as DisputeService,
    });

    const result = await service.decide(ctx(), PROPOSAL, "freeze_card");

    expect(freeze).toHaveBeenCalledWith("card_1");
    expect(file).toHaveBeenCalledWith("txn_1", "suspected_fraud");
    expect(result).toMatchObject({ status: "executed", decision: "freeze_card" });
    expect(row.status).toBe("executed");
    expect(row.decision).toBe("freeze_card");
  });

  it("executes block_merchant by disputing the charge without freezing the card", async () => {
    const freeze = vi.fn(async () => ({ reference_id: "freeze_1", status: "frozen" }));
    const file = vi.fn(async () => ({ reference_id: "case_1", status: "filed" }));
    const row = proposal({
      proposing_agent: "fraud_anomaly",
      action: {
        type: "flag_transaction",
        agent_role: "fraud_anomaly",
        transaction_id: "txn_1",
        card_id: "card_1",
        counterparty_name: "Risky Merchant",
      },
    });
    const service = serviceFor(row, {
      cardIssuer: { freeze } as unknown as CardIssuer,
      disputeService: { file } as unknown as DisputeService,
    });

    const result = await service.decide(ctx(), PROPOSAL, "block_merchant");

    expect(freeze).not.toHaveBeenCalled();
    expect(file).toHaveBeenCalledWith("txn_1", "suspected_fraud");
    expect(result).toMatchObject({ status: "executed", decision: "block_merchant" });
    expect(row.status).toBe("executed");
    expect(row.decision).toBe("block_merchant");
  });

  it("does not transition a domain decision when an adapter fails", async () => {
    const row = proposal({
      proposing_agent: "fraud_anomaly",
      action: {
        type: "flag_transaction",
        agent_role: "fraud_anomaly",
        transaction_id: "txn_1",
        card_id: "card_1",
      },
    });
    const service = serviceFor(row, {
      cardIssuer: {
        freeze: vi.fn(async () => {
          throw new Error("issuer down");
        }),
      } as unknown as CardIssuer,
    });

    await expect(service.decide(ctx(), PROPOSAL, "freeze_card")).rejects.toThrow("issuer down");
    expect(row.status).toBe("pending");
    expect(row.decision).toBeNull();
  });

  it("keeps domain decisions idempotent by proposal and decision", async () => {
    const freeze = vi.fn(async () => ({ reference_id: "freeze_1", status: "frozen" }));
    const file = vi.fn(async () => ({ reference_id: "case_1", status: "filed" }));
    const row = proposal({
      proposing_agent: "fraud_anomaly",
      action: {
        type: "flag_transaction",
        agent_role: "fraud_anomaly",
        transaction_id: "txn_1",
        card_id: "card_1",
      },
    });
    const service = serviceFor(row, {
      cardIssuer: { freeze } as unknown as CardIssuer,
      disputeService: { file } as unknown as DisputeService,
    });

    const first = await service.decide(ctx(), PROPOSAL, "freeze_card");
    const second = await service.decide(ctx(), PROPOSAL, "freeze_card");

    expect(first.audit_id).toBe("evt_1");
    expect(second.audit_id).toBe("evt_1");
    expect(freeze).toHaveBeenCalledTimes(1);
    expect(file).toHaveBeenCalledTimes(1);
  });

  it("emits decision.executed with actor, outcome, and outbound references", async () => {
    const freeze = vi.fn(async () => ({ reference_id: "freeze_1", status: "frozen" }));
    const file = vi.fn(async () => ({ reference_id: "case_1", status: "filed" }));
    const row = proposal({
      proposing_agent: "fraud_anomaly",
      action: {
        type: "flag_transaction",
        agent_role: "fraud_anomaly",
        transaction_id: "txn_1",
        card_id: "card_1",
      },
    });
    const service = serviceFor(row, {
      cardIssuer: { freeze } as unknown as CardIssuer,
      disputeService: { file } as unknown as DisputeService,
    });

    await service.decide(ctx(), PROPOSAL, "freeze_card");

    const emitted = (service as unknown as { deps: { audit: AuditEmitter } }).deps.audit
      .emit as ReturnType<typeof vi.fn>;
    const [event] = emitted.mock.calls[0] as [Parameters<AuditEmitter["emit"]>[0]];
    expect(event.action).toBe("decision.executed");
    expect(event.actor).toBe(MEMBER);
    expect(event.outputs).toMatchObject({
      actor: { member_id: MEMBER, verification: "session" },
      outcome: "frozen",
      outbound_reference_ids: ["freeze_1", "case_1"],
    });
    expect(event.inputs).toEqual({ proposal_id: PROPOSAL, decision: "freeze_card" });
  });

  it("does not transition dispute decisions when adapters fail", async () => {
    const fight = proposal({
      proposing_agent: "dispute",
      action: {
        type: "dispute",
        agent_role: "dispute",
        dispute_id: "disp_1",
        transaction_id: "txn_1",
        amount: "25.00",
      },
    });
    await expect(
      serviceFor(fight, {
        disputeService: {
          submit_evidence: vi.fn(async () => {
            throw new Error("dispute down");
          }),
        } as unknown as DisputeService,
      }).decide(ctx(), PROPOSAL, "fight"),
    ).rejects.toThrow("dispute down");
    expect(fight.status).toBe("pending");

    const refund = proposal({
      proposing_agent: "dispute",
      action: {
        type: "dispute",
        agent_role: "dispute",
        dispute_id: "disp_1",
        transaction_id: "txn_1",
        amount: "25.00",
      },
    });
    await expect(
      serviceFor(refund, {
        paymentReversalService: {
          refund: vi.fn(async () => {
            throw new Error("refund down");
          }),
        } as unknown as PaymentReversalService,
      }).decide(ctx(), PROPOSAL, "refund"),
    ).rejects.toThrow("refund down");
    expect(refund.status).toBe("pending");
  });

  it("does not transition reconciliation decisions when adapters fail", async () => {
    const confirm = proposal({
      proposing_agent: "reconciliation",
      action: {
        type: "reconciliation",
        agent_role: "reconciliation",
        candidate_ids: ["cand_1"],
      },
    });
    await expect(
      serviceFor(confirm, {
        ledgerDecisionService: {
          commit_match: vi.fn(async () => {
            throw new Error("ledger down");
          }),
        } as unknown as LedgerDecisionService,
      }).decide(ctx(), PROPOSAL, "confirm_all_matches"),
    ).rejects.toThrow("ledger down");
    expect(confirm.status).toBe("pending");

    const escalate = proposal({
      proposing_agent: "reconciliation",
      action: {
        type: "reconciliation",
        agent_role: "reconciliation",
        accountant_contact: "acct@example.com",
      },
    });
    await expect(
      serviceFor(escalate, {
        notificationService: {
          email: vi.fn(async () => {
            throw new Error("notification down");
          }),
        } as unknown as NotificationService,
      }).decide(ctx(), PROPOSAL, "escalate_to_accountant"),
    ).rejects.toThrow("notification down");
    expect(escalate.status).toBe("pending");
  });

  it("does not transition invoice decisions when notification adapters fail", async () => {
    const duplicate = proposal({
      proposing_agent: "invoice_integrity",
      action: {
        type: "invoice_integrity",
        agent_role: "invoice_integrity",
        flagged_invoice: { id: "inv_1" },
        vendor_contact: "vendor@example.com",
      },
    });
    await expect(
      serviceFor(duplicate, {
        notificationService: {
          email: vi.fn(async () => {
            throw new Error("notification down");
          }),
        } as unknown as NotificationService,
      }).decide(ctx(), PROPOSAL, "reject_duplicate"),
    ).rejects.toThrow("notification down");
    expect(duplicate.status).toBe("pending");

    const hold = proposal({
      proposing_agent: "invoice_integrity",
      action: {
        type: "invoice_integrity",
        agent_role: "invoice_integrity",
        flagged_invoice: { id: "inv_1" },
      },
    });
    await expect(
      serviceFor(hold, {
        notificationService: {
          task: vi.fn(async () => {
            throw new Error("task down");
          }),
        } as unknown as NotificationService,
      }).decide(ctx(), PROPOSAL, "hold_and_verify"),
    ).rejects.toThrow("task down");
    expect(hold.status).toBe("pending");
  });

  it("keeps non-fraud domain handlers idempotent by proposal and decision", async () => {
    const submit = vi.fn(async () => ({ reference_id: "evidence_1", status: "submitted" }));
    const fight = proposal({
      proposing_agent: "dispute",
      action: {
        type: "dispute",
        agent_role: "dispute",
        dispute_id: "disp_1",
      },
    });
    const fightService = serviceFor(fight, {
      disputeService: { submit_evidence: submit } as unknown as DisputeService,
    });
    await fightService.decide(ctx(), PROPOSAL, "fight");
    await fightService.decide(ctx(), PROPOSAL, "fight");
    expect(submit).toHaveBeenCalledTimes(1);

    const commit = vi.fn(async () => ({ reference_id: "match_1", status: "committed" }));
    const confirm = proposal({
      proposing_agent: "reconciliation",
      action: {
        type: "reconciliation",
        agent_role: "reconciliation",
        candidate_ids: ["cand_1"],
      },
    });
    const confirmService = serviceFor(confirm, {
      ledgerDecisionService: { commit_match: commit } as unknown as LedgerDecisionService,
    });
    await confirmService.decide(ctx(), PROPOSAL, "confirm_all_matches");
    await confirmService.decide(ctx(), PROPOSAL, "confirm_all_matches");
    expect(commit).toHaveBeenCalledTimes(1);

    const email = vi.fn(async () => ({ reference_id: "email_1", status: "sent" }));
    const duplicate = proposal({
      proposing_agent: "invoice_integrity",
      action: {
        type: "invoice_integrity",
        agent_role: "invoice_integrity",
        flagged_invoice: { id: "inv_1" },
        vendor_contact: "vendor@example.com",
      },
    });
    const duplicateService = serviceFor(duplicate, {
      notificationService: { email } as unknown as NotificationService,
    });
    await duplicateService.decide(ctx(), PROPOSAL, "reject_duplicate");
    await duplicateService.decide(ctx(), PROPOSAL, "reject_duplicate");
    expect(email).toHaveBeenCalledTimes(1);
  });

  it("executes dispute fight and refund decisions through adapters", async () => {
    const submit = vi.fn(async () => ({ reference_id: "evidence_1", status: "submitted" }));
    const refund = vi.fn(async () => ({ reference_id: "refund_1", status: "refunded" }));
    const fight = proposal({
      proposing_agent: "dispute",
      action: {
        type: "dispute",
        agent_role: "dispute",
        dispute_id: "disp_1",
        transaction_id: "txn_1",
        amount: "25.00",
        evidence_bundle: [{ item: "receipt", present: true }],
      },
    });
    await serviceFor(fight, {
      disputeService: { submit_evidence: submit } as unknown as DisputeService,
    }).decide(ctx(), PROPOSAL, "fight");

    const refundRow = proposal({
      proposing_agent: "dispute",
      action: {
        type: "dispute",
        agent_role: "dispute",
        dispute_id: "disp_1",
        transaction_id: "txn_1",
        amount: "25.00",
      },
    });
    await serviceFor(refundRow, {
      paymentReversalService: { refund } as unknown as PaymentReversalService,
    }).decide(ctx(), PROPOSAL, "refund");

    expect(submit).toHaveBeenCalledWith("disp_1", [{ item: "receipt", present: true }]);
    expect(refund).toHaveBeenCalledWith("txn_1", "25.00", "dispute_refund");
  });

  it("executes reconciliation close decisions through adapters", async () => {
    const commit = vi.fn(async (id: string) => ({ reference_id: `match_${id}`, status: "done" }));
    const email = vi.fn(async () => ({ reference_id: "email_1", status: "sent" }));
    const close = proposal({
      proposing_agent: "reconciliation",
      action: {
        type: "reconciliation",
        agent_role: "reconciliation",
        match_type: "close_aggregate",
        candidate_ids: ["cand_1", "cand_2"],
        accountant_contact: "acct@example.com",
      },
    });

    await serviceFor(close, {
      ledgerDecisionService: { commit_match: commit } as unknown as LedgerDecisionService,
    }).decide(ctx(), PROPOSAL, "confirm_all_matches");
    close.status = "pending";
    close.decision = null;
    await serviceFor(close, {
      notificationService: { email } as unknown as NotificationService,
    }).decide(ctx(), PROPOSAL, "escalate_to_accountant");

    expect(commit).toHaveBeenCalledTimes(2);
    expect(email).toHaveBeenCalledWith(
      "acct@example.com",
      "Reconciliation close needs review",
      "Reconciliation close needs review.",
      [],
    );
  });

  it("executes invoice integrity decisions and vendor notifications", async () => {
    const email = vi.fn(async () => ({ reference_id: "email_1", status: "sent" }));
    const task = vi.fn(async () => ({ reference_id: "task_1", status: "created" }));
    const baseAction = {
      type: "invoice_integrity",
      agent_role: "invoice_integrity",
      flagged_invoice: { id: "inv_1" },
      vendor_contact: "vendor@example.com",
    };

    for (const decision of ["approve_as_new", "reject_duplicate", "hold_and_verify"] as const) {
      const row = proposal({ proposing_agent: "invoice_integrity", action: baseAction });
      await serviceFor(row, {
        notificationService: { email, task } as unknown as NotificationService,
      }).decide(ctx(), PROPOSAL, decision);
      expect(row.status).toBe("executed");
    }

    expect(email).toHaveBeenCalledWith(
      "vendor@example.com",
      "Invoice void notice",
      "Invoice inv_1 was rejected as a duplicate.",
    );
    expect(task).toHaveBeenCalledWith("unassigned", "Verify invoice with vendor", {
      invoice_id: "inv_1",
      proposal_id: PROPOSAL,
    });
  });

  it("emits invoice.approved for approve_as_new", async () => {
    const row = proposal({
      proposing_agent: "invoice_integrity",
      action: {
        type: "invoice_integrity",
        agent_role: "invoice_integrity",
        flagged_invoice: { id: "inv_1" },
      },
    });
    const service = serviceFor(row);

    await service.decide(ctx(), PROPOSAL, "approve_as_new");

    const emitted = (service as unknown as { deps: { audit: AuditEmitter } }).deps.audit
      .emit as ReturnType<typeof vi.fn>;
    const events = emitted.mock.calls.map((call) => call[0] as Parameters<AuditEmitter["emit"]>[0]);
    expect(events.map((event) => event.action)).toEqual(["decision.executed", "invoice.approved"]);
    expect(events[1]).toMatchObject({
      inputs: { proposal_id: PROPOSAL, invoice_id: "inv_1" },
      outputs: { invoice_id: "inv_1", source: "invoice_integrity" },
    });
  });

  it("executes vendor risk edit approval by correcting routing", async () => {
    const row = proposal({
      proposing_agent: "vendor_risk",
      action: {
        type: "vendor_risk",
        agent_role: "vendor_risk",
        counterparty_id: "cp_1",
        payment_intent_id: "pi_1",
        comparison: {
          bank_on_file: {
            bank_name: "Bank",
            routing_masked: "*****1234",
            account_masked: "*****9999",
            beneficiary: "Vendor",
          },
        },
      },
    });
    const order: string[] = [];
    const service = serviceFor(row, { order });

    const result = await service.decide(ctx(), PROPOSAL, "approve");

    expect(result).toMatchObject({ status: "executed", decision: "approve" });
    expect(order).toContain("vendor_update");
    expect(order).toContain("payment_intent_update");
  });
});

function serviceFor(
  row: ProposalRow,
  options: {
    order?: string[];
    actor?: ActorContext | null;
    paymentIntentId?: string | null;
    paymentIntents?: Partial<PaymentIntentService>;
    cardIssuer?: CardIssuer;
    disputeService?: DisputeService;
    paymentReversalService?: PaymentReversalService;
    ledgerDecisionService?: LedgerDecisionService;
    notificationService?: NotificationService;
    collectionsEmailSender?: CollectionsEmailSender;
    authorityRows?: UserAgentAuthority[];
  } = {},
): ProposalDecisionService {
  const auditRows: Array<{ id: string; idempotencyKey: string }> = [];
  const order = options.order ?? [];
  const pool = fakePool(
    row,
    auditRows,
    order,
    options.paymentIntentId ?? null,
    options.authorityRows ?? [],
  );
  const actorResolver = {
    resolve: async (input: { ctx: ServiceCallContext }) => {
      if (input.ctx.principalType !== "user") {
        throw brainError("payment_intent_approval_invalid", "actor_unresolved", {
          statusOverride: 403,
          details: { reason: "actor_unresolved" },
        });
      }
      if (options.actor === null) {
        throw brainError("payment_intent_approval_invalid", "actor_unresolved", {
          statusOverride: 403,
          details: { reason: "actor_unresolved" },
        });
      }
      return (
        options.actor ?? {
          memberId: MEMBER,
          email: "member@example.com",
          role: "approver",
          active: true,
          verification: "session",
        }
      );
    },
  } as unknown as ActorResolver;
  const audit: AuditEmitter = {
    emit: vi.fn(async (event) => {
      order.push("audit");
      const existing = auditRows.find((row) => row.idempotencyKey === event.idempotencyKey);
      if (existing !== undefined) {
        return {
          ...event,
          id: existing.id,
          eventHash: "hash",
          prevEventHash: null,
          createdAt: new Date().toISOString(),
        };
      }
      const id = auditRows.length === 0 ? "evt_1" : newAuditEventId();
      auditRows.push({ id, idempotencyKey: event.idempotencyKey ?? "" });
      return {
        ...event,
        id,
        eventHash: "hash",
        prevEventHash: null,
        createdAt: new Date().toISOString(),
      };
    }),
  };
  return new ProposalDecisionService({
    pool,
    audit,
    actorResolver,
    paymentIntents:
      (options.paymentIntents as PaymentIntentService | undefined) ??
      ({
        approve: vi.fn(async () => paymentIntent("approved")),
        reject: vi.fn(async () => paymentIntent("rejected")),
      } as unknown as PaymentIntentService),
    ...(options.cardIssuer !== undefined ? { cardIssuer: options.cardIssuer } : {}),
    ...(options.disputeService !== undefined ? { disputeService: options.disputeService } : {}),
    ...(options.paymentReversalService !== undefined
      ? { paymentReversalService: options.paymentReversalService }
      : {}),
    ...(options.ledgerDecisionService !== undefined
      ? { ledgerDecisionService: options.ledgerDecisionService }
      : {}),
    ...(options.notificationService !== undefined
      ? { notificationService: options.notificationService }
      : {}),
    ...(options.collectionsEmailSender !== undefined
      ? { collectionsEmailSender: options.collectionsEmailSender }
      : {}),
  });
}

function fakePool(
  proposal: ProposalRow,
  auditRows: Array<{ id: string; idempotencyKey: string }>,
  order: string[],
  paymentIntentId: string | null,
  authorityRows: UserAgentAuthority[],
): Pool {
  let tenant: string | null = null;
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT set_config")) {
        tenant = values[0] as string;
        return { rows: [], rowCount: 0 };
      }
      if (tenant !== TENANT) throw new Error("tenant scope was not set");
      if (sql.includes("SELECT id FROM wiki_entities")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WITH unified AS")) {
        return { rows: [rawProposalRow(proposal, paymentIntentId)], rowCount: 1 };
      }
      if (sql.includes("FROM proposals") && sql.includes("FOR UPDATE")) {
        return { rows: [proposal], rowCount: 1 };
      }
      if (sql.includes("FROM user_agent_authority")) {
        const userId = String(values[0]);
        const agent = String(values[1]);
        const row = authorityRows.find((item) => item.userId === userId && item.agent === agent);
        return {
          rows:
            row === undefined
              ? []
              : [
                  {
                    id: row.id,
                    tenant_id: row.tenantId,
                    user_id: row.userId,
                    agent: row.agent,
                    can_approve: row.canApprove,
                    can_edit: row.canEdit,
                    can_reject: row.canReject,
                    max_amount_cents: row.maxAmountCents?.toString() ?? null,
                    can_delegate: row.canDelegate,
                  },
                ],
          rowCount: row === undefined ? 0 : 1,
        };
      }
      if (sql.includes("SELECT id") && sql.includes("FROM audit_events")) {
        const prefix = String(values[0]);
        const row = auditRows.find((candidate) => candidate.idempotencyKey.startsWith(prefix));
        return {
          rows: row === undefined ? [] : [{ id: row.id }],
          rowCount: row === undefined ? 0 : 1,
        };
      }
      if (sql.includes("UPDATE ledger_counterparties")) {
        order.push("vendor_update");
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE ledger_payment_intents")) {
        order.push("payment_intent_update");
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE ledger_invoices")) {
        order.push("invoice_update");
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE ledger_obligations")) {
        order.push("obligation_update");
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE proposals")) {
        order.push("transition");
        proposal.status = values[0] as ProposalRow["status"];
        proposal.decision = values[3] as NonNullable<ProposalRow["decision"]>;
        proposal.decision_audit_id = values[4] as string;
        proposal.decided_at = new Date(values[5] as string);
        return { rows: [proposal], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return { connect: async () => client } as unknown as Pool;
}

function rawProposalRow(row: ProposalRow, paymentIntentId: string | null): Record<string, unknown> {
  const actionType = row.action["type"];
  const proposalType = actionType === "flag_transaction" ? "fraud_anomaly" : actionType;
  return {
    id: row.id,
    source_kind: paymentIntentId === null ? "proposal" : "payment_intent",
    type: paymentIntentId === null ? proposalType : "payment",
    created_at: row.created_at,
    status: row.status,
    risk_band: null,
    confidence: null,
    mode: row.action["mode"] === "notify_only" ? "notify_only" : "propose",
    narrative: null,
    action: paymentIntentId === null ? row.action : null,
    evidence_ids: [],
    agent_id: AGENT,
    agent_kind: "internal",
    agent_display_name: "Agent",
    payment_intent_id: paymentIntentId,
    action_type: paymentIntentId === null ? null : "ach_outbound",
  };
}

function paymentIntent(status: PaymentIntent["status"]): PaymentIntent {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: PAYMENT_INTENT,
    owner_id: TENANT,
    created_by_agent_id: AGENT,
    action_type: "ach_outbound",
    source_account_id: "acct_01TEST0000000000000000000",
    destination_counterparty_id: "cp_01TEST00000000000000000000",
    amount: "10.00",
    currency: "USD",
    obligation_id: null,
    invoice_id: null,
    status,
    policy_decision_id: "pd_01TEST00000000000000000000",
    approval_ids: [],
    execution_receipt_ids: [],
    decision: null,
    decision_audit_id: null,
    decided_at: null,
    source_ids: [],
    evidence_ids: [],
    provenance: "agent_contributed",
    confidence: 0.91,
    created_at: now,
    updated_at: now,
  };
}
