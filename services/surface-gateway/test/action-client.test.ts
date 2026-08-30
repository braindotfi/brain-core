import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyServiceAuthSignatureV2 } from "@brain/shared";
import { HttpSurfaceActionClient } from "../src/action-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HttpSurfaceActionClient", () => {
  it("binds the tenant and exact body into the canonical handoff signature", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ quorum_met: true, status: "approved" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpSurfaceActionClient("http://api:3000", "handoff-secret");
    await expect(
      client.approve({
        tenantId: "tnt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        proposalId: "prop_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        paymentIntentId: "pi_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        surface: "slack",
        externalActorId: "U123",
      }),
    ).resolves.toEqual({ quorumMet: true, status: "approved" });

    const call = fetchMock.mock.calls[0];
    const request = call?.[1] as {
      headers: Record<string, string>;
      body: unknown;
    };
    const headers = request.headers as Record<string, string>;
    const body = Buffer.from(String(request.body));
    expect(call?.[0]).toBe("http://api:3000/v1/internal/surface-actions/approve");
    expect(
      verifyServiceAuthSignatureV2(
        body,
        headers["x-brain-service-auth"],
        headers["x-brain-service-timestamp"],
        headers["x-brain-write-tenant"] ?? "",
        "handoff-secret",
      ),
    ).toBe(true);
  });
});
