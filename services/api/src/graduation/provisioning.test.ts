import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, type JwtSigner } from "@brain/shared";
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
    const service = new UnpaidGraduationService(store, { sign } as unknown as JwtSigner, audit);

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
    expect(result.agent.credential.apiKey).toBe("brain_ak_live_new");
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
  });

  it("never includes risk-only or expected-volume evidence in the carry-forward contract", () => {
    expect(GRADUATION_CARRY_FORWARD_FIELDS).not.toContain("business.intended_use");
    expect(GRADUATION_CARRY_FORWARD_FIELDS).not.toContain("business.expected_monthly_requests");
    expect(GRADUATION_EXCLUDED_DATA_CLASSES).toEqual(
      expect.arrayContaining([
        "ledger",
        "raw",
        "sources",
        "proposals",
        "api_keys",
        "agent_api_keys",
        "sessions",
      ]),
    );
  });

  it("reuses an existing exchange credential without inventing plaintext on retry", async () => {
    const store = fakeStore(false);
    const audit = new InMemoryAuditEmitter();
    const sign = vi.fn(async (input: { type: string }) => `${input.type}-token`);
    const service = new UnpaidGraduationService(store, { sign } as unknown as JwtSigner, audit);

    const result = await service.complete({
      sourceTenantId,
      actorMemberId: "user_source",
      idempotencyKey: "graduation-complete-retry",
    });

    expect(result.agent.credential.id).toBe("agkey_destination");
    expect(result.agent.credential.apiKey).toBeUndefined();
    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "auth.agent_api_key.reused", outcome: "reused" }),
      ]),
    );
  });
});

function fakeStore(created = true) {
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
      agentKey: {
        row: {
          id: "agkey_destination",
          tenant_id: destinationTenantId,
          agent_id: "agent_destination",
          profile: "bff_service_v1" as const,
          environment: "live" as const,
          scopes: ["ledger:read"],
          name: "Unpaid graduation production agent",
          key_prefix: "brain_ak_live_",
          key_last4: "new",
          created_at: "2026-09-02T00:00:01.000Z",
          last_used_at: null,
          expires_at: "2026-12-01T00:00:01.000Z",
          revoked_at: null,
          rotated_from_id: null,
        },
        ...(created ? { secret: "brain_ak_live_new" } : {}),
        created,
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
