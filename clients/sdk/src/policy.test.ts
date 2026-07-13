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

describe("Brain.policy", () => {
  it("get returns the active policy", async () => {
    const { fetch, calls } = mockFetch(200, { version: 3 });
    const brain = new Brain({ token: "k", fetch });

    const policy = await brain.policy.get("acme");

    expect(policy).toEqual({ version: 3 });
    expect(calls[0]?.url).toContain("/policy/acme");
  });

  it("listVersions returns the versions array", async () => {
    const { fetch, calls } = mockFetch(200, {
      versions: [{ version: 1 }, { version: 2 }],
    });
    const brain = new Brain({ token: "k", fetch });

    const versions = await brain.policy.listVersions("acme");

    expect(versions).toHaveLength(2);
    expect(calls[0]?.url).toContain("/policy/acme/versions");
  });

  it("listVersions defaults to empty array on empty body", async () => {
    const { fetch } = mockFetch(200, {});
    const brain = new Brain({ token: "k", fetch });

    expect(await brain.policy.listVersions("acme")).toEqual([]);
  });

  it("compose returns camelCased signing payload", async () => {
    const { fetch, calls } = mockFetch(200, {
      policy_id: "pol_1",
      state: "pending_signatures",
      signing_payload: { domain: { name: "Brain" } },
    });
    const brain = new Brain({ token: "k", fetch });

    const payload = await brain.policy.compose("acme", {
      rules: [{ kind: "limit", amount: "1000" }],
    } as never);

    expect(payload.policyId).toBe("pol_1");
    expect(payload.state).toBe("pending_signatures");
    expect(payload.signingPayload).toEqual({ domain: { name: "Brain" } });
    expect(calls[0]?.url).toContain("/policy/acme/compose");
  });

  it("compose defaults state and signingPayload when missing", async () => {
    const { fetch } = mockFetch(200, { policy_id: "pol_1" });
    const brain = new Brain({ token: "k", fetch });

    const payload = await brain.policy.compose("acme", {} as never);

    expect(payload.state).toBe("pending_signatures");
    expect(payload.signingPayload).toEqual({});
  });

  it("sign submits policy_id and signatures, returns policy + activated", async () => {
    const { fetch, calls } = mockFetch(201, {
      policy: { version: 4 },
      activated: true,
    });
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.policy.sign("acme", {
      policyId: "pol_1",
      signatures: [{ address: "0x111", signature: "0xsig" }],
    });

    expect(result).toEqual({ policy: { version: 4 }, activated: true });
    const body = await calls[0]!.text();
    expect(body).toContain('"policy_id":"pol_1"');
    expect(body).toContain('"address":"0x111"');
    expect(body).toContain('"signature":"0xsig"');
  });

  it("activate is an alias for sign", async () => {
    const { fetch, calls } = mockFetch(201, {
      policy: { version: 4 },
      activated: true,
    });
    const brain = new Brain({ token: "k", fetch });

    await brain.policy.activate("acme", {
      policyId: "pol_1",
      signatures: [],
    });

    expect(calls[0]?.url).toContain("/policy/acme/sign");
  });

  it("evaluate returns the decision", async () => {
    const { fetch, calls } = mockFetch(200, { decision: "allow" });
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.policy.evaluate("acme", {
      type: "outbound_payment",
    } as never);

    expect(result).toEqual({ decision: "allow" });
    expect(calls[0]?.url).toContain("/policy/acme/evaluate");
  });

  it("simulate forwards action + version", async () => {
    const { fetch, calls } = mockFetch(200, { decision: "confirm" });
    const brain = new Brain({ token: "k", fetch });

    await brain.policy.simulate("acme", {
      action: { type: "outbound_payment" } as never,
      version: 2,
    });

    expect(calls[0]?.url).toContain("/policy/acme/simulate");
    const body = await calls[0]!.text();
    expect(body).toContain('"version":2');
    expect(body).toContain('"action":');
  });
});
