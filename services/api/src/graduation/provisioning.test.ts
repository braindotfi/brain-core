import { describe, expect, it, vi } from "vitest";
import { BFF_SERVICE_AGENT_SCOPES, InMemoryAuditEmitter, type JwtSigner } from "@brain/shared";
import {
  GRADUATION_CARRY_FORWARD_FIELDS,
  GRADUATION_EXCLUDED_DATA_CLASSES,
  UnpaidGraduationService,
  type GraduationProvisioningReservation,
  type GraduationProvisioningStore,
} from "./provisioning.js";

const sourceTenantId = "tnt_01K123456789ABCDEFGHJKMNPQ";
const destinationTenantId = "tnt_01K123456789ABCDEFGHJKMNPR";
const destinationMemberId = "user_01K123456789ABCDEFGHJKMNPQ";

describe("UnpaidGraduationService", () => {
  it("provisions a fresh tenant and records an explicit no-copy boundary", async () => {
    const store = fakeStore();
    const audit = new InMemoryAuditEmitter();
    const sign = vi.fn(async (input: { type: string }) => `${input.type}-token`);
    const service = new UnpaidGraduationService(store, { sign } as unknown as JwtSigner, audit, {
      tokenEndpoint: "https://auth.brain.fi/token",
      resource: "https://api.brain.fi/",
    });

    const result = await service.complete({
      sourceTenantId,
      actorMemberId: "user_source",
      idempotencyKey: "graduation-complete-1",
    });

    expect(result.lineage).toMatchObject({
      sourceTenantId,
      destinationTenantId,
      graduationMode: "unpaid",
      financialDataCopied: false,
    });
    expect(result.session.token).toBe("user-token");
    expect(result.agent).toMatchObject({
      credentialId: "agkey_01K123456789ABCDEFGHJKMNPQ",
      apiKey: "brain_ak_live_one-time-secret",
      profile: "bff_service_v1",
      environment: "live",
      scopes: BFF_SERVICE_AGENT_SCOPES,
      issuedNow: true,
      tokenExchange: {
        tokenEndpoint: "https://auth.brain.fi/token",
        resource: "https://api.brain.fi/",
        accessTokenExpiresIn: 300,
        refreshTokenIssued: false,
      },
    });
    expect(sign).toHaveBeenCalledOnce();
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ type: "user" }));
    expect(store.reserve).toHaveBeenCalledOnce();
    expect(store.provisionDestination).toHaveBeenCalledOnce();
    expect(store.finalize).toHaveBeenCalledOnce();
    expect(audit.events).toHaveLength(4);
    expect(audit.events[0]).toMatchObject({
      action: "tenant.graduation.completed",
      outputs: {
        copied_fields: [...GRADUATION_CARRY_FORWARD_FIELDS],
        excluded_data_classes: [...GRADUATION_EXCLUDED_DATA_CLASSES],
        financial_data_copied: false,
      },
    });
    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "member.changed" }),
        expect.objectContaining({ action: "auth.agent_api_key.issued" }),
      ]),
    );
    expect(audit.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "auth.production_agent_token.minted" }),
      ]),
    );
  });

  it("never includes risk-only or expected-volume evidence in the carry-forward contract", () => {
    expect(GRADUATION_CARRY_FORWARD_FIELDS).not.toContain("business.intended_use");
    expect(GRADUATION_CARRY_FORWARD_FIELDS).not.toContain("business.expected_monthly_requests");
    expect(GRADUATION_EXCLUDED_DATA_CLASSES).toEqual(
      expect.arrayContaining(["ledger", "raw", "sources", "proposals", "api_keys", "sessions"]),
    );
  });
});

function fakeStore() {
  const reservation: GraduationProvisioningReservation = {
    requestId: "grad_01K123456789ABCDEFGHJKMNPQ",
    sourceTenantId,
    destinationTenantId,
    destinationMemberId,
    copiedFields: {
      business: {
        legal_business_name: "Brightline Labs",
        registration_country: "US",
        company_registration_number: null,
        website: "https://brightline.example/",
        business_email: "owner@brightline.example",
      },
      bootstrap_member: {
        email: "owner@brightline.example",
        display_name: "Owner",
        role: "admin",
      },
    },
    alreadyGraduated: false,
  };
  return {
    reserve: vi.fn(async () => reservation),
    provisionDestination: vi.fn(async () => ({
      agentId: "agent_destination",
      agentCreated: true,
      agentCredential: {
        credentialId: "agkey_01K123456789ABCDEFGHJKMNPQ",
        apiKey: "brain_ak_live_one-time-secret",
        profile: "bff_service_v1" as const,
        environment: "live" as const,
        scopes: BFF_SERVICE_AGENT_SCOPES,
        keyPrefix: "brain_ak_live_",
        keyLast4: "cret",
        expiresAt: "2026-12-12T00:00:00.000Z",
        issuedNow: true as const,
      },
    })),
    finalize: vi.fn(async () => ({
      id: "gvl_01K123456789ABCDEFGHJKMNPQ",
      requestId: reservation.requestId,
      sourceTenantId,
      destinationTenantId,
      destinationMemberId,
      graduationMode: "unpaid" as const,
      copiedFields: reservation.copiedFields,
      excludedDataClasses: [...GRADUATION_EXCLUDED_DATA_CLASSES],
      financialDataCopied: false as const,
      createdAt: "2026-09-02T00:00:02.000Z",
    })),
  } satisfies GraduationProvisioningStore;
}
