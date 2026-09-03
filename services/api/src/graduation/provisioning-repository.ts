import {
  brainId,
  brainError,
  withTenantScope,
  type BrainIdPrefix,
  type TenantScopedClient,
} from "@brain/shared";
import { insertBootstrapAdminMember } from "../onboarding/bootstrap-member.js";
import {
  ensureActiveDefaultPolicy,
  ensureBffServiceAgent,
  findActiveProductionAgentToken,
  insertProductionAgentToken,
} from "../onboarding/service-token.js";
import {
  GRADUATION_EXCLUDED_DATA_CLASSES,
  type DestinationSessionSeed,
  type GraduationCarryForward,
  type GraduationLineageRecord,
  type GraduationProvisioningReservation,
  type GraduationProvisioningStore,
  type ProvisionedDestination,
} from "./provisioning.js";
import type { Pool } from "pg";

interface ReservationRow {
  id: string;
  status: string;
  assessment_outcome: string | null;
  review_decision: string | null;
  evidence_payload: Record<string, unknown>;
  member_email: string;
  member_display_name: string;
  provisioning_state: string | null;
  data_profile: string | null;
  access_stage: string | null;
  reserved_destination_tenant_id: string | null;
  reserved_destination_member_id: string | null;
  destination_tenant_id: string | null;
}

interface LineageRow {
  id: string;
  request_id: string;
  tenant_id: string;
  destination_tenant_id: string;
  destination_member_id: string;
  graduation_mode: "unpaid";
  copied_fields: GraduationCarryForward;
  excluded_data_classes: string[];
  financial_data_copied: false;
  created_at: Date | string;
}

export class PostgresGraduationProvisioningStore implements GraduationProvisioningStore {
  public constructor(
    private readonly pool: Pool,
    private readonly smartAccount: string,
  ) {}

  public async reserve(input: {
    sourceTenantId: string;
    actorMemberId: string;
    idempotencyKey: string;
    destinationTenantId: string;
    destinationMemberId: string;
  }): Promise<GraduationProvisioningReservation> {
    return withTenantScope(this.pool, input.sourceTenantId, async (client) => {
      const { rows } = await client.query<ReservationRow>(
        `SELECT r.id, r.status, a.outcome AS assessment_outcome,
                review.decision AS review_decision,
                e.payload AS evidence_payload,
                source_member.email AS member_email,
                source_member.display_name AS member_display_name,
                t.provisioning_state, t.data_profile, t.access_stage,
                r.reserved_destination_tenant_id,
                r.reserved_destination_member_id,
                lineage.destination_tenant_id
           FROM tenant_graduation_requests r
           JOIN tenants t ON t.id = r.tenant_id
           JOIN members actor
             ON actor.tenant_id = r.tenant_id AND actor.id = $2
            AND actor.active = TRUE AND actor.status = 'active' AND actor.role = 'admin'
           JOIN members source_member
             ON source_member.tenant_id = r.tenant_id
            AND source_member.id = r.initiated_by_member_id
           LEFT JOIN tenant_graduation_assessments a
             ON a.tenant_id = r.tenant_id AND a.request_id = r.id
            AND a.verification_policy_version = r.verification_policy_version
           LEFT JOIN LATERAL (
             SELECT decision
               FROM tenant_graduation_review_decisions
              WHERE tenant_id = r.tenant_id AND request_id = r.id
              ORDER BY created_at DESC
              LIMIT 1
           ) review ON TRUE
           JOIN LATERAL (
             SELECT payload
               FROM tenant_graduation_evidence
              WHERE tenant_id = r.tenant_id AND request_id = r.id
                AND evidence_type = 'business_profile'
              ORDER BY evidence_version DESC
              LIMIT 1
           ) e ON TRUE
           LEFT JOIN tenant_graduation_lineage lineage
             ON lineage.tenant_id = r.tenant_id AND lineage.request_id = r.id
          WHERE r.tenant_id = $1
          ORDER BY r.created_at DESC
          LIMIT 1
          FOR UPDATE OF r`,
        [input.sourceTenantId, input.actorMemberId],
      );
      const row = rows[0];
      if (row === undefined) {
        throw brainError("tenant_access_denied", "approved graduation request not found", {
          statusOverride: 404,
          details: { reason: "graduation_request_not_found" },
        });
      }
      if (
        row.provisioning_state !== "ready_demo" ||
        row.data_profile !== "synthetic_brightline_v1" ||
        row.access_stage !== "demo"
      ) {
        throw brainError(
          "tenant_access_denied",
          "graduation source is no longer an eligible demo",
          {
            statusOverride: 409,
            details: { reason: "graduation_source_not_ready_demo" },
          },
        );
      }
      const alreadyGraduated = row.status === "graduated";
      if (!alreadyGraduated && row.status !== "clear" && row.status !== "graduating") {
        throw brainError("tenant_access_denied", "graduation verification is not approved", {
          statusOverride: 409,
          details: { reason: "graduation_verification_not_clear", status: row.status },
        });
      }
      if (
        !alreadyGraduated &&
        row.assessment_outcome !== "clear" &&
        row.review_decision !== "clear"
      ) {
        throw brainError("tenant_access_denied", "graduation assessment is not clear", {
          statusOverride: 409,
          details: { reason: "graduation_assessment_not_clear" },
        });
      }

      const destinationTenantId =
        row.destination_tenant_id ??
        row.reserved_destination_tenant_id ??
        input.destinationTenantId;
      const destinationMemberId = row.reserved_destination_member_id ?? input.destinationMemberId;
      if (row.status === "clear") {
        await client.query(
          `UPDATE tenant_graduation_requests
              SET status = 'graduating',
                  reserved_destination_tenant_id = $3,
                  reserved_destination_member_id = $4,
                  provisioning_idempotency_key = $5,
                  version = version + 1,
                  updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND status = 'clear'`,
          [
            input.sourceTenantId,
            row.id,
            destinationTenantId,
            destinationMemberId,
            input.idempotencyKey,
          ],
        );
      }

      return {
        requestId: row.id,
        sourceTenantId: input.sourceTenantId,
        destinationTenantId,
        destinationMemberId,
        copiedFields: carryForward(row),
        alreadyGraduated,
      };
    });
  }

