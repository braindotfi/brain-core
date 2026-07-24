import { describe, expect, it, vi } from "vitest";
import { Brain } from "./brain.js";

describe("TenantsResource", () => {
  it("wraps tenant export status and download endpoints", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (url.endsWith("/download")) {
        return new Response("ndjson\n", {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      return Response.json({
        job_id: "texp_01HX0000000000000000000000",
        tenant_id: "tnt_01HX0000000000000000000000",
        status: "queued",
        byte_size: null,
        expires_at: "2026-07-27T00:00:00.000Z",
        error: null,
        created_at: "2026-07-20T00:00:00.000Z",
        updated_at: "2026-07-20T00:00:00.000Z",
      });
    });
    const brain = new Brain({ token: "token", environment: "local", fetch });

    await expect(brain.tenants.export("tnt_01HX0000000000000000000000")).resolves.toMatchObject({
      status: "queued",
    });
    await expect(
      brain.tenants.getExport("tnt_01HX0000000000000000000000", "texp_01HX0000000000000000000000"),
    ).resolves.toMatchObject({ job_id: "texp_01HX0000000000000000000000" });
    await expect(
      brain.tenants.downloadExport(
        "tnt_01HX0000000000000000000000",
        "texp_01HX0000000000000000000000",
      ),
    ).resolves.toBe("ndjson\n");
    expect(calls).toEqual([
      "http://localhost:3000/v1/tenants/tnt_01HX0000000000000000000000/export",
      "http://localhost:3000/v1/tenants/tnt_01HX0000000000000000000000/export/texp_01HX0000000000000000000000",
      "http://localhost:3000/v1/tenants/tnt_01HX0000000000000000000000/export/texp_01HX0000000000000000000000/download",
    ]);
  });

  it("create sends the platform service auth header, not Authorization scoping", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: Request | URL | string) => {
      requests.push(input as Request);
      return Response.json(
        {
          tenant_id: "tnt_1",
          member: { id: "user_1" },
          session: { token: "sess-token", refresh_token: "refresh-1", expires_in: 900 },
          agent: { id: "agent_1", token: "agent-token" },
        },
        { status: 201 },
      );
    });
    const brain = new Brain({ token: "placeholder", environment: "local", fetch });

    const result = await brain.tenants.create("platform-secret", {
      company_name: "Acme",
      founder: { email: "founder@acme.com" },
      founder_external_ref: "ref-1",
    });

    expect(result.tenant_id).toBe("tnt_1");
    const req = requests[0]!;
    expect(req.headers.get("x-platform-service-auth")).toBe("platform-secret");
    const sent = await req.text();
    expect(sent).toContain('"company_name":"Acme"');
  });

  it("createForOrg posts to /orgs/{orgId}/tenants and echoes org_id", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: Request | URL | string) => {
      requests.push(input as Request);
      return Response.json(
        {
          org_id: "org_1",
          tenant_id: "tnt_1",
          member: { id: "user_1" },
          session: { token: "sess-token", refresh_token: "refresh-1", expires_in: 900 },
          agent: { id: "agent_1", token: "agent-token" },
        },
        { status: 201 },
      );
    });
    const brain = new Brain({ token: "placeholder", environment: "local", fetch });

    const result = await brain.tenants.createForOrg("platform-secret", "org_1", {
      founder: { email: "founder@acme.com" },
      founder_external_ref: "ref-1",
    });

    expect(result.tenant_id).toBe("tnt_1");
    expect((result as { org_id?: string }).org_id).toBe("org_1");
    const req = requests[0]!;
    expect(req.url).toContain("/orgs/org_1/tenants");
    expect(req.headers.get("x-platform-service-auth")).toBe("platform-secret");
  });

  it("mintAgentToken sends the platform header and optional rotate flag", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: Request | URL | string) => {
      requests.push(input as Request);
      return Response.json(
        { id: "agent_1", token: "agent-token-2", tenant_id: "tnt_1" },
        { status: 201 },
      );
    });
    const brain = new Brain({ token: "placeholder", environment: "local", fetch });

    await brain.tenants.mintAgentToken("platform-secret", "tnt_1", { rotate: true });

    const req = requests[0]!;
    expect(req.url).toContain("/tenants/tnt_1/agent-token");
    expect(req.headers.get("x-platform-service-auth")).toBe("platform-secret");
    const sent = await req.text();
    expect(sent).toContain('"rotate":true');
  });

  it("linkWallet posts address and principal_type through the normal bearer client", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: Request | URL | string) => {
      requests.push(input as Request);
      return Response.json(
        { linked: true, address: "0xabc", principal_type: "human", principal_id: "user_1" },
        { status: 201 },
      );
    });
    const brain = new Brain({ token: "owner-jwt", environment: "local", fetch });

    const result = await brain.tenants.linkWallet("tnt_1", {
      address: "0x0000000000000000000000000000000000000abc",
      principal_type: "human",
    });

    expect(result.linked).toBe(true);
    const req = requests[0]!;
    expect(req.url).toContain("/tenants/tnt_1/wallets");
    expect(req.headers.get("authorization")).toBe("Bearer owner-jwt");
  });

  it("createApiKey posts name/environment/scopes and returns the plaintext secret once", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: Request | URL | string) => {
      requests.push(input as Request);
      return Response.json(
        {
          id: "akey_1",
          tenant_id: "tnt_1",
          name: "ci key",
          environment: "sandbox",
          scopes: ["ledger:read", "audit:read"],
          key_prefix: "brain_sk_test_",
          key_last4: "ab12",
          masked_key: "brain_sk_test_...ab12", // gitleaks:allow
          created_at: "2026-07-22T00:00:00.000Z",
          last_used_at: null,
          revoked_at: null,
          rotated_from_id: null,
          secret: "brain_sk_test_plaintext",
        },
        { status: 201 },
      );
    });
    const brain = new Brain({ token: "admin-jwt", environment: "local", fetch });

    const result = await brain.tenants.createApiKey("tnt_1", {
      name: "ci key",
      environment: "sandbox",
      scopes: ["ledger:read", "audit:read"],
    });

    expect(result.secret).toBe("brain_sk_test_plaintext");
    const req = requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/tenants/tnt_1/keys");
    expect(req.headers.get("authorization")).toBe("Bearer admin-jwt");
    const sent = await req.text();
    expect(sent).toContain('"environment":"sandbox"');
  });

  it("listApiKeys never sees a secret field in the mocked response shape", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        keys: [
          {
            id: "akey_1",
            tenant_id: "tnt_1",
            name: "ci key",
            environment: "sandbox",
            scopes: ["ledger:read"],
            key_prefix: "brain_sk_test_",
            key_last4: "ab12",
            masked_key: "brain_sk_test_...ab12", // gitleaks:allow
            created_at: "2026-07-22T00:00:00.000Z",
            last_used_at: null,
            revoked_at: null,
            rotated_from_id: null,
          },
        ],
      }),
    );
    const brain = new Brain({ token: "admin-jwt", environment: "local", fetch });

    const result = await brain.tenants.listApiKeys("tnt_1");

    expect(result.keys).toHaveLength(1);
    expect(result.keys?.[0]).not.toHaveProperty("secret");
  });

  it("rotateApiKey sends a truly empty body, no Content-Type", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: Request | URL | string) => {
      requests.push(input as Request);
      return Response.json(
        { id: "akey_2", rotated_from_id: "akey_1", secret: "brain_sk_test_new" },
        { status: 201 },
      );
    });
    const brain = new Brain({ token: "admin-jwt", environment: "local", fetch });

    const result = await brain.tenants.rotateApiKey("akey_1");

    expect(result.rotated_from_id).toBe("akey_1");
    const req = requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/keys/akey_1/rotate");
    expect(req.headers.get("content-type")).toBeNull();
    const sent = await req.text();
    expect(sent).toBe("");
  });

  it("revokeApiKey sends DELETE with a truly empty body and resolves on 204", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: Request | URL | string) => {
      requests.push(input as Request);
      return new Response(null, { status: 204 });
    });
    const brain = new Brain({ token: "admin-jwt", environment: "local", fetch });

    await expect(brain.tenants.revokeApiKey("akey_1")).resolves.toBeUndefined();
    const req = requests[0]!;
    expect(req.method).toBe("DELETE");
    expect(req.url).toContain("/keys/akey_1");
    expect(req.headers.get("content-type")).toBeNull();
    const sent = await req.text();
    expect(sent).toBe("");
  });

  it("getApiKeyUsage passes window/environment/key_id as query params", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: Request | URL | string) => {
      requests.push(input as Request);
      return Response.json({
        tenant_id: "tnt_1",
        window: "30d",
        total_events: 3,
        keys: [{ key_id: "akey_1", event_count: 3 }],
      });
    });
    const brain = new Brain({ token: "admin-jwt", environment: "local", fetch });

    const result = await brain.tenants.getApiKeyUsage("tnt_1", {
      window: "30d",
      environment: "sandbox",
      key_id: "akey_1",
    });

    expect(result.total_events).toBe(3);
    const req = requests[0]!;
    expect(req.url).toContain("/tenants/tnt_1/usage");
    expect(req.url).toContain("window=30d");
    expect(req.url).toContain("environment=sandbox");
    expect(req.url).toContain("key_id=akey_1");
  });
});
