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

export interface ManagedWorker {
  /** Cancel future cycles immediately. Does NOT await an in-flight cycle. */
  stop(): void;
  /**
   * Cancel future cycles and await an in-flight cycle, up to `timeoutMs`.
   * Resolves once the cycle finishes or the timeout elapses, whichever is first.
   * Idempotent: repeated calls return the same drain promise.
   */
  stopAndDrain(timeoutMs: number): Promise<void>;
}

export interface ManagedIntervalOptions {
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

  let drained: Promise<void> | null = null;
  return {
    stop(): void {
      active = false;
      clearInterval(handle);
    },
    stopAndDrain(timeoutMs: number): Promise<void> {
      active = false;
      clearInterval(handle);
      if (drained !== null) return drained;
      const current = inFlight;
      if (current === null) {
        drained = Promise.resolve();
        return drained;
      }
      const timeout = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        // Do not keep the process alive solely for the drain timeout.
        if (typeof (t as { unref?: () => void }).unref === "function") {
          (t as { unref: () => void }).unref();
        }
      });
      drained = Promise.race([current, timeout]);
      return drained;
    },
  };
}