  public async provisionDestination(
    reservation: GraduationProvisioningReservation,
    session: DestinationSessionSeed,
  ): Promise<ProvisionedDestination> {
    return withTenantScope(this.pool, reservation.destinationTenantId, async (client) => {
      await client.query(
        `INSERT INTO tenants (
           id, kind, sandbox, created_via, audit_anchor_mode,
           provisioning_state, data_profile, access_stage, business_name
         ) VALUES ($1, 'production', FALSE, 'self_serve', 'onchain', NULL, 'customer', 'production', $2)
         ON CONFLICT (id) DO NOTHING`,
        [
          reservation.destinationTenantId,
          reservation.copiedFields.business.legal_business_name,
        ],
      );
      await assertDestinationClassification(client, reservation.destinationTenantId);
      await client.query(
        `INSERT INTO users (id, tenant_id, email, role, status)
         VALUES ($1, $2, $3, 'owner', 'active')
         ON CONFLICT (id) DO NOTHING`,
        [
          reservation.destinationMemberId,
          reservation.destinationTenantId,
          reservation.copiedFields.bootstrap_member.email,
        ],
      );
      await insertBootstrapAdminMember(client, {
        tenantId: reservation.destinationTenantId,
        memberId: reservation.destinationMemberId,
        email: reservation.copiedFields.bootstrap_member.email,
        displayName: reservation.copiedFields.bootstrap_member.display_name,
      });
      await ensureActiveDefaultPolicy(
        client,
        reservation.destinationTenantId,
        reservation.destinationMemberId,
      );
      await client.query(
        `INSERT INTO session_refresh_tokens
           (tenant_id, member_id, token_hash, family_id, token_id, expires_at, scopes)
         VALUES ($1, $2, $3, $4, $5, now() + ($6::text || ' days')::interval, $7::text[])`,
        [
          session.tenantId,
          session.memberId,
          session.refreshTokenHash,
          session.familyId,
          session.tokenId,
          session.refreshTtlDays,
          [...session.scopes],
        ],
      );
      const agent = await ensureBffServiceAgent(
        client,
        reservation.destinationTenantId,
        this.smartAccount,
      );
      const activeToken = await findActiveProductionAgentToken(
        client,
        reservation.destinationTenantId,
        agent.agentId,
      );
      const agentToken =
        activeToken ??
        (await insertProductionAgentToken(client, reservation.destinationTenantId, agent.agentId));
      return { agentId: agent.agentId, agentCreated: agent.created, agentToken };
    });
  }

