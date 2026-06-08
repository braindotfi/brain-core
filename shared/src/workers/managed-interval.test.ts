import { describe, expect, it } from "vitest";
import { startManagedInterval } from "./managed-interval.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("startManagedInterval", () => {
  it("runs a cycle immediately when runImmediately is set", async () => {
    let n = 0;
    const w = startManagedInterval(
      async () => {
        n += 1;
      },
      100_000,
      { runImmediately: true },
    );
    await tick();
    expect(n).toBe(1);
    w.stop();
  });

  it("does not overlap cycles while one is in flight", async () => {
    let starts = 0;
    const d = deferred();
    const w = startManagedInterval(
      async () => {
        starts += 1;
        await d.promise;
      },
      5,
      { runImmediately: true },
    );
    await new Promise((r) => setTimeout(r, 40)); // several interval ticks elapse
    expect(starts).toBe(1); // subsequent ticks skipped while the first is in flight
    d.resolve();
    w.stop();
  });

  it("stopAndDrain awaits the in-flight cycle before resolving", async () => {
    const d = deferred();
    let done = false;
    const w = startManagedInterval(() => d.promise, 100_000, { runImmediately: true });
    const drain = w.stopAndDrain(5_000).then(() => {
      done = true;
    });
    await tick();
    expect(done).toBe(false); // cycle still running, drain still pending
    d.resolve();
    await drain;
    expect(done).toBe(true);
  });

  it("stopAndDrain resolves on the timeout when a cycle hangs", async () => {
    const w = startManagedInterval(() => new Promise<void>(() => {}), 100_000, {
      runImmediately: true,
    });
    // Would hang forever without the bounded timeout.
    await w.stopAndDrain(20);
    expect(true).toBe(true);
  });

  it("stopAndDrain resolves immediately when nothing is in flight", async () => {
    let n = 0;
    const w = startManagedInterval(async () => {
      n += 1;
    }, 100_000); // no immediate run
    await w.stopAndDrain(5_000);
    expect(n).toBe(0);
  });

  it("routes a thrown cycle error to onError without rejecting the loop", async () => {
    const errors: unknown[] = [];
    const w = startManagedInterval(
      async () => {
        throw new Error("boom");
      },
      100_000,
      { runImmediately: true, onError: (e) => errors.push(e) },
    );
    await tick();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
    w.stop();
  });

  it("stop() halts future cycles", async () => {
    let n = 0;
    const w = startManagedInterval(
      async () => {
        n += 1;
      },
      5,
      { runImmediately: true },
    );
    await tick();
    w.stop();
    const after = n;
    await new Promise((r) => setTimeout(r, 30));
    expect(n).toBe(after); // no further cycles after stop
  });
});
