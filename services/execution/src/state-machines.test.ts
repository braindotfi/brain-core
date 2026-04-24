import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  isValidAgentTransition,
  isValidExecutionTransition,
  isValidProposalTransition,
  type AgentState,
  type ExecutionState,
  type ProposalState,
} from "./state-machines.js";

const PROP: ProposalState[] = ["pending", "approved", "rejected", "executed", "failed"];
const EXEC: ExecutionState[] = ["dispatched", "in_flight", "completed", "failed"];
const AGENT: AgentState[] = ["pending_onchain", "active", "revoked", "failed"];

describe("§8.1 proposal", () => {
  it("pending → approved | rejected", () => {
    expect(isValidProposalTransition("pending", "approved")).toBe(true);
    expect(isValidProposalTransition("pending", "rejected")).toBe(true);
    expect(isValidProposalTransition("pending", "executed")).toBe(false);
  });
  it("approved → executed | rejected", () => {
    expect(isValidProposalTransition("approved", "executed")).toBe(true);
    expect(isValidProposalTransition("approved", "rejected")).toBe(true);
  });
  it("terminal state rejected has no outgoing edges", () => {
    for (const to of PROP) expect(isValidProposalTransition("rejected", to)).toBe(false);
  });
  it("terminal state failed has no outgoing edges", () => {
    for (const to of PROP) expect(isValidProposalTransition("failed", to)).toBe(false);
  });
  it("property: no self-transitions", () => {
    fc.assert(fc.property(fc.constantFrom(...PROP), (s) => {
      expect(isValidProposalTransition(s, s)).toBe(false);
    }));
  });
});

describe("§8.2 execution", () => {
  it("dispatched → in_flight | failed", () => {
    expect(isValidExecutionTransition("dispatched", "in_flight")).toBe(true);
    expect(isValidExecutionTransition("dispatched", "failed")).toBe(true);
    expect(isValidExecutionTransition("dispatched", "completed")).toBe(false);
  });
  it("in_flight → completed | failed", () => {
    expect(isValidExecutionTransition("in_flight", "completed")).toBe(true);
    expect(isValidExecutionTransition("in_flight", "failed")).toBe(true);
  });
  it("property: terminal states never transition", () => {
    fc.assert(
      fc.property(fc.constantFrom("completed", "failed" as const), fc.constantFrom(...EXEC), (from, to) => {
        expect(isValidExecutionTransition(from, to)).toBe(false);
      }),
    );
  });
});

describe("§8.4 agent registration", () => {
  it("pending_onchain → active | failed", () => {
    expect(isValidAgentTransition("pending_onchain", "active")).toBe(true);
    expect(isValidAgentTransition("pending_onchain", "failed")).toBe(true);
  });
  it("active → revoked only", () => {
    expect(isValidAgentTransition("active", "revoked")).toBe(true);
    expect(isValidAgentTransition("active", "failed")).toBe(false);
  });
  it("property: terminal states are sinks", () => {
    fc.assert(
      fc.property(fc.constantFrom("revoked", "failed" as const), fc.constantFrom(...AGENT), (from, to) => {
        expect(isValidAgentTransition(from, to)).toBe(false);
      }),
    );
  });
});
