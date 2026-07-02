import { describe, expect, it } from "vitest";
import type { MemberAuthority, MemberLookup } from "./types.js";
import { ActorResolver } from "./ActorResolver.js";

const tenantId = "tnt_members";

function member(id: string, email = `${id}@example.com`): MemberAuthority {
  return {
    id,
    tenantId,
    email,
    displayName: id,
    role: "approver",
    active: true,
    approvalDomains: ["ap"],
    perItemLimitCents: 100_00n,
    requiresSecondApproverAboveCents: null,
  };
}

function lookup(seed: {
  byId?: Record<string, MemberAuthority>;
  byEmail?: Record<string, MemberAuthority>;
  byLink?: Record<string, MemberAuthority>;
}): MemberLookup {
  return {
    findMemberById: async (_tenantId, id) => seed.byId?.[id] ?? null,
    findMemberByEmail: async (_tenantId, email) => seed.byEmail?.[email.toLowerCase()] ?? null,
    findMemberByIdentityLink: async (input) =>
      seed.byLink?.[`${input.surface}:${input.externalRef}`] ?? null,
  };
}

describe("ActorResolver", () => {
  it("derives session actors from server context and ignores payload actor spoofing", async () => {
    const actual = member("usr_actual");
    const spoofed = member("usr_spoofed");
    const resolver = new ActorResolver({
      members: lookup({ byId: { usr_actual: actual, usr_spoofed: spoofed } }),
    });

    const actor = await resolver.resolve({
      kind: "session",
      ctx: { tenantId, actor: "usr_actual", principalType: "user" },
      payloadActorId: "usr_spoofed",
    });

    expect(actor).toEqual({
      memberId: "usr_actual",
      email: actual.email,
      verification: "session",
    });
  });

  it("rejects API mutating calls without an asserted actor", async () => {
    const resolver = new ActorResolver({ members: lookup({}) });

    await expect(
      resolver.resolve({
        kind: "api",
        ctx: { tenantId, actor: "api_partner_1", principalType: "api_partner" },
      }),
    ).rejects.toMatchObject({
      code: "payment_intent_approval_invalid",
      statusCode: 403,
      details: { reason: "actor_unresolved" },
    });
  });

  it("resolves API asserted actors and records who asserted them", async () => {
    const actual = member("usr_approver");
    const resolver = new ActorResolver({ members: lookup({ byId: { usr_approver: actual } }) });

    await expect(
      resolver.resolve({
        kind: "api",
        ctx: { tenantId, actor: "api_partner_1", principalType: "api_partner" },
        assertedActorId: "usr_approver",
      }),
    ).resolves.toEqual({
      memberId: "usr_approver",
      email: actual.email,
      verification: "tenant_asserted",
      assertedBy: "api_partner_1",
    });
  });

  it("rejects unlinked Slack identity with actor_unresolved", async () => {
    const resolver = new ActorResolver({ members: lookup({}) });

    await expect(
      resolver.resolve({
        kind: "surface",
        tenantId,
        surface: "slack",
        externalRef: "U123",
      }),
    ).rejects.toMatchObject({
      code: "payment_intent_approval_invalid",
      statusCode: 403,
      details: { reason: "actor_unresolved" },
    });
  });

  it("resolves linked Slack identity", async () => {
    const actual = member("usr_slack");
    const resolver = new ActorResolver({
      members: lookup({ byLink: { "slack:U123": actual } }),
    });

    await expect(
      resolver.resolve({ kind: "surface", tenantId, surface: "slack", externalRef: "U123" }),
    ).resolves.toEqual({
      memberId: "usr_slack",
      email: actual.email,
      verification: "surface_linked",
    });
  });

  it("validates signed email token tenant and proposal binding", async () => {
    const actual = member("usr_email", "payable@example.com");
    const resolver = new ActorResolver({
      members: lookup({ byEmail: { "payable@example.com": actual } }),
      verifyEmailToken: async () => ({
        tenantId,
        proposalId: "prop_1",
        recipient: "payable@example.com",
      }),
    });

    await expect(
      resolver.resolve({ kind: "email", tenantId, proposalId: "prop_1", token: "valid" }),
    ).resolves.toEqual({
      memberId: "usr_email",
      email: actual.email,
      verification: "signed_token",
    });

    await expect(
      resolver.resolve({ kind: "email", tenantId, proposalId: "prop_2", token: "valid" }),
    ).rejects.toMatchObject({
      code: "payment_intent_approval_invalid",
      statusCode: 403,
      details: { reason: "actor_unresolved" },
    });
  });
});
