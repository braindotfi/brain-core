import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newTenantId, newUserId } from "@brain/shared";
import type * as BrainShared from "@brain/shared";
import { PostgresGraduationProvisioningStore } from "./provisioning-repository.js";
import type { DestinationSessionSeed } from "./provisioning.js";

const serviceTokenMocks = vi.hoisted(() => ({
  ensureActiveDefaultPolicy: vi.fn(async () => undefined),
  ensureBffServiceAgent: vi.fn(async () => ({ agentId: "agent_destination", created: true })),
  findActiveProductionAgentToken: vi.fn(
    async (): Promise<{
      tenantId: string;
      agentId: string;
      tokenId: string;
      expiresAt: number;
    } | null> => null,
  ),
  insertProductionAgentToken: vi.fn(async () => ({
    tenantId: destinationTenantId,
    agentId: "agent_destination",
    tokenId: "token_destination",
    expiresAt: 1_788_328_000,
  })),
}));

vi.mock("@brain/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof BrainShared>();
  return {
    ...actual,
    brainId: () => "gvl_01K123456789ABCDEFGHJKMNPQ",
    withTenantScope: async (
      pool: { query: (sql: string, values?: readonly unknown[]) => Promise<unknown> },
      _tenantId: string,
      fn: (client: typeof pool) => Promise<unknown>,
    ) => fn(pool),
  };
});
vi.mock("../onboarding/bootstrap-member.js", () => ({
  insertBootstrapAdminMember: vi.fn(async () => undefined),
}));
vi.mock("../onboarding/service-token.js", () => serviceTokenMocks);

const sourceTenantId = newTenantId();
const destinationTenantId = newTenantId();
const alternateDestinationTenantId = newTenantId();
const actorMemberId = newUserId();
const destinationMemberId = newUserId();

describe("PostgresGraduationProvisioningStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceTokenMocks.findActiveProductionAgentToken.mockResolvedValue(null);
  });

  it("rejects a missing graduation request", async () => {
    await expect(store(fakePool([undefined])).reserve(reserveInput())).rejects.toMatchObject({
      code: "tenant_access_denied",
    });
  });

  it.each([
    { provisioning_state: "seed_failed" },
    { data_profile: "customer" },
    { access_stage: "production" },
  ])("rejects a source outside the exact demo classification", async (override) => {
    await expect(
      store(fakePool([reservationRow(override)])).reserve(reserveInput()),
    ).rejects.toMatchObject({ code: "tenant_access_denied" });
  });

  it.each(["evaluating", "manual_review", "blocked"])(
    "rejects unapproved status %s",
    async (status) => {
      await expect(
        store(fakePool([reservationRow({ status })])).reserve(reserveInput()),
      ).rejects.toMatchObject({ code: "tenant_access_denied" });
    },
  );

  it("requires either an automated or manual clear result", async () => {
    await expect(
      store(
        fakePool([reservationRow({ status: "clear", assessment_outcome: "manual_review" })]),
      ).reserve(reserveInput()),
    ).rejects.toMatchObject({ code: "tenant_access_denied" });
  });

  it("reserves fresh destination ids and normalizes carry-forward evidence", async () => {
    const pool = fakePool([reservationRow(), undefined]);
    const result = await store(pool).reserve(reserveInput());
    expect(result).toMatchObject({
      sourceTenantId,
      destinationTenantId,
      destinationMemberId,
      alreadyGraduated: false,
      copiedFields: {
        business: { business_email: "owner@brightline.example" },
        bootstrap_member: { email: "admin@brightline.example" },
      },
    });
    expect(pool.query).toHaveBeenLastCalledWith(
      expect.stringContaining("SET status = 'graduating'"),
      expect.arrayContaining([destinationTenantId, destinationMemberId, "graduation-complete"]),
    );
  });

  it("reuses reserved or finalized destinations without rewriting the request", async () => {
    const reservedPool = fakePool([
      reservationRow({
        status: "graduating",
        assessment_outcome: "manual_review",
        review_decision: "clear",
        reserved_destination_tenant_id: alternateDestinationTenantId,
        reserved_destination_member_id: actorMemberId,
      }),
    ]);
    await expect(store(reservedPool).reserve(reserveInput())).resolves.toMatchObject({
      destinationTenantId: alternateDestinationTenantId,
      destinationMemberId: actorMemberId,
      alreadyGraduated: false,
    });
    expect(reservedPool.query).toHaveBeenCalledTimes(1);

    const graduatedPool = fakePool([
      reservationRow({
        status: "graduated",
        assessment_outcome: null,
        destination_tenant_id: alternateDestinationTenantId,
      }),
    ]);
    await expect(store(graduatedPool).reserve(reserveInput())).resolves.toMatchObject({
      destinationTenantId: alternateDestinationTenantId,
      alreadyGraduated: true,
    });
  });

  it.each([
    { companyRegistrationNumber: 42 },
    { legalBusinessName: "" },
    { registrationCountry: null },
    { website: undefined },
    { businessEmail: 42 },
  ])("rejects malformed approved evidence", async (evidenceOverride) => {
    const row = reservationRow({
      evidence_payload: { ...evidence(), ...evidenceOverride },
    });
    await expect(store(fakePool([row])).reserve(reserveInput())).rejects.toMatchObject({
      code: "internal_server_error",
    });
  });

  it("provisions a classified destination and reuses an active agent token", async () => {
    const activeToken = {
      tenantId: destinationTenantId,
      agentId: "agent_destination",
      tokenId: "token_existing",
      expiresAt: 1_788_328_001,
    };
    serviceTokenMocks.findActiveProductionAgentToken.mockResolvedValue(activeToken);
    const pool = fakePool([undefined, destinationClassification(), undefined, undefined]);
    await expect(store(pool).provisionDestination(reservation(), session())).resolves.toEqual({
      agentId: "agent_destination",
      agentCreated: true,
      agentToken: activeToken,
    });
    expect(serviceTokenMocks.insertProductionAgentToken).not.toHaveBeenCalled();
  });

  it("mints an agent token when the destination has none", async () => {
    const pool = fakePool([undefined, destinationClassification(), undefined, undefined]);
    const result = await store(pool).provisionDestination(reservation(), session());
    expect(result.agentToken).toMatchObject({ tokenId: "token_destination" });
    expect(serviceTokenMocks.insertProductionAgentToken).toHaveBeenCalledWith(
      expect.anything(),
      destinationTenantId,
      "agent_destination",
    );
  });

  it.each([
    undefined,
    destinationClassification({ kind: "sandbox" }),
    destinationClassification({ sandbox: true }),
    destinationClassification({ data_profile: "synthetic_brightline_v1" }),
    destinationClassification({ access_stage: "demo" }),
  ])("rejects a destination classification mismatch", async (classification) => {
    const pool = fakePool([undefined, classification]);
    await expect(store(pool).provisionDestination(reservation(), session())).rejects.toMatchObject({
      code: "internal_server_error",
    });
  });

  it("finalizes immutable lineage and serializes both timestamp shapes", async () => {
    const stringPool = fakePool([
      undefined,
      undefined,
      lineageRow({ created_at: "2026-09-03T00:00:02Z" }),
    ]);
    await expect(store(stringPool).finalize(reservation())).resolves.toMatchObject({
      id: "gvl_01K123456789ABCDEFGHJKMNPQ",
      createdAt: "2026-09-03T00:00:02.000Z",
      financialDataCopied: false,
    });

    const datePool = fakePool([
      undefined,
      undefined,
      lineageRow({ created_at: new Date("2026-09-03T00:00:03Z") }),
    ]);
    await expect(store(datePool).finalize(reservation())).resolves.toMatchObject({
      createdAt: "2026-09-03T00:00:03.000Z",
    });
  });

  it.each([undefined, lineageRow({ destination_tenant_id: alternateDestinationTenantId })])(
    "rejects missing or conflicting finalized lineage",
    async (lineage) => {
      const pool = fakePool([undefined, undefined, lineage]);
      await expect(store(pool).finalize(reservation())).rejects.toMatchObject({
        code: "internal_server_error",
      });
    },
  );
});

