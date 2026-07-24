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

describe("Brain.sessions", () => {
  it("create sends the platform service auth header and external_ref", async () => {
    const { fetch, calls } = mockFetch(200, {
      token: "sess-tok",
      refresh_token: "refresh-1",
      expires_in: 900,
      scopes: ["ledger:read"],
      member: { id: "user_1" },
    });
    const brain = new Brain({ token: "placeholder", fetch });

    const result = await brain.sessions.create("platform-secret", { external_ref: "ref-1" });

    expect(result.token).toBe("sess-tok");
    const req = calls[0]!;
    expect(req.headers.get("x-platform-service-auth")).toBe("platform-secret");
    const sent = await req.text();
    expect(sent).toContain('"external_ref":"ref-1"');
  });

  it("create surfaces the bare-reason 403 shape as a BrainAPIError", async () => {
    const { fetch } = mockFetch(403, { reason: "session_identity_unlinked" });
    const brain = new Brain({ token: "placeholder", fetch });

    await expect(
      brain.sessions.create("platform-secret", { external_ref: "ref-1" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("refresh posts refresh_token with no auth header", async () => {
    const { fetch, calls } = mockFetch(200, {
      token: "new-tok",
      refresh_token: "new-refresh",
      expires_in: 900,
      scopes: [],
    });
    const brain = new Brain({ token: "placeholder", fetch });

    const result = await brain.sessions.refresh({ refresh_token: "old-refresh" });

    expect(result.token).toBe("new-tok");
    const req = calls[0]!;
    expect(req.headers.get("x-platform-service-auth")).toBeNull();
    expect(req.url).toContain("/sessions/refresh");
  });

  it("revoke sends a DELETE to /sessions using the caller's bearer token", async () => {
    const { fetch, calls } = mockFetch(200, { revoked: true });
    const brain = new Brain({ token: "owner-jwt", fetch });

    const result = await brain.sessions.revoke();

    expect(result.revoked).toBe(true);
    const req = calls[0]!;
    expect(req.method).toBe("DELETE");
    expect(req.url).toContain("/sessions");
    expect(req.headers.get("authorization")).toBe("Bearer owner-jwt");
  });
});
