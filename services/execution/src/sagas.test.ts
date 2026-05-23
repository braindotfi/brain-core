import { describe, expect, it } from "vitest";
import { InMemoryAuditEmitter, type ServiceCallContext } from "@brain/shared";
import { runSaga, type SagaStep } from "./sagas.js";

const CTX: ServiceCallContext = { tenantId: "tnt_acme", actor: "agent_payment" };

function step(
  name: string,
  log: string[],
  opts: { failForward?: boolean; failComp?: boolean } = {},
): SagaStep {
  return {
    name,
    forward: async () => {
      if (opts.failForward) throw new Error(`${name} forward failed`);
      log.push(`forward-${name}`);
      return { name };
    },
    compensate: async () => {
      if (opts.failComp) throw new Error(`${name} compensate failed`);
      log.push(`compensate-${name}`);
    },
  };
}

describe("runSaga", () => {
  it("runs all steps forward on success, no compensation", async () => {
    const log: string[] = [];
    const audit = new InMemoryAuditEmitter();
    const result = await runSaga({ ctx: CTX, audit }, "agsg_1", [step("a", log), step("b", log)]);
    expect(result.ok).toBe(true);
    expect(log).toEqual(["forward-a", "forward-b"]);
    expect(audit.events.at(-1)?.action).toBe("agent.saga.completed");
  });

  it("compensates completed steps in reverse on failure", async () => {
    const log: string[] = [];
    const audit = new InMemoryAuditEmitter();
    const result = await runSaga({ ctx: CTX, audit }, "agsg_2", [
      step("a", log),
      step("b", log),
      step("c", log, { failForward: true }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("c");
    expect(result.compensated).toEqual(["b", "a"]); // reverse order
    expect(log).toEqual(["forward-a", "forward-b", "compensate-b", "compensate-a"]);
    const actions = audit.events.map((e) => e.action);
    expect(actions.filter((a) => a === "agent.saga.compensated")).toHaveLength(2);
    expect(actions.at(-1)).toBe("agent.saga.failed");
  });

  it("records compensation failures for manual intervention", async () => {
    const log: string[] = [];
    const audit = new InMemoryAuditEmitter();
    const result = await runSaga({ ctx: CTX, audit }, "agsg_3", [
      step("a", log, { failComp: true }),
      step("b", log, { failForward: true }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.compensationFailures).toEqual(["a"]);
    expect(audit.events.map((e) => e.action)).toContain("agent.saga.compensation_failed");
  });
});
