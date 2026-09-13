import {
  hashToken,
  newSecretToken,
  newTenantId,
  newTokenId,
  newUserId,
  scopesForMemberRole,
  type AuditEmitter,
  type JwtSigner,
  type Scope,
} from "@brain/shared";
import {
  BOOTSTRAP_APPROVAL_DOMAINS,
  BOOTSTRAP_PER_ITEM_LIMIT_CENTS,
} from "../onboarding/bootstrap-member.js";
import type { AgentApiKeyRow } from "../production-tenancy/agent-key-issuance.js";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_DAYS = 30;

export const GRADUATION_CARRY_FORWARD_FIELDS = [
  "business.legal_business_name",
  "business.registration_country",
  "business.company_registration_number",
  "business.website",
  "business.business_email",
  "bootstrap_member.email",
  "bootstrap_member.display_name",
  "bootstrap_member.role",
] as const;

export const GRADUATION_EXCLUDED_DATA_CLASSES = [
  "ledger",
  "raw",
  "sources",
  "source_credentials",
  "audit_history",
  "proposals",
  "approvals",
  "policies",
  "agents",
  "api_keys",
  "agent_api_keys",
  "sessions",
  "webhooks",
  "anchor_state",
] as const;

export interface GraduationCarryForward {
  business: {
    legal_business_name: string;
    registration_country: string;
    company_registration_number: string | null;
    website: string;
    business_email: string;
  };
  bootstrap_member: {
    email: string;
    display_name: string;
    role: "admin";
  };
}

export interface GraduationProvisioningReservation {
  requestId: string;
  sourceTenantId: string;
  destinationTenantId: string;
  destinationMemberId: string;
  copiedFields: GraduationCarryForward;
  alreadyGraduated: boolean;
}

export interface DestinationSessionSeed {
  tenantId: string;
  memberId: string;
  tokenId: string;
  familyId: string;
  refreshToken: string;
  refreshTokenHash: string;
  expiresAt: number;
  refreshTtlDays: number;
  scopes: readonly Scope[];
}

export interface ProvisionedDestination {
  agentKey: {
    row: AgentApiKeyRow;
    secret?: string;
    created: boolean;
  };
  agentId: string;
  agentCreated: boolean;
}

export interface GraduationLineageRecord {
  id: string;
  requestId: string;
  sourceTenantId: string;
  destinationTenantId: string;
  destinationMemberId: string;
  graduationMode: "unpaid";
  copiedFields: GraduationCarryForward;
  excludedDataClasses: readonly string[];
  financialDataCopied: false;
  createdAt: string;
}

export interface GraduationProvisioningStore {
  reserve(input: {
    sourceTenantId: string;
    actorMemberId: string;
    idempotencyKey: string;
    destinationTenantId: string;
    destinationMemberId: string;
  }): Promise<GraduationProvisioningReservation>;
  provisionDestination(
    reservation: GraduationProvisioningReservation,
    session: DestinationSessionSeed,
  ): Promise<ProvisionedDestination>;
  finalize(reservation: GraduationProvisioningReservation): Promise<GraduationLineageRecord>;
}

export interface CompleteUnpaidGraduationInput {
  sourceTenantId: string;
  actorMemberId: string;
  idempotencyKey: string;
}

export interface CompleteUnpaidGraduationResult {
  lineage: GraduationLineageRecord;
  session: {
    token: string;
    refreshToken: string;
    expiresIn: number;
  };
  agent: {
    id: string;
    credential: {
      id: string;
      tenantId: string;
      agentId: string;
      profile: string;
      environment: string;
      scopes: readonly string[];
      name: string;
      keyPrefix: string;
      keyLast4: string;
      createdAt: string | Date;
      lastUsedAt: string | Date | null;
      expiresAt: string | Date;
      revokedAt: string | Date | null;
      rotatedFromId: string | null;
      apiKey?: string;
    };
  };
}

export class UnpaidGraduationService {
  public constructor(
    private readonly store: GraduationProvisioningStore,
    private readonly signer: JwtSigner,
    private readonly audit: AuditEmitter,
  ) {}

