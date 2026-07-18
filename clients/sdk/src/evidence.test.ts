import { describe, expect, it, vi } from "vitest";

import { Brain } from "./brain.js";

function mockSequence(responses: Array<{ status: number; body: unknown }>): {
  fetch: typeof globalThis.fetch;
  calls: Request[];
} {
  const calls: Request[] = [];
  let i = 0;
  const fn = vi.fn(async (input: Request | URL | string) => {
    calls.push(input as Request);
    const r = responses[i++];
    if (!r) throw new Error("ran out of mocked responses");
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

describe("Brain.evidence", () => {
  it("resolves evidence refs", async () => {
    const { fetch, calls } = mockSequence([
      {
        status: 200,
        body: {
          results: [
            {
              kind: "counterparty",
              ref: "cp_1",
              resolvable: true,
              not_found: false,
              summary: "Acme (vendor)",
              deep_link: "/ledger/counterparties/cp_1",
            },
          ],
        },
      },
    ]);
    const brain = new Brain({ token: "k", fetch });

    const results = await brain.evidence.resolve([{ kind: "counterparty", ref: "cp_1" }]);

    expect(results[0]?.summary).toBe("Acme (vendor)");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/evidence/resolve");
    expect(await calls[0]!.text()).toBe('{"refs":[{"kind":"counterparty","ref":"cp_1"}]}');
  });
});
