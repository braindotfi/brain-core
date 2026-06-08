/**
 * A managed periodic worker: a cycle on a fixed interval with a graceful,
 * drainable shutdown. (Codex c96283d P2.)
 *
 * `stop()` cancels future cycles immediately. `stopAndDrain(timeoutMs)` also
 * AWAITS an in-flight cycle (bounded by the timeout), so a caller such as
 * process shutdown can close DB pools only AFTER active work has finished, not
 * underneath it. Cycles never overlap: a tick is skipped while the previous
 * cycle is still running.
 */

/**
 * Outcome of `stopAndDrain`: whether the in-flight cycle finished within the
 * grace window (`drained`) or was still running when the timeout elapsed
 * (`timed_out`). Shutdown uses this to decide whether the process exited cleanly,
 * since a `timed_out` worker means a pool may close under active work.
 */
export type DrainResult = { status: "drained" } | { status: "timed_out"; worker: string };

export interface ManagedWorker {
  /** Stable name, surfaced in `DrainResult` on a drain timeout. */
  readonly name: string;
  /** Cancel future cycles immediately. Does NOT await an in-flight cycle. */
  stop(): void;
  /**
   * Cancel future cycles and await an in-flight cycle, up to `timeoutMs`.
   * Resolves `drained` once the cycle finishes, or `timed_out` if the timeout
   * elapses first. Idempotent: repeated calls return the same drain promise.
   */
  stopAndDrain(timeoutMs: number): Promise<DrainResult>;
}

export interface ManagedIntervalOptions {
  /** Stable worker name, surfaced in `DrainResult` on a drain timeout. */
  name?: string;
  /** Run a cycle immediately on start (default false, matching `setInterval`). */
  runImmediately?: boolean;
  /** Receives any error a cycle throws; the loop itself never rejects. */
  onError?: (err: unknown) => void;
}

export function startManagedInterval(
  cycle: () => Promise<void>,
  intervalMs: number,
  opts: ManagedIntervalOptions = {},
): ManagedWorker {
  const name = opts.name ?? "managed-worker";
  let active = true;
  let inFlight: Promise<void> | null = null;

  const run = (): void => {
    if (!active || inFlight !== null) return; // no overlap with an in-flight cycle
    inFlight = (async () => {
      try {
        await cycle();
      } catch (err) {
        opts.onError?.(err);
      }
    })().finally(() => {
      inFlight = null;
    });
  };

  const handle = setInterval(run, intervalMs);
  if (opts.runImmediately === true) run();

  let drained: Promise<DrainResult> | null = null;
  return {
    name,
    stop(): void {
      active = false;
      clearInterval(handle);
    },
    stopAndDrain(timeoutMs: number): Promise<DrainResult> {
      active = false;
      clearInterval(handle);
      if (drained !== null) return drained;
      const current = inFlight;
      if (current === null) {
        drained = Promise.resolve({ status: "drained" });
        return drained;
      }
      drained = (async (): Promise<DrainResult> => {
        const TIMED_OUT = Symbol("timed_out");
        const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
          const t = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
          // Do not keep the process alive solely for the drain timeout.
          if (typeof (t as { unref?: () => void }).unref === "function") {
            (t as { unref: () => void }).unref();
          }
        });
        const winner = await Promise.race([current.then(() => "drained" as const), timeout]);
        return winner === TIMED_OUT ? { status: "timed_out", worker: name } : { status: "drained" };
      })();
      return drained;
    },
  };
}
