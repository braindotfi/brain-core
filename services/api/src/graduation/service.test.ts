import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, newTenantId, newUserId } from "@brain/shared";
import type {
  CompleteGraduationVerificationInput,
  GraduationRequestRecord,
  GraduationVerificationRepository,
  StartGraduationVerificationInput,
} from "./repository.js";
import { GraduationVerificationService } from "./service.js";
import { CompositeGraduationVerifier, type GraduationBusinessProfile } from "./verifier.js";

const tenantId = newTenantId();
const actorMemberId = newUserId();
const profile: GraduationBusinessProfile = {
  legalBusinessName: "Brightline Labs",
  businessEmail: "owner@brightline.example",
  website: "https://brightline.example/",
  registrationCountry: "US",
  companyRegistrationNumber: null,
  intendedUse: "Financial operations",
  expectedMonthlyRequests: 1000,
};

describe("GraduationVerificationService", () => {
  it("persists a clear assessment and emits an audit event without profile PII", async () => {
    const repository = new FakeRepository();
    const audit = new InMemoryAuditEmitter();
    const service = new GraduationVerificationService(repository, clearVerifier(), audit);

    const result = await service.submit({
      tenantId,
      actorMemberId,
      idempotencyKey: "graduation-1",
      profile,
    });

    expect(result.status).toBe("clear");
    expect(repository.completeCalls).toHaveLength(1);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      action: "tenant.graduation.verification_assessed",
      outcome: "clear",
      outputs: { outcome: "clear", reason_codes: ["approved"] },
    });
    expect(JSON.stringify(audit.events[0])).not.toContain(profile.businessEmail);
    expect(JSON.stringify(audit.events[0])).not.toContain(profile.legalBusinessName);
  });

  it("re-emits the idempotent audit event when persistence completed before a retry", async () => {
    const repository = new FakeRepository();
    const firstAudit = new InMemoryAuditEmitter();
    const service = new GraduationVerificationService(repository, clearVerifier(), firstAudit);
    await service.submit({ tenantId, actorMemberId, idempotencyKey: "retry", profile });

    const verifier = clearVerifier();
    const verify = vi.spyOn(verifier, "verify");
    const retryAudit = new InMemoryAuditEmitter();
    await new GraduationVerificationService(repository, verifier, retryAudit).submit({
      tenantId,
      actorMemberId,
      idempotencyKey: "retry",
      profile,
    });

    expect(verify).not.toHaveBeenCalled();
    expect(retryAudit.events).toHaveLength(1);
  });

  it("marks a retryable error when the verifier dependency fails", async () => {
    const repository = new FakeRepository();
    const verifier = clearVerifier();
    vi.spyOn(verifier, "verify").mockRejectedValue(new Error("provider unavailable"));
    const service = new GraduationVerificationService(
      repository,
      verifier,
      new InMemoryAuditEmitter(),
    );

    await expect(
      service.submit({ tenantId, actorMemberId, idempotencyKey: "failure", profile }),
    ).rejects.toMatchObject({ code: "dependency_unavailable" });
    expect(repository.markErrorCalls).toEqual([[tenantId, repository.record.id]]);
  });
});

function clearVerifier() {
  return new CompositeGraduationVerifier("approved_policy_v1", [
    {
      id: "approved_check",
      async evaluate() {
        return {
          checkId: "approved_check",
          outcome: "clear" as const,
          reasonCode: "approved",
          confidence: 1,
        };
      },
    },
  ]);
}

class FakeRepository implements GraduationVerificationRepository {
  public readonly completeCalls: CompleteGraduationVerificationInput[] = [];
  public readonly markErrorCalls: Array<[string, string]> = [];
  public record: GraduationRequestRecord = {
    id: "grad_01K123456789ABCDEFGHJKMNPQ",
    tenantId,
    status: "evaluating",
    profileHash: "",
    policyVersion: "approved_policy_v1",
    verifiedMemberEmail: profile.businessEmail,
    assessment: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };

  public async start(input: StartGraduationVerificationInput): Promise<GraduationRequestRecord> {
    if (this.record.profileHash !== "" && this.record.profileHash !== input.profileHash) {
      throw new Error("profile hash mismatch");
    }
    this.record = { ...this.record, profileHash: input.profileHash };
    return this.record;
  }

  public async complete(
    input: CompleteGraduationVerificationInput,
  ): Promise<GraduationRequestRecord> {
    this.completeCalls.push(input);
    this.record = {
      ...this.record,
      status: input.outcome,
      assessment: {
        id: "gva_01K123456789ABCDEFGHJKMNPQ",
        outcome: input.outcome,
        signals: input.signals,
        assessedAt: "2026-09-02T00:00:01.000Z",
      },
      updatedAt: "2026-09-02T00:00:01.000Z",
    };
    return this.record;
  }

  public async markVerificationError(requestTenantId: string, requestId: string): Promise<void> {
    this.markErrorCalls.push([requestTenantId, requestId]);
    this.record = { ...this.record, status: "verification_error" };
  }

  public async getCurrent(): Promise<GraduationRequestRecord | null> {
    return this.record;
  }
}
