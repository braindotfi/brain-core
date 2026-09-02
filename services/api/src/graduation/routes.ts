import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { brainError, requireAdminMember, requireScope } from "@brain/shared";
import { requireIdempotencyKey, type SubmitGraduationVerificationInput } from "./service.js";
import type { GraduationRequestRecord } from "./repository.js";
import type { GraduationBusinessProfile } from "./verifier.js";

export interface GraduationRoutesDeps {
  pool: Pool;
  service: {
    submit(input: SubmitGraduationVerificationInput): Promise<GraduationRequestRecord>;
    getCurrent(tenantId: string): Promise<GraduationRequestRecord | null>;
  };
}

export async function registerGraduationRoutes(
  app: FastifyInstance,
  deps: GraduationRoutesDeps,
): Promise<void> {
  app.post<{
    Params: { tenantId: string };
    Body?: { business_profile?: unknown };
  }>("/tenants/:tenantId/graduation/verification", async (request, reply) => {
    const principal = await requireGraduationAdmin(request, deps.pool, request.params.tenantId);
    const profile = parseBusinessProfile(request.body?.business_profile);
    const result = await deps.service.submit({
      tenantId: request.params.tenantId,
      actorMemberId: principal.id,
      idempotencyKey: requireIdempotencyKey(request.headers["idempotency-key"]),
      profile,
    });
    reply.status(200);
    return serialize(result);
  });

  app.get<{ Params: { tenantId: string } }>("/tenants/:tenantId/graduation", async (request) => {
    await requireGraduationAdmin(request, deps.pool, request.params.tenantId);
    const result = await deps.service.getCurrent(request.params.tenantId);
    return { graduation: result === null ? null : serialize(result) };
  });
}

async function requireGraduationAdmin(request: FastifyRequest, pool: Pool, tenantId: string) {
  const principal = request.principal;
  if (principal === undefined) throw brainError("auth_token_missing", "principal required");
  if (principal.type !== "user") {
    throw brainError("auth_scope_insufficient", "graduation requires principal_type=user");
  }
  if (principal.tenantId !== tenantId) {
    throw brainError("auth_tenant_mismatch", "graduation is tenant self-service only");
  }
  requireScope(principal.scopes, "execution:admin");
  await requireAdminMember(pool, tenantId, principal.id);
  return principal;
}

function parseBusinessProfile(value: unknown): GraduationBusinessProfile {
  if (!isRecord(value)) {
    throw brainError("request_body_invalid", "business_profile is required");
  }
  const website = requiredString(value["website"], "business_profile.website", 500);
  let parsedWebsite: URL;
  try {
    parsedWebsite = new URL(website);
  } catch {
    throw brainError("request_body_invalid", "business_profile.website must be a valid URL");
  }
  if (parsedWebsite.protocol !== "https:") {
    throw brainError("request_body_invalid", "business_profile.website must use HTTPS");
  }
  const businessEmail = requiredString(
    value["business_email"],
    "business_profile.business_email",
    320,
  ).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(businessEmail)) {
    throw brainError("request_body_invalid", "business_profile.business_email is invalid");
  }
  const registrationCountry = requiredString(
    value["registration_country"],
    "business_profile.registration_country",
    2,
  ).toUpperCase();
  if (!/^[A-Z]{2}$/.test(registrationCountry)) {
    throw brainError(
      "request_body_invalid",
      "business_profile.registration_country must be an ISO country code",
    );
  }
  return {
    legalBusinessName: requiredString(
      value["legal_business_name"],
      "business_profile.legal_business_name",
      200,
    ),
    businessEmail,
    website: parsedWebsite.toString(),
    registrationCountry,
    companyRegistrationNumber: optionalString(
      value["company_registration_number"],
      "business_profile.company_registration_number",
      128,
    ),
    intendedUse: requiredString(value["intended_use"], "business_profile.intended_use", 1000),
    expectedMonthlyRequests: optionalPositiveInteger(
      value["expected_monthly_requests"],
      "business_profile.expected_monthly_requests",
    ),
  };
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > max) {
    throw brainError("request_body_invalid", `${field} must be between 1 and ${max} characters`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, field, max);
}

function optionalPositiveInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw brainError("request_body_invalid", `${field} must be a positive integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serialize(record: GraduationRequestRecord) {
  return {
    id: record.id,
    tenant_id: record.tenantId,
    status: record.status,
    verification_policy_version: record.policyVersion,
    assessment:
      record.assessment === null
        ? null
        : {
            id: record.assessment.id,
            outcome: record.assessment.outcome,
            signals: record.assessment.signals.map((signal) => ({
              check_id: signal.checkId,
              outcome: signal.outcome,
              reason_code: signal.reasonCode,
              confidence: signal.confidence,
            })),
            assessed_at: record.assessment.assessedAt,
          },
    next_action: nextAction(record.status),
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function nextAction(status: string): string {
  if (status === "clear") return "select_tier";
  if (status === "manual_review") return "await_manual_review";
  if (status === "needs_information") return "provide_information";
  if (status === "blocked") return "contact_support";
  if (status === "verification_error") return "retry_verification";
  return "await_verification";
}
