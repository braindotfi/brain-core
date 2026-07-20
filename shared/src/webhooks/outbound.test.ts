import { describe, expect, it } from "vitest";
import { buildWebhookPayload, FORWARDED_EVENTS } from "./outbound.js";

describe("FORWARDED_EVENTS", () => {
  it("includes customer-facing proposal, agent, raw, and terminal payment events", () => {
    expect(FORWARDED_EVENTS.has("proposal.decided")).toBe(true);
    expect(FORWARDED_EVENTS.has("agent.action.proposed")).toBe(true);
    expect(FORWARDED_EVENTS.has("raw.ingest.new")).toBe(true);
    expect(FORWARDED_EVENTS.has("raw.ingest.deduplicated")).toBe(true);
    expect(FORWARDED_EVENTS.has("raw.extraction.status_changed")).toBe(true);
    expect(FORWARDED_EVENTS.has("raw.source.status_changed")).toBe(true);
    expect(FORWARDED_EVENTS.has("payment_intent.executed")).toBe(true);
    expect(FORWARDED_EVENTS.has("payment_intent.failed")).toBe(true);
    expect(FORWARDED_EVENTS.has("payment_intent.reconciling")).toBe(true);
  });

  it("does not advertise the stale raw.ingest.completed action", () => {
    expect(FORWARDED_EVENTS.has("raw.ingest.completed")).toBe(false);
  });
});

describe("buildWebhookPayload", () => {
  it("carries the audit correlation id into the outbound payload", () => {
    const payload = buildWebhookPayload({
      id: "evt_1",
      tenantId: "tnt_1",
      layer: "execution",
      actor: "user_1",
      action: "proposal.decided",
      inputs: { proposal_id: "prop_1" },
      outputs: { status: "acknowledged" },
      correlationId: "req_client_1",
      eventHash: "a".repeat(64),
      prevEventHash: null,
      createdAt: "2026-07-20T00:00:00.000Z",
    });
    expect(payload).toMatchObject({
      id: "evt_1",
      type: "proposal.decided",
      correlation_id: "req_client_1",
    });
  });
});
