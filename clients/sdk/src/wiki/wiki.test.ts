import { beforeEach, describe, expect, it } from "vitest";
import { Brain, type FetchLike } from "../index.js";

interface Call {
  url: string;
  method: string;
  body?: string;
}

function makeBrain(response: unknown, status = 200): { brain: Brain; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      ...(init?.body !== undefined ? { body: String(init.body) } : {}),
    });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  const brain = new Brain({ apiKey: "brain_sk_test_x", fetch });
  return { brain, calls };
}

describe("brain.wiki.question", () => {
  let brain: Brain;
  let calls: Call[];

  beforeEach(() => {
    ({ brain, calls } = makeBrain({
      question: "?",
      answer: "ok",
      confidence: 0.9,
      evidence_path: [],
    }));
  });

  it("POSTs to /wiki/question with tenantId + question", async () => {
    await brain.wiki.question({
      tenantId: "acme",
      question: "What did we spend?",
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/wiki/question");
    expect(calls[0]?.body).toBe(
      JSON.stringify({ tenantId: "acme", question: "What did we spend?" }),
    );
  });

  it("forwards as_of and max_evidence_depth as snake_case", async () => {
    await brain.wiki.question({
      tenantId: "acme",
      question: "?",
      asOf: "2026-01-01T00:00:00Z",
      maxEvidenceDepth: 5,
    });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.as_of).toBe("2026-01-01T00:00:00Z");
    expect(body.max_evidence_depth).toBe(5);
  });
});

describe("brain.wiki.getEntity", () => {
  it("calls GET /wiki/entities/{id} with include_neighbors when set", async () => {
    const { brain, calls } = makeBrain({ entity: {}, neighbors: [] });
    await brain.wiki.getEntity({
      tenantId: "acme",
      entityId: "ent_1",
      includeNeighbors: true,
    });
    expect(calls[0]?.url).toContain("/wiki/entities/ent_1");
    expect(calls[0]?.url).toContain("include_neighbors=true");
  });
});

describe("brain.wiki.getRelated", () => {
  it("hits /wiki/entities/{id}/relationships", async () => {
    const { brain, calls } = makeBrain({
      entity_id: "ent_1",
      relationships: [],
    });
    await brain.wiki.getRelated({
      tenantId: "acme",
      entityId: "ent_1",
      relationship: "owes",
      limit: 10,
    });
    expect(calls[0]?.url).toContain("/wiki/entities/ent_1/relationships");
    expect(calls[0]?.url).toContain("relationship=owes");
    expect(calls[0]?.url).toContain("limit=10");
  });
});

describe("brain.wiki.search vs semanticSearch", () => {
  it("search() POSTs to /wiki/search", async () => {
    const { brain, calls } = makeBrain({ results: [], next_cursor: null });
    await brain.wiki.search({
      tenantId: "acme",
      query: "Q3 vendors",
      limit: 20,
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/wiki/search");
  });

  it("semanticSearch() POSTs to /wiki/semantic_search and forwards minScore", async () => {
    const { brain, calls } = makeBrain({ results: [] });
    await brain.wiki.semanticSearch({
      tenantId: "acme",
      query: "AWS savings",
      minScore: 0.7,
    });
    expect(calls[0]?.url).toContain("/wiki/semantic_search");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.min_score).toBe(0.7);
  });
});

describe("brain.wiki.getPage / regeneratePage", () => {
  it("getPage hits /memory/pages/{slug}", async () => {
    const { brain, calls } = makeBrain({ id: "wpg_1" });
    await brain.wiki.getPage({ tenantId: "acme", slugOrId: "/accounts/acc_1" });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/memory/pages/%2Faccounts%2Facc_1");
  });

  it("regeneratePage POSTs to /memory/regenerate", async () => {
    const { brain, calls } = makeBrain({ id: "wpg_1" });
    await brain.wiki.regeneratePage({
      tenantId: "acme",
      slugOrId: "/accounts/acc_1",
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/memory/regenerate");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.slug_or_id).toBe("/accounts/acc_1");
  });
});