  public async complete(
    input: CompleteUnpaidGraduationInput,
  ): Promise<CompleteUnpaidGraduationResult> {
    const reservation = await this.store.reserve({
      ...input,
      destinationTenantId: newTenantId(),
      destinationMemberId: newUserId(),
    });
    const session = newDestinationSession(
      reservation.destinationTenantId,
      reservation.destinationMemberId,
    );
    const provisioned = await this.store.provisionDestination(reservation, session);
    const lineage = await this.store.finalize(reservation);

    const memberToken = await this.signer.sign({
      id: session.memberId,
      type: "user",
      tenantId: session.tenantId,
      tokenId: session.tokenId,
      expiresAt: session.expiresAt,
      scopes: [...session.scopes],
    });

    await Promise.all([
      this.audit.emit({
        tenantId: input.sourceTenantId,
        layer: "identity",
        eventType: "system_activity",
        actor: input.actorMemberId,
        action: "tenant.graduation.completed",
        inputs: {
          graduation_request_id: reservation.requestId,
          graduation_mode: "unpaid",
        },
        outputs: {
          destination_tenant_id: reservation.destinationTenantId,
          copied_fields: [...GRADUATION_CARRY_FORWARD_FIELDS],
          excluded_data_classes: [...GRADUATION_EXCLUDED_DATA_CLASSES],
          financial_data_copied: false,
        },
        outcome: "graduated",
        idempotencyKey: `graduation-completed:${reservation.requestId}`,
      }),
      this.audit.emit({
        tenantId: reservation.destinationTenantId,
        layer: "execution",
        eventType: "system_activity",
        actor: reservation.destinationMemberId,
        action: "tenant.created",
        inputs: {
          created_via: "graduation",
          source_graduation_request_id: reservation.requestId,
        },
        outputs: {
          tenant_id: reservation.destinationTenantId,
          member_id: reservation.destinationMemberId,
          agent_id: provisioned.agentId,
          data_profile: "customer",
          access_stage: "production",
        },
        outcome: "created",
        idempotencyKey: `graduation-destination-created:${reservation.requestId}`,
      }),
      this.audit.emit({
        tenantId: reservation.destinationTenantId,
        layer: "execution",
        eventType: "system_activity",
        actor: reservation.destinationMemberId,
        action: "member.changed",
        inputs: { mutation: "bootstrap", before: null },
        outputs: {
          after: {
            id: reservation.destinationMemberId,
            tenantId: reservation.destinationTenantId,
            email: reservation.copiedFields.bootstrap_member.email,
            displayName: reservation.copiedFields.bootstrap_member.display_name,
            role: "admin",
            status: "active",
            active: true,
            approval: {
              domains: [...BOOTSTRAP_APPROVAL_DOMAINS],
              perItemLimit: Number(BOOTSTRAP_PER_ITEM_LIMIT_CENTS),
              requiresSecondApproverAbove: null,
            },
          },
        },
        outcome: "created",
        idempotencyKey: `graduation-bootstrap-member:${reservation.requestId}`,
      }),
      this.audit.emit({
        tenantId: reservation.destinationTenantId,
        layer: "agent",
        eventType: "system_activity",
        actor: provisioned.agentId,
        action: provisioned.agentKey.created
          ? "auth.agent_api_key.issued"
          : "auth.agent_api_key.reused",
        inputs: {
          tenant_created: provisioned.agentKey.created,
          agent_created: provisioned.agentCreated,
          profile: provisioned.agentKey.row.profile,
          environment: provisioned.agentKey.row.environment,
        },
        outputs: {
          tenant_id: reservation.destinationTenantId,
          agent_id: provisioned.agentId,
          credential_id: provisioned.agentKey.row.id,
          expires_at: provisioned.agentKey.row.expires_at,
        },
        outcome: provisioned.agentKey.created ? "created" : "reused",
        idempotencyKey: `graduation-agent-key:${reservation.requestId}:${provisioned.agentKey.created ? "issued" : "reused"}`,
      }),
    ]);

    return {
      lineage,
      session: {
        token: memberToken,
        refreshToken: session.refreshToken,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      },
      agent: {
        id: provisioned.agentId,
        credential: {
          id: provisioned.agentKey.row.id,
          tenantId: provisioned.agentKey.row.tenant_id,
          agentId: provisioned.agentKey.row.agent_id,
          profile: provisioned.agentKey.row.profile,
          environment: provisioned.agentKey.row.environment,
          scopes: provisioned.agentKey.row.scopes,
          name: provisioned.agentKey.row.name,
          keyPrefix: provisioned.agentKey.row.key_prefix,
          keyLast4: provisioned.agentKey.row.key_last4,
          createdAt: provisioned.agentKey.row.created_at,
          lastUsedAt: provisioned.agentKey.row.last_used_at,
          expiresAt: provisioned.agentKey.row.expires_at,
          revokedAt: provisioned.agentKey.row.revoked_at,
          rotatedFromId: provisioned.agentKey.row.rotated_from_id,
          ...(provisioned.agentKey.secret !== undefined
            ? { apiKey: provisioned.agentKey.secret }
            : {}),
        },
      },
    };
  }
}

function newDestinationSession(tenantId: string, memberId: string): DestinationSessionSeed {
  const refreshToken = newSecretToken();
  return {
    tenantId,
    memberId,
    tokenId: newTokenId(),
    familyId: newTokenId(),
    refreshToken,
    refreshTokenHash: hashToken(refreshToken),
    expiresAt: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlDays: REFRESH_TOKEN_TTL_DAYS,
    scopes: scopesForMemberRole("admin"),
  };
}
