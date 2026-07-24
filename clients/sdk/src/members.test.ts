import { describe, expect, it, vi } from "vitest";

import { Brain } from "./brain.js";

function mockFetch(
  status: number,
  body: unknown,
): { fetch: typeof globalThis.fetch; calls: Request[] } {
  const calls: Request[] = [];
  const fn = vi.fn(async (input: Request | URL | string) => {
    calls.push(input as Request);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

describe("Brain.members", () => {
  it("list sends query params and returns members + next_cursor", async () => {
    const { fetch, calls } = mockFetch(200, { members: [{ id: "user_1" }], next_cursor: null });
    const brain = new Brain({ token: "owner-jwt", fetch });

    const result = await brain.members.list({ role: "admin", limit: 10 });

    expect(result.members).toHaveLength(1);
    const req = calls[0]!;
    expect(req.url).toContain("/members");
    expect(req.url).toContain("role=admin");
    expect(req.url).toContain("limit=10");
  });

  it("get fetches a member by id", async () => {
    const { fetch, calls } = mockFetch(200, { id: "user_1", role: "admin" });
    const brain = new Brain({ token: "owner-jwt", fetch });

    const member = await brain.members.get("user_1");

    expect(member.id).toBe("user_1");
    expect(calls[0]?.url).toContain("/members/user_1");
  });

  it("create posts the member body and returns invite_token when invite:true", async () => {
    const { fetch, calls } = mockFetch(201, {
      member: { id: "user_2", status: "invited" },
      audit_id: "audit_1",
      invite_token: "invite-tok",
      invite_expires_in_hours: 72,
    });
    const brain = new Brain({ token: "owner-jwt", fetch });

    const result = await brain.members.create({
      email: "new@co.com",
      role: "approver",
      invite: true,
      approval: { domains: ["ap"] },
    });

    expect(result.invite_token).toBe("invite-tok");
    const sent = await calls[0]!.text();
    expect(sent).toContain('"invite":true');
  });

  it("update sends a PATCH with only the changed fields", async () => {
    const { fetch, calls } = mockFetch(200, {
      member: { id: "user_1", role: "viewer" },
      audit_id: "audit_2",
    });
    const brain = new Brain({ token: "owner-jwt", fetch });

    await brain.members.update("user_1", { role: "viewer" });

    const req = calls[0]!;
    expect(req.method).toBe("PATCH");
    expect(req.url).toContain("/members/user_1");
    const sent = await req.text();
    expect(sent).toBe('{"role":"viewer"}');
  });

  it("deactivate sends a DELETE to /members/{id}", async () => {
    const { fetch, calls } = mockFetch(200, {
      member: { id: "user_1", status: "deactivated" },
      audit_id: "audit_3",
    });
    const brain = new Brain({ token: "owner-jwt", fetch });

    await brain.members.deactivate("user_1");

    const req = calls[0]!;
    expect(req.method).toBe("DELETE");
    expect(req.url).toContain("/members/user_1");
  });

  it("createInvite posts to /members/{id}/invites", async () => {
    const { fetch, calls } = mockFetch(200, {
      invite_token: "invite-tok-2",
      expires_at: "2026-07-24T00:00:00.000Z",
    });
    const brain = new Brain({ token: "owner-jwt", fetch });

    const result = await brain.members.createInvite("user_1");

    expect(result.invite_token).toBe("invite-tok-2");
    expect(calls[0]?.url).toContain("/members/user_1/invites");
  });

  it("revokeInvite sends a DELETE to /members/{id}/invites", async () => {
    const { fetch, calls } = mockFetch(200, { revoked: true });
    const brain = new Brain({ token: "owner-jwt", fetch });

    const result = await brain.members.revokeInvite("user_1");

    expect(result.revoked).toBe(true);
    const req = calls[0]!;
    expect(req.method).toBe("DELETE");
    expect(req.url).toContain("/members/user_1/invites");
  });

  it("addIdentityLink posts surface + external_ref to /members/{id}/identity-links", async () => {
    const { fetch, calls } = mockFetch(200, { audit_id: "audit_4" });
    const brain = new Brain({ token: "owner-jwt", fetch });

    await brain.members.addIdentityLink("user_1", {
      surface: "slack",
      external_ref: "U12345",
    });

    const req = calls[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/members/user_1/identity-links");
    const sent = await req.text();
    expect(sent).toContain('"surface":"slack"');
  });

  it("removeIdentityLink sends a DELETE with a body to /members/{id}/identity-links", async () => {
    const { fetch, calls } = mockFetch(200, { audit_id: "audit_5" });
    const brain = new Brain({ token: "owner-jwt", fetch });

    await brain.members.removeIdentityLink("user_1", {
      surface: "slack",
      external_ref: "U12345",
    });

    const req = calls[0]!;
    expect(req.method).toBe("DELETE");
    expect(req.url).toContain("/members/user_1/identity-links");
    const sent = await req.text();
    expect(sent).toContain('"external_ref":"U12345"');
  });
});
