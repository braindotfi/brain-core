import { describe, expect, it, vi } from "vitest";

import { Brain } from "./brain.js";
import { BrainAPIError } from "./errors.js";

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

describe("Brain.audit", () => {
  it("list returns events and nextCursor", async () => {
    const { fetch, calls } = mockFetch(200, {
      events: [{ id: "evt_1" }, { id: "evt_2" }],
      next_cursor: "c1",
    });
    const brain = new Brain({ token: "k", fetch });

    const page = await brain.audit.list({ layer: "execution", limit: 100 });

    expect(page.events).toHaveLength(2);
    expect(page.nextCursor).toBe("c1");
    expect(calls[0]?.url).toContain("/audit/events?layer=execution");
    expect(calls[0]?.url).toContain("limit=100");
  });

  it("list returns empty events and null cursor on empty body", async () => {
    const { fetch } = mockFetch(200, {});
    const brain = new Brain({ token: "k", fetch });

    const page = await brain.audit.list();

    expect(page.events).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("get returns event and structured inclusion proof", async () => {
    const { fetch, calls } = mockFetch(200, {
      event: { id: "evt_1" },
      inclusion_proof: {
        merkle_root: "0xabc",
        merkle_proof: ["0xa", "0xb"],
        anchor_tx_hash: "0xtx",
        anchor_block: 42,
      },
    });
    const brain = new Brain({ token: "k", fetch });

    const { event, inclusionProof } = await brain.audit.get("evt_1");

    expect(event).toEqual({ id: "evt_1" });
    expect(inclusionProof).toEqual({
      merkleRoot: "0xabc",
      merkleProof: ["0xa", "0xb"],
      anchorTxHash: "0xtx",
      anchorBlock: 42,
    });
    expect(calls[0]?.url).toContain("/audit/event/evt_1");
  });

  it("get tolerates absent inclusion_proof", async () => {
    const { fetch } = mockFetch(200, { event: { id: "evt_1" } });
    const brain = new Brain({ token: "k", fetch });

    const { inclusionProof } = await brain.audit.get("evt_1");

    expect(inclusionProof.merkleRoot).toBeUndefined();
    expect(inclusionProof.merkleProof).toBeUndefined();
  });

  it("get throws when event is missing", async () => {
    const { fetch } = mockFetch(200, {});
    const brain = new Brain({ token: "k", fetch });

    await expect(brain.audit.get("evt_1")).rejects.toBeInstanceOf(BrainAPIError);
  });

  it("history returns events for an entity", async () => {
    const { fetch, calls } = mockFetch(200, {
      entity_type: "payment_intent",
      entity_id: "pi_1",
      events: [{ id: "evt_1" }],
    });
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.audit.history("payment_intent", "pi_1");

    expect(result.events).toHaveLength(1);
    expect(result.entityType).toBe("payment_intent");
    expect(result.entityId).toBe("pi_1");
    expect(calls[0]?.url).toContain("/audit/entity/payment_intent/pi_1");
  });

  it("history returns empty events when body has none", async () => {
    const { fetch } = mockFetch(200, {});
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.audit.history("transaction", "tx_1");

    expect(result.events).toEqual([]);
  });

  it("export posts a job request and returns jobId + statusUrl", async () => {
    const { fetch, calls } = mockFetch(202, {
      job_id: "job_1",
      status_url: "https://api.brain.fi/v1/audit/export/jobs/job_1",
    });
    const brain = new Brain({ token: "k", fetch });

    const job = await brain.audit.export({
      format: "jsonl",
      since: "2026-01-01T00:00:00Z",
      until: "2026-02-01T00:00:00Z",
      layers: ["raw", "execution"],
    });

    expect(job.jobId).toBe("job_1");
    expect(job.statusUrl).toContain("/audit/export/jobs/job_1");
    const request = calls[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toContain("/audit/export");
  });

  it("verify posts the event hash and proof, returns result", async () => {
    const { fetch, calls } = mockFetch(200, {
      verified: true,
      onchain_block: 100,
    });
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.audit.verify({
      eventHash: "0xhash",
      merkleProof: ["0xa"],
      merkleRoot: "0xroot",
    });

    expect(result).toEqual({ verified: true, onchainBlock: 100 });
    const request = calls[0]!;
    const bodyText = await request.text();
    expect(bodyText).toContain("event_hash");
    expect(bodyText).toContain("merkle_proof");
    expect(bodyText).toContain("merkle_root");
  });

  it("verify defaults verified=false and onchainBlock=null when fields missing", async () => {
    const { fetch } = mockFetch(200, {});
    const brain = new Brain({ token: "k", fetch });

    const result = await brain.audit.verify({
      eventHash: "0xhash",
      merkleProof: ["0xa"],
      merkleRoot: "0xroot",
    });

    expect(result).toEqual({ verified: false, onchainBlock: null });
  });

  it("anchor.latest returns the camelCased anchor record", async () => {
    const { fetch, calls } = mockFetch(200, {
      merkle_root: "0xroot",
      event_count: 1000,
      period_start: "2026-05-01T00:00:00Z",
      period_end: "2026-05-15T00:00:00Z",
      onchain_tx_hash: "0xtx",
      onchain_block_number: 42,
    });
    const brain = new Brain({ token: "k", fetch });

    const anchor = await brain.audit.anchor.latest();

    expect(anchor).toEqual({
      merkleRoot: "0xroot",
      eventCount: 1000,
      periodStart: "2026-05-01T00:00:00Z",
      periodEnd: "2026-05-15T00:00:00Z",
      onchainTxHash: "0xtx",
      onchainBlockNumber: 42,
    });
    expect(calls[0]?.url).toContain("/audit/anchor/latest");
  });
});

describe("Brain.proof (H-07 flagship artifact)", () => {
  it("returns the full Proof for an action id via /proof/{action_id}", async () => {
    const { fetch, calls } = mockFetch(200, {
      action_id: "pi_1",
      tenant_id: "tnt_x",
      agent_id: "agent_1",
      behavior_hash: null,
      outcome: "executed",
      policy_version: "3",
      policy_hash: "deadbeef",
      matched_rule_id: "allow-small",
      gate_checks: [{ index: 1, name: "agent_identity_verified", passed: true }],
      evidence: [],
      ledger_snapshot_hash: "snap",
      audit_events: [],
      merkle_root: "cc",
      merkle_proof: [],
      chain_anchor: null,
      rail_receipt: null,
      human_explanation: "Agent agent_1's action pi_1 was executed.",
    });
    const brain = new Brain({ token: "k", fetch });

    const proof = await brain.proof("pi_1");

    expect(proof.action_id).toBe("pi_1");
    expect(proof.outcome).toBe("executed");
    expect(proof.gate_checks).toHaveLength(1);
    expect(proof.human_explanation).toContain("agent_1");
    expect(calls[0]?.url).toContain("/proof/pi_1");
  });

  it("propagates 404 (no proof / not visible to tenant)", async () => {
    const { fetch } = mockFetch(404, { code: "proof_not_found", message: "no proof" });
    const brain = new Brain({ token: "k", fetch });

    await expect(brain.proof("missing")).rejects.toMatchObject({
      status: 404,
      code: "proof_not_found",
    });
  });
});
