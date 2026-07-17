import { describe, expect, it } from "vitest";
import { isBrainError } from "@brain/shared";
import {
  nextStatus,
  type AgentProposalDecision,
  type AgentProposalExecutionMode,
  type AgentProposalStatus,
} from "./state-machine.js";

const ALL_STATUSES: AgentProposalStatus[] = [
  "needs_review",
  "acknowledged",
  "approved",
  "rejected",
  "undone_to_review",
];
const ALL_DECISIONS: AgentProposalDecision[] = [
  "approved",
  "rejected",
  "acknowledged",
  "undone_to_review",
];
const ALL_MODES: AgentProposalExecutionMode[] = ["propose", "notify_only"];

function expectInvalid(
  current: AgentProposalStatus,
  decision: AgentProposalDecision,
  mode: AgentProposalExecutionMode,
  reversible: boolean,
): void {
  try {
    nextStatus(current, decision, mode, reversible);
    throw new Error(
      `expected nextStatus(${current}, ${decision}, ${mode}, ${reversible}) to throw`,
    );
  } catch (err) {
    expect(isBrainError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("agent_proposal_invalid_state");
  }
}

describe("agent proposal state machine", () => {
  it("needs_review + approved -> approved (propose only)", () => {
    expect(nextStatus("needs_review", "approved", "propose", false)).toBe("approved");
    expectInvalid("needs_review", "approved", "notify_only", false);
  });

  it("needs_review + rejected -> rejected (propose only)", () => {
    expect(nextStatus("needs_review", "rejected", "propose", false)).toBe("rejected");
    expectInvalid("needs_review", "rejected", "notify_only", false);
  });

  it("needs_review + acknowledged -> acknowledged (notify_only only)", () => {
    expect(nextStatus("needs_review", "acknowledged", "notify_only", false)).toBe("acknowledged");
    expectInvalid("needs_review", "acknowledged", "propose", false);
  });

  it("approved + undone_to_review -> undone_to_review (reversible only)", () => {
    expect(nextStatus("approved", "undone_to_review", "propose", true)).toBe("undone_to_review");
    expect(nextStatus("approved", "undone_to_review", "notify_only", true)).toBe(
      "undone_to_review",
    );
    expectInvalid("approved", "undone_to_review", "propose", false);
  });

  it("undone_to_review + approved -> approved", () => {
    expect(nextStatus("undone_to_review", "approved", "propose", true)).toBe("approved");
    expect(nextStatus("undone_to_review", "approved", "propose", false)).toBe("approved");
  });

  it("undone_to_review + rejected -> rejected", () => {
    expect(nextStatus("undone_to_review", "rejected", "propose", true)).toBe("rejected");
    expect(nextStatus("undone_to_review", "rejected", "notify_only", false)).toBe("rejected");
  });

  it("needs_review + undone_to_review is always invalid", () => {
    expectInvalid("needs_review", "undone_to_review", "propose", true);
    expectInvalid("needs_review", "undone_to_review", "notify_only", true);
  });

  it("terminal states (rejected) never transition", () => {
    for (const decision of ALL_DECISIONS) {
      for (const mode of ALL_MODES) {
        for (const reversible of [true, false]) {
          expectInvalid("rejected", decision, mode, reversible);
        }
      }
    }
  });

  it("acknowledged is a terminal sink", () => {
    for (const decision of ALL_DECISIONS) {
      for (const mode of ALL_MODES) {
        for (const reversible of [true, false]) {
          expectInvalid("acknowledged", decision, mode, reversible);
        }
      }
    }
  });

  it(
    "exhaustive: every (status, decision, mode, reversible) combo is either the one" +
      " legal next status or throws agent_proposal_invalid_state",
    () => {
      const legal = new Set([
        "needs_review|approved|propose",
        "needs_review|rejected|propose",
        "needs_review|acknowledged|notify_only",
        "approved|undone_to_review|propose|reversible",
        "approved|undone_to_review|notify_only|reversible",
        "undone_to_review|approved|propose",
        "undone_to_review|approved|notify_only",
        "undone_to_review|rejected|propose",
        "undone_to_review|rejected|notify_only",
      ]);
      for (const current of ALL_STATUSES) {
        for (const decision of ALL_DECISIONS) {
          for (const mode of ALL_MODES) {
            for (const reversible of [true, false]) {
              const key =
                decision === "undone_to_review" && reversible
                  ? `${current}|${decision}|${mode}|reversible`
                  : `${current}|${decision}|${mode}`;
              if (legal.has(key)) {
                expect(nextStatus(current, decision, mode, reversible)).toBeTruthy();
              } else {
                expectInvalid(current, decision, mode, reversible);
              }
            }
          }
        }
      }
    },
  );
});
