import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { newTenantId, newUserId } from "@brain/shared";
import type * as BrainShared from "@brain/shared";
import { PostgresGraduationVerificationRepository } from "./repository.js";

vi.mock("@brain/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof BrainShared>();
  return {
    ...actual,
    newTenantGraduationRequestId: () => "grad_01K123456789ABCDEFGHJKMNPQ",
    newTenantGraduationEvidenceId: () => "gve_01K123456789ABCDEFGHJKMNPQ",
    newTenantGraduationAssessmentId: () => "gva_01K123456789ABCDEFGHJKMNPQ",
    withTenantScope: async (
      pool: { query: (sql: string, values?: readonly unknown[]) => Promise<unknown> },
      _tenantId: string,
      fn: (client: typeof pool) => Promise<unknown>,
    ) => fn(pool),
  };
});

const tenantId = newTenantId();
const memberId = newUserId();
const input = {
  tenantId,
  actorMemberId: memberId,
  idempotencyKey: "graduation-key",
  profileHash: "profile-hash",
  policyVersion: "policy-v1",
  profile: {
    legalBusinessName: "Brightline Labs",
    businessEmail: "owner@brightline.example",
    website: "https://brightline.example/",
    registrationCountry: "US",
    companyRegistrationNumber: null,
    intendedUse: "Financial operations",
    expectedMonthlyRequests: 1000,
  },
};

describe("PostgresGraduationVerificationRepository", () => {
  it("returns an idempotent request and rejects a changed profile", async () => {
    const same = new PostgresGraduationVerificationRepository(fakePool([requestRow()]));
    await expect(same.start(input)).resolves.toMatchObject({
      id: requestRow().id,
      assessment: null,
    });

    const changed = new PostgresGraduationVerificationRepository(
      fakePool([requestRow({ profile_hash: "another-hash" })]),
    );
    await expect(changed.start(input)).rejects.toMatchObject({ code: "idempotency_key_reused" });
  });

  it.each(["evaluating", "verification_error", "manual_review", "needs_information"])(
    "reassesses an existing %s request when the policy changes",
    async (status) => {
      const updated = requestRow({
        status,
        verification_policy_version: "policy-v2",
        assessed_at: new Date("2026-09-03T00:00:01Z"),
        assessment_id: "gva_existing",
        assessment_outcome: "manual_review",
        assessment_signals: [],
      });
      const pool = fakePool([
        requestRow({ status, verification_policy_version: "policy-v0" }),
        undefined,
        updated,
      ]);
      const result = await new PostgresGraduationVerificationRepository(pool).start(input);
      expect(result.policyVersion).toBe("policy-v2");
      expect(result.assessment?.assessedAt).toBe("2026-09-03T00:00:01.000Z");
    },
  );

  it("rejects a reassessment that disappears after update", async () => {
    const pool = fakePool([
      requestRow({ status: "evaluating", verification_policy_version: "policy-v0" }),
      undefined,
      undefined,
    ]);
    await expect(
      new PostgresGraduationVerificationRepository(pool).start(input),
    ).rejects.toMatchObject({ code: "internal_server_error" });
  });

  it.each([
    [undefined, "tenant_access_denied"],
    [eligibleRow({ provisioning_state: "seed_failed" }), "tenant_access_denied"],
    [eligibleRow({ data_profile: "customer" }), "tenant_access_denied"],
    [eligibleRow({ access_stage: "production" }), "tenant_access_denied"],
  ])("rejects an ineligible graduation source", async (eligibility, code) => {
    const pool = fakePool([undefined, eligibility]);
    await expect(
      new PostgresGraduationVerificationRepository(pool).start(input),
    ).rejects.toMatchObject({
      code,
    });
  });

  it("rejects a second active graduation request", async () => {
    const pool = fakePool([undefined, eligibleRow(), { id: "grad_active" }]);
    await expect(
      new PostgresGraduationVerificationRepository(pool).start(input),
    ).rejects.toMatchObject({
      code: "tenant_access_denied",
    });
  });

  it("creates request and immutable evidence", async () => {
    const created = requestRow({ created_at: new Date("2026-09-03T00:00:00Z") });
    const pool = fakePool([undefined, eligibleRow(), undefined, undefined, undefined, created]);
    const result = await new PostgresGraduationVerificationRepository(pool).start(input);
    expect(result.createdAt).toBe("2026-09-03T00:00:00.000Z");
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO tenant_graduation_evidence"),
      expect.arrayContaining([tenantId, created.id, JSON.stringify(input.profile)]),
    );
  });

  it("rejects when a newly inserted request cannot be read back", async () => {
    const pool = fakePool([undefined, eligibleRow(), undefined, undefined, undefined, undefined]);
    await expect(
      new PostgresGraduationVerificationRepository(pool).start(input),
    ).rejects.toMatchObject({
      code: "internal_server_error",
    });
  });

  it("completes an assessment and rejects a missing completion", async () => {
    const completeInput = {
      tenantId,
      requestId: requestRow().id,
      policyVersion: "policy-v1",
      outcome: "clear" as const,
      signals: [],
    };
    const completedRow = requestRow({
      status: "clear",
      assessment_id: "gva_complete",
      assessment_outcome: "clear",
      assessment_signals: [],
      assessed_at: "2026-09-03T00:00:02Z",
    });
    const complete = new PostgresGraduationVerificationRepository(
      fakePool([undefined, undefined, completedRow]),
    );
    await expect(complete.complete(completeInput)).resolves.toMatchObject({
      status: "clear",
      assessment: { id: "gva_complete", outcome: "clear" },
    });

    const missing = new PostgresGraduationVerificationRepository(
      fakePool([undefined, undefined, undefined]),
    );
    await expect(missing.complete(completeInput)).rejects.toMatchObject({
      code: "internal_server_error",
    });
  });

  it("marks errors and returns current or null state", async () => {
    const pool = fakePool([undefined, requestRow()]);
    const repository = new PostgresGraduationVerificationRepository(pool);
    await repository.markVerificationError(tenantId, requestRow().id);
    await expect(repository.getCurrent(tenantId)).resolves.toMatchObject({ id: requestRow().id });
    await expect(
      new PostgresGraduationVerificationRepository(fakePool([undefined])).getCurrent(tenantId),
    ).resolves.toBeNull();
  });
});

function eligibleRow(overrides: Record<string, unknown> = {}) {
  return {
    provisioning_state: "ready_demo",
    data_profile: "synthetic_brightline_v1",
    access_stage: "demo",
    member_email: "owner@brightline.example",
    ...overrides,
  };
}

function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "grad_01K123456789ABCDEFGHJKMNPQ",
    tenant_id: tenantId,
    status: "evaluating",
    profile_hash: "profile-hash",
    verification_policy_version: "policy-v1",
    created_at: "2026-09-03T00:00:00Z",
    updated_at: "2026-09-03T00:00:01Z",
    member_email: "owner@brightline.example",
    assessment_id: null,
    assessment_outcome: null,
    assessment_signals: null,
    assessed_at: null,
    ...overrides,
  };
}

function fakePool(rows: unknown[]): Pool & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => {
    const row = rows.shift();
    return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
  });
  return { query } as unknown as Pool & { query: ReturnType<typeof vi.fn> };
}
