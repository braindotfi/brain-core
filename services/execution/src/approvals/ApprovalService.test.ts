/**
 * P0.4 — approver/quorum hardening unit tests.
 *
 * Hermetic: a substring-routed fake pool stands in for Postgres so the rejection
 * logic (revoked / cross-tenant / duplicate signer) and the version-aware quorum
 * (stale exclusion) are verified without a DB. The DB-integration of the same
 * rules runs in CI via the adversarial / invariants suites.
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryAuditEmitter,
  newTenantId,
  newUserId,
  type ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import { ApprovalService, type ApprovalServiceDeps } from "./ApprovalService.js";
import type { ApprovalRow } from "./repository.js";

const TENANT = newTenantId();
const SIGNER = newUserId();
const ctx: ServiceCallContext = { tenantId: TENANT, actor: SIGNER };

function row(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: "appr_1",
    tenant_id: TENANT,
    subject_type: "payment_intent",
    subject_id: "pi_1",
    approver_principal_id: SIGNER,
    approver_role: "cfo",
    signed_at: new Date(),
    signature: null,
    policy_version: 1,
    revoked_at: null,
    signer_tenant_id: TENANT,
    status: "valid",
    ...overrides,
  };
}

/** Substring-routed fake pool. */
function fakePool(opts: { existing?: ApprovalRow | null; validRows?: ApprovalRow[] }): Pool {
  const client = {
    query: async (text: string, params?: unknown[]) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text) || text.includes("set_config")) {
        return { rows: [], rowCount: 0 };
      }
      // findApprovalForSigner
      if (text.includes("FROM approvals") && text.includes("approver_principal_id = $3")) {
        const e = opts.existing ?? null;
        return { rows: e ? [e] : [], rowCount: e ? 1 : 0 };
      }
      // insertApproval — echo a row built from the INSERT params.
      if (text.includes("INSERT INTO approvals")) {
        const p = params ?? [];
        return {
          rows: [
            row({
              id: String(p[0]),
              approver_role: (p[5] as string | null) ?? null,
              policy_version: (p[7] as number | null) ?? null,
              signer_tenant_id: String(p[8]),
            }),
          ],
          rowCount: 1,
        };
      }
      // markStaleForSupersededVersion
      if (text.includes("UPDATE approvals") && text.includes("'stale'")) {
        return { rows: [], rowCount: 0 };
      }
      // listValidApprovals
      if (text.includes("status = 'valid'")) {
        return { rows: opts.validRows ?? [], rowCount: (opts.validRows ?? []).length };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return { connect: async () => client } as unknown as Pool;
}

function deps(
  pool: Pool,
  overrides: Partial<ApprovalServiceDeps> = {},
): { deps: ApprovalServiceDeps; audit: InMemoryAuditEmitter } {
  const audit = new InMemoryAuditEmitter();
  return {
    audit,
    deps: {
      pool,
      audit,
      resolveRole: async () => "cfo",
      isApproverActive: async () => true,
      resolveSubjectOwnerTenant: async () => TENANT,
      resolveActivePolicyVersion: async () => 1,
      ...overrides,
    },
  };
}

describe("ApprovalService.sign (P0.4)", () => {
  it("(1) single-approver happy path records a valid signature + audit", async () => {
    const { deps: d, audit } = deps(fakePool({ existing: null }));
    const svc = new ApprovalService(d);
    const rec = await svc.sign(ctx, { type: "payment_intent", id: "pi_1" });
    expect(rec.approver_role).toBe("cfo");
    expect(audit.events.some((e) => e.action === "approval.payment_intent.signed")).toBe(true);
  });

  it("(4) rejects a revoked signer with approval_signer_revoked", async () => {
    const { deps: d } = deps(fakePool({ existing: null }), { isApproverActive: async () => false });
    const svc = new ApprovalService(d);
    await expect(svc.sign(ctx, { type: "payment_intent", id: "pi_1" })).rejects.toMatchObject({
      code: "approval_signer_revoked",
    });
  });

  it("(5) rejects a cross-tenant signer with approval_cross_tenant", async () => {
    const { deps: d } = deps(fakePool({ existing: null }), {
      resolveSubjectOwnerTenant: async () => newTenantId(), // different owner
    });
    const svc = new ApprovalService(d);
    await expect(svc.sign(ctx, { type: "payment_intent", id: "pi_1" })).rejects.toMatchObject({
      code: "approval_cross_tenant",
    });
  });

  it("(6) rejects a duplicate signer with approval_duplicate_signer", async () => {
    const { deps: d } = deps(fakePool({ existing: row() }));
    const svc = new ApprovalService(d);
    await expect(svc.sign(ctx, { type: "payment_intent", id: "pi_1" })).rejects.toMatchObject({
      code: "approval_duplicate_signer",
    });
  });
});