function store(pool: Pool) {
  return new PostgresGraduationProvisioningStore(
    pool,
    "0x0000000000000000000000000000000000000001",
  );
}

function reserveInput() {
  return {
    sourceTenantId,
    actorMemberId,
    idempotencyKey: "graduation-complete",
    destinationTenantId,
    destinationMemberId,
  };
}

function evidence() {
  return {
    legalBusinessName: "Brightline Labs",
    registrationCountry: "US",
    companyRegistrationNumber: null,
    website: "https://brightline.example/",
    businessEmail: "OWNER@BRIGHTLINE.EXAMPLE",
  };
}

function reservationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "grad_01K123456789ABCDEFGHJKMNPQ",
    status: "clear",
    assessment_outcome: "clear",
    review_decision: null,
    evidence_payload: evidence(),
    member_email: "ADMIN@BRIGHTLINE.EXAMPLE",
    member_display_name: "Admin",
    provisioning_state: "ready_demo",
    data_profile: "synthetic_brightline_v1",
    access_stage: "demo",
    reserved_destination_tenant_id: null,
    reserved_destination_member_id: null,
    destination_tenant_id: null,
    ...overrides,
  };
}

function reservation() {
  return {
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
        email: "admin@brightline.example",
        display_name: "Admin",
        role: "admin" as const,
      },
    },
    alreadyGraduated: false,
  };
}

function session(): DestinationSessionSeed {
  return {
    tenantId: destinationTenantId,
    memberId: destinationMemberId,
    refreshTokenHash: "hash",
    familyId: "family",
    tokenId: "token_member",
    refreshToken: "refresh-token",
    refreshTtlDays: 30,
    expiresAt: 1_788_328_000,
    scopes: ["execution:admin"],
  };
}

function destinationClassification(overrides: Record<string, unknown> = {}) {
  return {
    kind: "production",
    sandbox: false,
    data_profile: "customer",
    access_stage: "production",
    ...overrides,
  };
}

function lineageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "gvl_01K123456789ABCDEFGHJKMNPQ",
    request_id: "grad_01K123456789ABCDEFGHJKMNPQ",
    tenant_id: sourceTenantId,
    destination_tenant_id: destinationTenantId,
    destination_member_id: destinationMemberId,
    graduation_mode: "unpaid",
    copied_fields: reservation().copiedFields,
    excluded_data_classes: ["ledger", "raw"],
    financial_data_copied: false,
    created_at: "2026-09-03T00:00:02Z",
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
