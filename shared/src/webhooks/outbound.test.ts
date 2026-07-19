import { describe, expect, it } from "vitest";
import { FORWARDED_EVENTS } from "./outbound.js";

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