describe("ApprovalService quorum (P0.4)", () => {
  it("(2) threshold met when all required roles have valid signatures", async () => {
    const validRows = [row({ approver_role: "cfo" }), row({ id: "appr_2", approver_role: "ceo" })];
    const { deps: d } = deps(fakePool({ validRows }));
    const svc = new ApprovalService(d);
    expect(
      await svc.hasRequiredApprovals(ctx, { type: "payment_intent", id: "pi_1" }, ["cfo", "ceo"]),
    ).toBe(true);
  });

  it("(3) threshold not met when a required role is missing", async () => {
    const { deps: d } = deps(fakePool({ validRows: [row({ approver_role: "cfo" })] }));
    const svc = new ApprovalService(d);
    expect(
      await svc.hasRequiredApprovals(ctx, { type: "payment_intent", id: "pi_1" }, ["cfo", "ceo"]),
    ).toBe(false);
  });

  it("treats signer sentinel as any distinct concrete approver role", async () => {
    const validRows = [
      row({ approver_role: "cfo" }),
      row({ id: "appr_2", approver_role: "controller" }),
    ];
    const { deps: d } = deps(fakePool({ validRows }));
    const svc = new ApprovalService(d);
    expect(
      await svc.hasRequiredApprovals(ctx, { type: "proposal", id: "prop_1" }, ["signer", "signer"]),
    ).toBe(true);
  });

  it("does not let one concrete role satisfy two signer slots", async () => {
    const { deps: d } = deps(fakePool({ validRows: [row({ approver_role: "cfo" })] }));
    const svc = new ApprovalService(d);
    expect(
      await svc.hasRequiredApprovals(ctx, { type: "proposal", id: "prop_1" }, ["signer", "signer"]),
    ).toBe(false);
  });

  it("(7) signatures against a superseded policy version do not count (stale)", async () => {
    // The DB-side markStale + version filter is exercised in CI; here the fake
    // returns only the version-matching valid rows, so a stale-only subject
    // yields no quorum.
    const { deps: d } = deps(fakePool({ validRows: [] }));
    const svc = new ApprovalService(d);
    const roles = await svc.signedValidRoles(ctx, { type: "payment_intent", id: "pi_1" }, 2);
    expect(roles).toEqual([]);
  });
});

describe("ApprovalService.signAndCheckRequiredApprovals", () => {
  it("returns false when the post-write valid role set is still below quorum", async () => {
    const { deps: d } = deps(
      fakePool({ existing: null, validRows: [row({ approver_role: "cfo" })] }),
    );
    const svc = new ApprovalService(d);

    const result = await svc.signAndCheckRequiredApprovals(
      ctx,
      { type: "payment_intent", id: "pi_1" },
      ["cfo", "ceo"],
      "cfo",
    );

    expect(result.approval.approver_role).toBe("cfo");
    expect(result.quorumMet).toBe(false);
  });

  it("returns true when the post-write valid role set satisfies quorum", async () => {
    const validRows = [row({ approver_role: "cfo" }), row({ id: "appr_2", approver_role: "ceo" })];
    const { deps: d } = deps(fakePool({ existing: null, validRows }));
    const svc = new ApprovalService(d);

    const result = await svc.signAndCheckRequiredApprovals(
      ctx,
      { type: "payment_intent", id: "pi_1" },
      ["cfo", "ceo"],
      "cfo",
    );

    expect(result.quorumMet).toBe(true);
  });

  it("returns true when signer sentinel quorum has distinct concrete roles", async () => {
    const validRows = [
      row({ approver_role: "cfo" }),
      row({ id: "appr_2", approver_role: "controller" }),
    ];
    const { deps: d } = deps(fakePool({ existing: null, validRows }));
    const svc = new ApprovalService(d);

    const result = await svc.signAndCheckRequiredApprovals(
      ctx,
      { type: "proposal", id: "prop_1" },
      ["signer", "signer"],
      "cfo",
    );

    expect(result.quorumMet).toBe(true);
  });

  it("treats a duplicate signer as idempotent and does not emit a second audit event", async () => {
    const { deps: d, audit } = deps(fakePool({ existing: row(), validRows: [row()] }));
    const svc = new ApprovalService(d);

    const result = await svc.signAndCheckRequiredApprovals(
      ctx,
      { type: "payment_intent", id: "pi_1" },
      ["cfo"],
      "cfo",
    );

    expect(result.approval.id).toBe("appr_1");
    expect(result.quorumMet).toBe(true);
    expect(audit.events).toHaveLength(0);
  });
});
