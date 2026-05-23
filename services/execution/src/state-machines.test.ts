import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  assertAgentTransition,
  assertExecutionTransition,
  assertProposalTransition,
  isValidAgentTransition,
  isValidExecutionTransition,
  isValidProposalTransition,
  type AgentState,
  type ExecutionState,
  type ProposalState,
} from "./state-machines.js";

const PROP: ProposalState[] = ["pending", "approved", "rejected", "executed", "failed"];
const EXEC: ExecutionState[] = ["dispatched", "in_flight", "completed", "failed"];
const AGENT: AgentState[] = ["pending_onchain", "active", "revoked", "failed", "quarantined"];

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
    fc.assert(
      fc.property(fc.constantFrom(...PROP), (s) => {
        expect(isValidProposalTransition(s, s)).toBe(false);
      }),
    );
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
      fc.property(
        fc.constantFrom("completed" as const, "failed" as const),
        fc.constantFrom(...EXEC),
        (from, to) => {
          expect(isValidExecutionTransition(from, to)).toBe(false);
        },
      ),
    );
  });
});

describe("§8.4 agent registration", () => {
  it("pending_onchain → active | failed", () => {
    expect(isValidAgentTransition("pending_onchain", "active")).toBe(true);
    expect(isValidAgentTransition("pending_onchain", "failed")).toBe(true);
  });
  it("active → revoked | quarantined (kill-switch, 1b.3)", () => {
    expect(isValidAgentTransition("active", "revoked")).toBe(true);
    expect(isValidAgentTransition("active", "quarantined")).toBe(true);
    expect(isValidAgentTransition("active", "failed")).toBe(false);
  });
  it("quarantined → active (recover) | revoked; not a sink", () => {
    expect(isValidAgentTransition("quarantined", "active")).toBe(true);
    expect(isValidAgentTransition("quarantined", "revoked")).toBe(true);
    expect(isValidAgentTransition("quarantined", "failed")).toBe(false);
  });
  it("property: terminal states are sinks", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("revoked" as const, "failed" as const),
        fc.constantFrom(...AGENT),
        (from, to) => {
          expect(isValidAgentTransition(from, to)).toBe(false);
        },
      ),
    );
  });
});

describe("assert* helpers throw on invalid transitions", () => {
  it("assertProposalTransition does not throw on valid transition", () => {
    expect(() => assertProposalTransition("pending", "approved")).not.toThrow();
  });
  it("assertProposalTransition throws on invalid transition", () => {
    expect(() => assertProposalTransition("rejected", "approved")).toThrow();
  });
  it("assertExecutionTransition does not throw on valid transition", () => {
    expect(() => assertExecutionTransition("dispatched", "in_flight")).not.toThrow();
  });
  it("assertExecutionTransition throws on invalid transition", () => {
    expect(() => assertExecutionTransition("completed", "in_flight")).toThrow();
  });
  it("assertAgentTransition does not throw on valid transition", () => {
    expect(() => assertAgentTransition("pending_onchain", "active")).not.toThrow();
  });
  it("assertAgentTransition throws on invalid transition", () => {
    expect(() => assertAgentTransition("revoked", "active")).toThrow();
  });
});
