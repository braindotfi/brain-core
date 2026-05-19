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

describe("Brain.wiki", () => {
  it("question posts question + optional asOf/maxEvidenceDepth", async () => {
    const { fetch, calls } = mockFetch(200, {
      answer: "your cash is fine",
    });
    const brain = new Brain({ apiKey: "k", fetch });

    const answer = await brain.wiki.question({
      question: "what's my cash position?",
      asOf: "2026-05-01T00:00:00Z",
      maxEvidenceDepth: 5,
    });

    expect(answer).toEqual({ answer: "your cash is fine" });
    const body = await calls[0]!.text();
    expect(body).toContain('"question":"what');
    expect(body).toContain('"as_of":"2026-05-01T00:00:00Z"');
    expect(body).toContain('"max_evidence_depth":5');
  });

  it("question omits optional fields when not provided", async () => {
    const { fetch, calls } = mockFetch(200, {});
    const brain = new Brain({ apiKey: "k", fetch });

    await brain.wiki.question({ question: "q?" });

    const body = await calls[0]!.text();
    expect(body).not.toContain("as_of");
    expect(body).not.toContain("max_evidence_depth");
  });

  it("search returns results + nextCursor", async () => {
    const { fetch, calls } = mockFetch(200, {
      results: [{ id: "ent_1" }],
      next_cursor: "c1",
    });
    const brain = new Brain({ apiKey: "k", fetch });

    const result = await brain.wiki.search({ q: "acme", limit: 25 });

    expect(result.results).toHaveLength(1);
    expect(result.nextCursor).toBe("c1");
    expect(calls[0]?.url).toContain("q=acme");
    expect(calls[0]?.url).toContain("limit=25");
  });

  it("search returns empty results + null cursor on empty body", async () => {
    const { fetch } = mockFetch(200, {});
    const brain = new Brain({ apiKey: "k", fetch });

    const r = await brain.wiki.search();

    expect(r.results).toEqual([]);
    expect(r.nextCursor).toBeNull();
  });

  it("getEntity forwards includeNeighbors and asOf", async () => {
    const { fetch, calls } = mockFetch(200, {
      entity: { id: "ent_1" },
      neighbors: [{ relation: { type: "owns" }, entity: { id: "ent_2" } }],
    });
    const brain = new Brain({ apiKey: "k", fetch });

    const result = await brain.wiki.getEntity("ent_1", {
      includeNeighbors: true,
      asOf: "2026-05-01T00:00:00Z",
    });

    expect(result.entity).toEqual({ id: "ent_1" });
    expect(result.neighbors).toHaveLength(1);
    expect(calls[0]?.url).toContain("/wiki/entity/ent_1");
    expect(calls[0]?.url).toContain("include_neighbors=true");
    expect(calls[0]?.url).toContain("as_of=2026-05-01");
  });

  it("getEntity returns empty neighbors when none", async () => {
    const { fetch } = mockFetch(200, { entity: { id: "ent_1" } });
    const brain = new Brain({ apiKey: "k", fetch });

    const result = await brain.wiki.getEntity("ent_1");

    expect(result.neighbors).toEqual([]);
  });

  it("getEvidence returns the evidence chain", async () => {
    const { fetch, calls } = mockFetch(200, {
      entity_id: "ent_1",
      evidence: [],
    });
    const brain = new Brain({ apiKey: "k", fetch });

    const ev = await brain.wiki.getEvidence("ent_1");

    expect(ev).toEqual({ entity_id: "ent_1", evidence: [] });
    expect(calls[0]?.url).toContain("/wiki/entity/ent_1/evidence");
  });

  it("getHistory camelCases the result", async () => {
    const { fetch, calls } = mockFetch(200, {
      entity_id: "ent_1",
      versions: [
        { id: "ent_1", _v: 1 },
        { id: "ent_1", _v: 2 },
      ],
    });
    const brain = new Brain({ apiKey: "k", fetch });

    const h = await brain.wiki.getHistory("ent_1");

    expect(h.entityId).toBe("ent_1");
    expect(h.versions).toHaveLength(2);
    expect(calls[0]?.url).toContain("/wiki/entity/ent_1/history");
  });

  it("annotate posts the body and camelCases the result", async () => {
    const { fetch, calls } = mockFetch(201, {
      annotation_id: "ann_1",
      new_version_id: "ver_2",
    });
    const brain = new Brain({ apiKey: "k", fetch });

    const r = await brain.wiki.annotate({
      target: "entity",
      entity_id: "ent_1",
    } as never);

    expect(r).toEqual({ annotationId: "ann_1", newVersionId: "ver_2" });
    const body = await calls[0]!.text();
    expect(body).toContain('"target":"entity"');
  });

  it("schema forwards kind query", async () => {
    const { fetch, calls } = mockFetch(200, { kinds: {} });
    const brain = new Brain({ apiKey: "k", fetch });

    await brain.wiki.schema({ kind: "account" });

    expect(calls[0]?.url).toContain("kind=account");
  });
});

describe("Brain.ask (compound)", () => {
  it("delegates to wiki.question", async () => {
    const { fetch, calls } = mockFetch(200, { answer: "yes" });
    const brain = new Brain({ apiKey: "k", fetch });

    const answer = await brain.ask("acme", "is this working?");

    expect(answer).toEqual({ answer: "yes" });
    expect(calls[0]?.url).toContain("/wiki/question");
    const body = await calls[0]!.text();
    expect(body).toContain('"question":"is this working?"');
  });

  it("forwards optional asOf / maxEvidenceDepth", async () => {
    const { fetch, calls } = mockFetch(200, {});
    const brain = new Brain({ apiKey: "k", fetch });

    await brain.ask("acme", "q?", { maxEvidenceDepth: 7 });

    const body = await calls[0]!.text();
    expect(body).toContain('"max_evidence_depth":7');
  });
});
