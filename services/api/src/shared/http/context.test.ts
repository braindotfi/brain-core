import { describe, expect, it } from "vitest";
import { contextFromRequest } from "./context.js";

function fakeRequest(partial: Record<string, unknown>): import("fastify").FastifyRequest {
  return partial as unknown as import("fastify").FastifyRequest;
}

describe("contextFromRequest", () => {
  it("includes request_id, tenant_id, principal_id, principal_type when principal present", () => {
    const ctx = contextFromRequest(
      fakeRequest({
        id: "req_01HQ7K3",
        principal: {
          id: "user_01HQ7K3",
          type: "user",
          tenantId: "tnt_01HQ7K3",
          scopes: [],
          tokenId: "token_01HQ7K3",
          expiresAt: 0,
        },
      }),
    );
    expect(ctx).toMatchObject({
      request_id: "req_01HQ7K3",
      tenant_id: "tnt_01HQ7K3",
      principal_id: "user_01HQ7K3",
      principal_type: "user",
    });
  });

  it("falls back to req_unknown when request.id missing", () => {
    const ctx = contextFromRequest(fakeRequest({}));
    expect(ctx.request_id).toBe("req_unknown");
  });

  it("omits principal-derived fields pre-auth", () => {
    const ctx = contextFromRequest(fakeRequest({ id: "req_X" }));
    expect(ctx).not.toHaveProperty("tenant_id");
    expect(ctx).not.toHaveProperty("principal_id");
  });
});
