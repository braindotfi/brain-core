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

describe("Brain.invites", () => {
  it("consume sends the platform service auth header and invite fields", async () => {
    const { fetch, calls } = mockFetch(200, {
      tenant_id: "tnt_1",
      member: { id: "user_1" },
      session: { token: "sess-tok", refresh_token: "refresh-1", expires_in: 900 },
    });
    const brain = new Brain({ token: "placeholder", fetch });

    const result = await brain.invites.consume("platform-secret", {
      invite_token: "invite-1",
      external_ref: "ref-1",
    });

    expect(result.tenant_id).toBe("tnt_1");
    const req = calls[0]!;
    expect(req.headers.get("x-platform-service-auth")).toBe("platform-secret");
    expect(req.url).toContain("/invites/consume");
    const sent = await req.text();
    expect(sent).toContain('"invite_token":"invite-1"');
  });

  it("consume surfaces the bare-reason 403 shape as a BrainAPIError", async () => {
    const { fetch } = mockFetch(403, { reason: "invite_invalid" });
    const brain = new Brain({ token: "placeholder", fetch });

    await expect(
      brain.invites.consume("platform-secret", { invite_token: "bad", external_ref: "ref-1" }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
