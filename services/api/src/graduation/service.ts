import { brainError, hashBody, type AuditEmitter } from "@brain/shared";
import type { GraduationRequestRecord, GraduationVerificationRepository } from "./repository.js";
import type { GraduationBusinessProfile, GraduationVerifier } from "./verifier.js";

export interface SubmitGraduationVerificationInput {
  tenantId: string;
  actorMemberId: string;
  idempotencyKey: string;
  profile: GraduationBusinessProfile;
}

export class GraduationVerificationService {
  public constructor(
    private readonly repository: GraduationVerificationRepository,
    private readonly verifier: GraduationVerifier,
    private readonly audit: AuditEmitter,
  ) {}

  public async submit(input: SubmitGraduationVerificationInput): Promise<GraduationRequestRecord> {
    const profileHash = hashBody(JSON.stringify(input.profile));
    const started = await this.repository.start({
      ...input,
      profileHash,
      policyVersion: this.verifier.policyVersion,
    });
    if (started.assessment !== null) {
      await this.emitAssessmentAudit(
        input,
        started,
        started.assessment.outcome,
        started.assessment.signals,
      );
      return started;
    }

    let result;
    try {
      result = await this.verifier.verify({
        tenantId: input.tenantId,
        requestId: started.id,
        actorMemberId: input.actorMemberId,
        verifiedMemberEmail: started.verifiedMemberEmail,
        profile: input.profile,
      });
    } catch (error) {
      await this.repository.markVerificationError(input.tenantId, started.id);
      throw brainError("dependency_unavailable", "graduation verification failed", {
        cause: error,
        details: { reason: "graduation_verifier_unavailable" },
      });
    }

    const completed = await this.repository.complete({
      tenantId: input.tenantId,
      requestId: started.id,
      policyVersion: this.verifier.policyVersion,
      outcome: result.outcome,
      signals: result.signals,
    });
    await this.emitAssessmentAudit(input, completed, result.outcome, result.signals);
    return completed;
  }

  private async emitAssessmentAudit(
    input: SubmitGraduationVerificationInput,
    request: GraduationRequestRecord,
    outcome: NonNullable<GraduationRequestRecord["assessment"]>["outcome"],
    signals: NonNullable<GraduationRequestRecord["assessment"]>["signals"],
  ): Promise<void> {
    await this.audit.emit({
      tenantId: input.tenantId,
      layer: "identity",
      eventType: outcome === "clear" ? "system_activity" : "flagged",
      actor: input.actorMemberId,
      action: "tenant.graduation.verification_assessed",
      inputs: {
        graduation_request_id: request.id,
        profile_hash: request.profileHash,
        verification_policy_version: this.verifier.policyVersion,
      },
      outputs: {
        outcome,
        reason_codes: signals.map((signal) => signal.reasonCode),
      },
      outcome,
      idempotencyKey: `graduation-verification:${request.id}:${this.verifier.policyVersion}`,
    });
  }

  public getCurrent(tenantId: string): Promise<GraduationRequestRecord | null> {
    return this.repository.getCurrent(tenantId);
  }
}

export function requireIdempotencyKey(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === undefined || candidate.trim().length === 0 || candidate.length > 256) {
    throw brainError("request_body_invalid", "Idempotency-Key header is required");
  }
  return candidate;
}
