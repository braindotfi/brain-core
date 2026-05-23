/**
 * Agent-to-agent saga executor (Agent Autonomy v3, 3.2).
 *
 * Runs an ordered list of steps forward. If any step throws, the executor runs
 * the compensations of the already-completed steps in REVERSE order, each
 * emitting its own audit event linked back to the saga + the failed step. This
 * gives money-movers that depend on another agent's output (e.g. Payment relying
 * on a Reconciliation match) a clean partial-failure recovery path.
 *
 * The executor is pure orchestration over injected steps + an AuditEmitter, so
 * it is unit-testable without a database; persistence of saga/step rows
 * (agent_action_sagas / agent_saga_steps) is the caller's concern.
 */

import type { AuditEmitter, ServiceCallContext } from "@brain/shared";

export interface SagaStep<T = unknown> {
  readonly name: string;
  /** Forward action; its result is passed to compensate() on rollback. */
  forward(): Promise<T>;
  /** Undo the forward action. Should be idempotent. */
  compensate(forwardResult: T): Promise<void>;
}

export interface SagaResult {
  readonly ok: boolean;
  /** Step names that completed forward, in order. */
  readonly completed: readonly string[];
  /** The step whose forward action threw, if any. */
  readonly failedStep?: string;
  /** Step names compensated, in the reverse order they were applied. */
  readonly compensated: readonly string[];
  /** Step names whose compensation itself threw (manual intervention needed). */
  readonly compensationFailures: readonly string[];
}

export interface SagaDeps {
  readonly ctx: ServiceCallContext;
  readonly audit: AuditEmitter;
}

/**
 * Execute `steps` as a saga. On forward failure, compensate completed steps in
 * reverse; every compensation emits its own audit event.
 */
export async function runSaga(
  deps: SagaDeps,
  sagaId: string,
  steps: ReadonlyArray<SagaStep>,
): Promise<SagaResult> {
  const done: Array<{ step: SagaStep; result: unknown }> = [];

  for (const step of steps) {
    try {
      const result = await step.forward();
      done.push({ step, result });
    } catch (err) {
      const failedStep = step.name;
      const compensated: string[] = [];
      const compensationFailures: string[] = [];
      // Compensate completed steps in reverse order.
      for (let i = done.length - 1; i >= 0; i -= 1) {
        const entry = done[i]!;
        try {
          await entry.step.compensate(entry.result);
          compensated.push(entry.step.name);
          await deps.audit.emit({
            tenantId: deps.ctx.tenantId,
            layer: "agent",
            actor: deps.ctx.actor,
            action: "agent.saga.compensated",
            inputs: { saga_id: sagaId, step: entry.step.name, failed_step: failedStep },
            outputs: { ok: true },
          });
        } catch (compErr) {
          compensationFailures.push(entry.step.name);
          await deps.audit.emit({
            tenantId: deps.ctx.tenantId,
            layer: "agent",
            actor: deps.ctx.actor,
            action: "agent.saga.compensation_failed",
            inputs: { saga_id: sagaId, step: entry.step.name, failed_step: failedStep },
            outputs: {
              ok: false,
              error: compErr instanceof Error ? compErr.message : String(compErr),
            },
          });
        }
      }
      await deps.audit.emit({
        tenantId: deps.ctx.tenantId,
        layer: "agent",
        actor: deps.ctx.actor,
        action: "agent.saga.failed",
        inputs: { saga_id: sagaId, failed_step: failedStep },
        outputs: {
          error: err instanceof Error ? err.message : String(err),
          compensated,
          compensation_failures: compensationFailures,
        },
      });
      return {
        ok: false,
        completed: done.map((d) => d.step.name),
        failedStep,
        compensated,
        compensationFailures,
      };
    }
  }

  await deps.audit.emit({
    tenantId: deps.ctx.tenantId,
    layer: "agent",
    actor: deps.ctx.actor,
    action: "agent.saga.completed",
    inputs: { saga_id: sagaId },
    outputs: { steps: steps.length },
  });
  return {
    ok: true,
    completed: done.map((d) => d.step.name),
    compensated: [],
    compensationFailures: [],
  };
}
