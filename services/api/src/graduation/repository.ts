import type { Pool } from "pg";
import {
  brainError,
  newTenantGraduationAssessmentId,
  newTenantGraduationEvidenceId,
  newTenantGraduationRequestId,
  withTenantScope,
  type TenantScopedClient,
} from "@brain/shared";
import type {
  GraduationBusinessProfile,
  GraduationVerificationOutcome,
  GraduationVerificationSignal,
} from "./verifier.js";

export type GraduationRequestStatus =
  | "evaluating"
  | GraduationVerificationOutcome
  | "verification_error"
  | "graduating"
  | "graduated"
  | "cancelled";

export interface GraduationRequestRecord {
  id: string;
  tenantId: string;
  status: GraduationRequestStatus;
  profileHash: string;
  policyVersion: string;
  verifiedMemberEmail: string;
  assessment: {
    id: string;
    outcome: GraduationVerificationOutcome;
    signals: GraduationVerificationSignal[];
    assessedAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface StartGraduationVerificationInput {
  tenantId: string;
  actorMemberId: string;
  idempotencyKey: string;
  profileHash: string;
  policyVersion: string;
  profile: GraduationBusinessProfile;
}

export interface CompleteGraduationVerificationInput {
  tenantId: string;
  requestId: string;
  policyVersion: string;
  outcome: GraduationVerificationOutcome;
  signals: GraduationVerificationSignal[];
}

export interface GraduationVerificationRepository {
  start(input: StartGraduationVerificationInput): Promise<GraduationRequestRecord>;
  complete(input: CompleteGraduationVerificationInput): Promise<GraduationRequestRecord>;
  markVerificationError(tenantId: string, requestId: string): Promise<void>;
  getCurrent(tenantId: string): Promise<GraduationRequestRecord | null>;
}

interface RequestRow {
  id: string;
  tenant_id: string;
  status: GraduationRequestStatus;
  profile_hash: string;
  verification_policy_version: string;
  created_at: Date | string;
  updated_at: Date | string;
  member_email: string;
  assessment_id: string | null;
  assessment_outcome: GraduationVerificationOutcome | null;
  assessment_signals: GraduationVerificationSignal[] | null;
  assessed_at: Date | string | null;
}

export class PostgresGraduationVerificationRepository implements GraduationVerificationRepository {
  public constructor(private readonly pool: Pool) {}

  public async start(input: StartGraduationVerificationInput): Promise<GraduationRequestRecord> {
    return withTenantScope(this.pool, input.tenantId, async (client) => {
      const existing = await findRequestByIdempotencyKey(
        client,
        input.tenantId,
        input.idempotencyKey,
      );
      if (existing !== null) {
        if (existing.profile_hash !== input.profileHash) {
          throw brainError("idempotency_key_reused", "idempotency key reused with another profile");
        }
        if (
          existing.verification_policy_version !== input.policyVersion &&
          canReassess(existing.status)
        ) {
          await client.query(
            `UPDATE tenant_graduation_requests
                SET verification_policy_version = $3, status = 'evaluating',
                    version = version + 1, updated_at = now()
              WHERE tenant_id = $1 AND id = $2`,
            [input.tenantId, existing.id, input.policyVersion],
          );
          const reassessment = await findRequestById(client, input.tenantId, existing.id);
          if (reassessment === null) {
            throw brainError("internal_server_error", "graduation reassessment disappeared");
          }
          return serializeRequest(reassessment);
        }
        return serializeRequest(existing);
      }

      const eligibility = await client.query<{
        provisioning_state: string | null;
        data_profile: string | null;
        access_stage: string | null;
        member_email: string;
      }>(
        `SELECT t.provisioning_state, t.data_profile, t.access_stage, u.email AS member_email
           FROM tenants t
           JOIN members m ON m.tenant_id = t.id AND m.id = $2
           JOIN users u ON u.tenant_id = t.id AND u.id = m.id
          WHERE t.id = $1
            AND m.active = TRUE AND m.status = 'active'
            AND u.status = 'active' AND u.email_verified_at IS NOT NULL
          FOR UPDATE OF t`,
        [input.tenantId, input.actorMemberId],
      );
      const row = eligibility.rows[0];
      if (row === undefined) {
        throw brainError("tenant_access_denied", "active graduation member is required", {
          statusOverride: 403,
        });
      }
      if (
        row.provisioning_state !== "ready_demo" ||
        row.data_profile !== "synthetic_brightline_v1" ||
        row.access_stage !== "demo"
      ) {
        throw brainError("tenant_access_denied", "only a ready synthetic demo can graduate", {
          statusOverride: 409,
          details: { reason: "graduation_source_not_ready_demo" },
        });
      }

      const active = await client.query<{ id: string }>(
        `SELECT id FROM tenant_graduation_requests
          WHERE tenant_id = $1 AND status NOT IN ('blocked', 'cancelled')
          LIMIT 1`,
        [input.tenantId],
      );
      if (active.rows[0] !== undefined) {
        throw brainError("tenant_access_denied", "a graduation request is already active", {
          statusOverride: 409,
          details: { reason: "graduation_request_already_active" },
        });
      }

      const requestId = newTenantGraduationRequestId();
      await client.query(
        `INSERT INTO tenant_graduation_requests (
           id, tenant_id, idempotency_key, profile_hash, initiated_by_member_id,
           verification_policy_version, status
         ) VALUES ($1, $2, $3, $4, $5, $6, 'evaluating')`,
        [
          requestId,
          input.tenantId,
          input.idempotencyKey,
          input.profileHash,
          input.actorMemberId,
          input.policyVersion,
        ],
      );
      await client.query(
        `INSERT INTO tenant_graduation_evidence (
           id, tenant_id, request_id, evidence_version, evidence_type,
           payload, submitted_by_member_id
         ) VALUES ($1, $2, $3, 1, 'business_profile', $4, $5)`,
        [
          newTenantGraduationEvidenceId(),
          input.tenantId,
          requestId,
          JSON.stringify(input.profile),
          input.actorMemberId,
        ],
      );
      const created = await findRequestById(client, input.tenantId, requestId);
      if (created === null) throw brainError("internal_server_error", "graduation request missing");
      return serializeRequest(created);
    });
  }

  public async complete(
    input: CompleteGraduationVerificationInput,
  ): Promise<GraduationRequestRecord> {
    return withTenantScope(this.pool, input.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_graduation_assessments (
           id, tenant_id, request_id, verification_policy_version, outcome, signals
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, request_id, verification_policy_version) DO NOTHING`,
        [
          newTenantGraduationAssessmentId(),
          input.tenantId,
          input.requestId,
          input.policyVersion,
          input.outcome,
          JSON.stringify(input.signals),
        ],
      );
      await client.query(
        `UPDATE tenant_graduation_requests
            SET status = $3, version = version + 1, updated_at = now()
          WHERE tenant_id = $1 AND id = $2
            AND verification_policy_version = $4
            AND status IN ('evaluating', 'verification_error')`,
        [input.tenantId, input.requestId, input.outcome, input.policyVersion],
      );
      const completed = await findRequestById(client, input.tenantId, input.requestId);
      if (completed === null) {
        throw brainError("internal_server_error", "graduation request missing after verification");
      }
      return serializeRequest(completed);
    });
  }

  public async markVerificationError(tenantId: string, requestId: string): Promise<void> {
    await withTenantScope(this.pool, tenantId, async (client) => {
      await client.query(
        `UPDATE tenant_graduation_requests
            SET status = 'verification_error', version = version + 1, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND status = 'evaluating'`,
        [tenantId, requestId],
      );
    });
  }

  public async getCurrent(tenantId: string): Promise<GraduationRequestRecord | null> {
    return withTenantScope(this.pool, tenantId, async (client) => {
      const { rows } = await client.query<RequestRow>(
        `${REQUEST_SELECT}
          WHERE r.tenant_id = $1
          ORDER BY r.created_at DESC
          LIMIT 1`,
        [tenantId],
      );
      return rows[0] === undefined ? null : serializeRequest(rows[0]);
    });
  }
}

const REQUEST_SELECT = `SELECT r.id, r.tenant_id, r.status, r.profile_hash,
       r.verification_policy_version, r.created_at, r.updated_at,
       m.email AS member_email,
       a.id AS assessment_id, a.outcome AS assessment_outcome,
       a.signals AS assessment_signals, a.assessed_at
  FROM tenant_graduation_requests r
  JOIN members m
    ON m.tenant_id = r.tenant_id AND m.id = r.initiated_by_member_id
  LEFT JOIN tenant_graduation_assessments a
    ON a.tenant_id = r.tenant_id AND a.request_id = r.id
   AND a.verification_policy_version = r.verification_policy_version`;

async function findRequestByIdempotencyKey(
  client: TenantScopedClient,
  tenantId: string,
  idempotencyKey: string,
): Promise<RequestRow | null> {
  const { rows } = await client.query<RequestRow>(
    `${REQUEST_SELECT} WHERE r.tenant_id = $1 AND r.idempotency_key = $2 LIMIT 1`,
    [tenantId, idempotencyKey],
  );
  return rows[0] ?? null;
}

async function findRequestById(
  client: TenantScopedClient,
  tenantId: string,
  requestId: string,
): Promise<RequestRow | null> {
  const { rows } = await client.query<RequestRow>(
    `${REQUEST_SELECT} WHERE r.tenant_id = $1 AND r.id = $2 LIMIT 1`,
    [tenantId, requestId],
  );
  return rows[0] ?? null;
}

function serializeRequest(row: RequestRow): GraduationRequestRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status,
    profileHash: row.profile_hash,
    policyVersion: row.verification_policy_version,
    verifiedMemberEmail: row.member_email,
    assessment:
      row.assessment_id === null ||
      row.assessment_outcome === null ||
      row.assessment_signals === null ||
      row.assessed_at === null
        ? null
        : {
            id: row.assessment_id,
            outcome: row.assessment_outcome,
            signals: row.assessment_signals,
            assessedAt: toIso(row.assessed_at),
          },
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function canReassess(status: GraduationRequestStatus): boolean {
  return (
    status === "evaluating" ||
    status === "verification_error" ||
    status === "manual_review" ||
    status === "needs_information"
  );
}