  public async finalize(
    reservation: GraduationProvisioningReservation,
  ): Promise<GraduationLineageRecord> {
    return withTenantScope(this.pool, reservation.sourceTenantId, async (client) => {
      const lineageId = brainId("gvl" as BrainIdPrefix);
      await client.query(
        `INSERT INTO tenant_graduation_lineage (
           id, tenant_id, request_id, destination_tenant_id, destination_member_id,
           graduation_mode, copied_fields, excluded_data_classes,
           financial_data_copied, source_classification, destination_classification
         ) VALUES (
           $1, $2, $3, $4, $5, 'unpaid', $6::jsonb, $7::text[], FALSE,
           $8::jsonb, $9::jsonb
         )
         ON CONFLICT (tenant_id, request_id) DO NOTHING`,
        [
          lineageId,
          reservation.sourceTenantId,
          reservation.requestId,
          reservation.destinationTenantId,
          reservation.destinationMemberId,
          JSON.stringify(reservation.copiedFields),
          [...GRADUATION_EXCLUDED_DATA_CLASSES],
          JSON.stringify({
            provisioning_state: "ready_demo",
            data_profile: "synthetic_brightline_v1",
            access_stage: "demo",
          }),
          JSON.stringify({
            kind: "production",
            sandbox: false,
            data_profile: "customer",
            access_stage: "production",
          }),
        ],
      );
      await client.query(
        `UPDATE tenant_graduation_requests
            SET status = 'graduated', graduated_at = COALESCE(graduated_at, now()),
                version = CASE WHEN status = 'graduated' THEN version ELSE version + 1 END,
                updated_at = now()
          WHERE tenant_id = $1 AND id = $2
            AND reserved_destination_tenant_id = $3
            AND status IN ('graduating', 'graduated')`,
        [reservation.sourceTenantId, reservation.requestId, reservation.destinationTenantId],
      );
      const { rows } = await client.query<LineageRow>(
        `SELECT id, request_id, tenant_id, destination_tenant_id,
                destination_member_id, graduation_mode, copied_fields,
                excluded_data_classes, financial_data_copied, created_at
           FROM tenant_graduation_lineage
          WHERE tenant_id = $1 AND request_id = $2
          LIMIT 1`,
        [reservation.sourceTenantId, reservation.requestId],
      );
      const row = rows[0];
      if (row === undefined || row.destination_tenant_id !== reservation.destinationTenantId) {
        throw brainError("internal_server_error", "graduation lineage could not be finalized");
      }
      return serializeLineage(row);
    });
  }
}

function carryForward(row: ReservationRow): GraduationCarryForward {
  const profile = row.evidence_payload;
  const legalBusinessName = requiredEvidenceString(profile["legalBusinessName"]);
  const registrationCountry = requiredEvidenceString(profile["registrationCountry"]);
  const website = requiredEvidenceString(profile["website"]);
  const businessEmail = requiredEvidenceString(profile["businessEmail"]).toLowerCase();
  const companyRegistrationNumber = profile["companyRegistrationNumber"];
  if (companyRegistrationNumber !== null && typeof companyRegistrationNumber !== "string") {
    throw brainError("internal_server_error", "approved graduation evidence is malformed");
  }
  return {
    business: {
      legal_business_name: legalBusinessName,
      registration_country: registrationCountry,
      company_registration_number: companyRegistrationNumber,
      website,
      business_email: businessEmail,
    },
    bootstrap_member: {
      email: row.member_email.toLowerCase(),
      display_name: row.member_display_name,
      role: "admin",
    },
  };
}

function requiredEvidenceString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw brainError("internal_server_error", "approved graduation evidence is malformed");
  }
  return value;
}

async function assertDestinationClassification(
  client: TenantScopedClient,
  tenantId: string,
): Promise<void> {
  const { rows } = await client.query<{
    kind: string;
    sandbox: boolean;
    data_profile: string | null;
    access_stage: string | null;
  }>(
    `SELECT kind, sandbox, data_profile, access_stage
       FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId],
  );
  const row = rows[0];
  if (
    row === undefined ||
    row.kind !== "production" ||
    row.sandbox !== false ||
    row.data_profile !== "customer" ||
    row.access_stage !== "production"
  ) {
    throw brainError("internal_server_error", "graduation destination classification mismatch");
  }
}

function serializeLineage(row: LineageRow): GraduationLineageRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    sourceTenantId: row.tenant_id,
    destinationTenantId: row.destination_tenant_id,
    destinationMemberId: row.destination_member_id,
    graduationMode: row.graduation_mode,
    copiedFields: row.copied_fields,
    excludedDataClasses: row.excluded_data_classes,
    financialDataCopied: false,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString(),
  };
}
