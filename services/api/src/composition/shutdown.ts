/**
 * Graceful-shutdown coordinator (Codex fca9ac8 P2 #5).
 *
 * Extracted from main.ts so the ordering and the unclean-exit decision are
 * unit-testable. Drains in order so DB pools never close underneath active work:
 * stop new HTTP -> stopAndDrain workers (bounded) -> BullMQ jobs -> pools ->
 * redis -> tracing. A worker that TIMES OUT (rather than draining) means a pool
 * may have closed under an active cycle, so the shutdown is marked unclean and
 * the process exits non-zero. The idempotency guard (one execution for
 * concurrent SIGINT+SIGTERM) stays in main.ts around this call.
 */

import type { ManagedWorker, MetricsEmitter } from "@brain/shared";

export interface ShutdownLogger {
  info: (ctx: Record<string, unknown>, msg: string) => void;
  error: (ctx: Record<string, unknown>, msg: string) => void;
}

export interface ShutdownDeps {
  workers: ReadonlyArray<ManagedWorker>;
  workerDrainMs: number;
  closeApp: () => Promise<void>;
  closeAgentRouteWorker: () => Promise<void>;
  closePools: () => Promise<{ errors: unknown[] }>;
  disconnectRedis: () => void;
  shutdownTracing: () => Promise<void>;
  log: ShutdownLogger;
  metrics?: MetricsEmitter;
}

export interface ShutdownOutcome {
  clean: boolean;
  timedOutWorkers: string[];
  exitCode: 0 | 1;
}

export async function runShutdown(deps: ShutdownDeps): Promise<ShutdownOutcome> {
  let clean = true;

  // 1. Stop accepting new HTTP work (Fastify drains in-flight requests).
  try {
    await deps.closeApp();
  } catch (err) {
    clean = false;
    deps.log.error({ err }, "app.close failed");
  }

  // 2. Prevent new worker cycles AND await any in-flight cycle (bounded). A
  //    timed-out worker means a pool may close under active work -> unclean.
  const results = await Promise.allSettled(
    deps.workers.map((w) => w.stopAndDrain(deps.workerDrainMs)),
  );
  const timedOutWorkers: string[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value.status === "timed_out") {
        timedOutWorkers.push(r.value.worker);
        clean = false;
      }
    } else {
      clean = false;
      deps.log.error({ err: r.reason }, "worker stopAndDrain failed");
    }
  }
  if (timedOutWorkers.length > 0) {
    deps.metrics?.gauge("brain.shutdown.worker_drain_timeout.count", timedOutWorkers.length);
    deps.log.error({ workers: timedOutWorkers }, "workers did not drain within the grace window");
  }

  // 3. The BullMQ route worker drains its own in-flight jobs.
  try {
    await deps.closeAgentRouteWorker();
  } catch (err) {
    clean = false;
    deps.log.error({ err }, "agentRouteWorker.close failed");
  }

  // 4. Close every distinct pool (one failure never blocks the rest).
  const { errors } = await deps.closePools();
  for (const err of errors) {
    clean = false;
    deps.log.error({ err }, "pool.end failed");
  }

  // 5. Redis.
  try {
    deps.disconnectRedis();
  } catch (err) {
    clean = false;
    deps.log.error({ err }, "redis.disconnect failed");
  }

  // 6. Tracing.
  await deps.shutdownTracing();

  return { clean, timedOutWorkers, exitCode: clean ? 0 : 1 };
}
