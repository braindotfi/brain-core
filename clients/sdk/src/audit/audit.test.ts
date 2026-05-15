import { describe, expect, it } from "vitest";
import { Brain, type FetchLike } from "../index.js";

interface Call {
  url: string;
  method: string;
  body?: string;
}

function makeBrain(response: unknown): { brain: Brain; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      ...(init?.body !== undefined ? { body: String(init.body) } : {}),
    });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { brain: new Brain({ apiKey: "brain_sk_test_x", fetch }), calls };
}

describe("brain.audit.list", () => {
  it("hits /audit/events with the docs filter set", async () => {
    const { brain, calls } = makeBrain({ events: [], next_cursor: null });
    await brain.audit.list({
      tenantId: "acme",
      eventType: "action.executed",
      actor: "agent:payments-v1",
      from: "2026-01-01",
      to: "2026-02-01",
      limit: 100,
    });
    expect(calls[0]?.url).toContain("/audit/events");
    expect(calls[0]?.url).toContain("event_type=action.executed");
    expect(calls[0]?.url).toContain("actor=agent%3Apayments-v1");
    // SDK alias from/to → wire since/until per docs/sdk-audit.md
    expect(calls[0]?.url).toContain("since=2026-01-01");
    expect(calls[0]?.url).toContain("until=2026-02-01");
  });
});

describe("brain.audit.get", () => {
  it("hits /audit/event/{id}", async () => {
    const { brain, calls } = makeBrain({ event: {}, inclusion_proof: null });
    await brain.audit.get("evt_1");
    expect(calls[0]?.url).toContain("/audit/event/evt_1");
  });
});

describe("brain.audit.proof", () => {
  it("hits /audit/event/{id}/proof and returns the Merkle bundle", async () => {
    const { brain, calls } = makeBrain({
      event: { id: "evt_1" },
      merkle_path: ["0xabc"],
      anchored_root: "0xroot",
      base_tx_hash: "0xtx",
      base_block: 100,
      batch_index: 4,
    });
    const proof = await brain.audit.proof("evt_1");
    expect(calls[0]?.url).toContain("/audit/event/evt_1/proof");
    expect(proof.anchored_root).toBe("0xroot");
    expect(proof.base_block).toBe(100);
  });
});

describe("brain.audit.export + exportStatus", () => {
  it("export POSTs format/since/until + idempotency key", async () => {
    const { brain, calls } = makeBrain({ job_id: "job_1", status_url: "/x" });
    await brain.audit.export({
      tenantId: "acme",
      format: "jsonl",
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(calls[0]?.method).toBe("POST");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.format).toBe("jsonl");
    expect(body.since).toBe("2026-01-01");
    expect(body.until).toBe("2026-12-31");
  });

  it("exportStatus hits /audit/export/{id}", async () => {
    const { brain, calls } = makeBrain({ id: "job_1", state: "ready" });
    await brain.audit.exportStatus("job_1");
    expect(calls[0]?.url).toContain("/audit/export/job_1");
  });
});

describe("brain.audit.verify", () => {
  it("POSTs to /audit/verify and normalizes onchain_block", async () => {
    const { brain, calls } = makeBrain({
      verified: true,
      onchain_block: 1234,
    });
    const result = await brain.audit.verify({
      eventHash: "0xevt",
      merkleProof: ["0xa", "0xb"],
      merkleRoot: "0xroot",
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/audit/verify");
    expect(result.verified).toBe(true);
    expect(result.onchainBlock).toBe(1234);
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.event_hash).toBe("0xevt");
    expect(body.merkle_proof).toEqual(["0xa", "0xb"]);
  });
});
