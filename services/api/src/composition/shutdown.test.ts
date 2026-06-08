import { describe, expect, it, vi } from "vitest";
import type { DrainResult, ManagedWorker } from "@brain/shared";
import { runShutdown, type ShutdownDeps } from "./shutdown.js";

function fakeWorker(name: string, result: DrainResult): ManagedWorker {
  return {
    name,
    stop: vi.fn(),
    stopAndDrain: vi.fn(async () => result),
  };
}

function baseDeps(over: Partial<ShutdownDeps> = {}): ShutdownDeps {
  return {
    workers: [],
    workerDrainMs: 1000,
    closeApp: vi.fn(async () => undefined),
    closeAgentRouteWorker: vi.fn(async () => undefined),
    closePools: vi.fn(async () => ({ errors: [] })),
    disconnectRedis: vi.fn(),
    shutdownTracing: vi.fn(async () => undefined),
    log: { info: vi.fn(), error: vi.fn() },
    ...over,
  };
}

describe("runShutdown", () => {
  it("exits clean (0) when every step succeeds and all workers drain", async () => {
    const order: string[] = [];
    const deps = baseDeps({
      workers: [fakeWorker("a", { status: "drained" }), fakeWorker("b", { status: "drained" })],
      closeApp: vi.fn(async () => {
        order.push("app");
      }),
      closePools: vi.fn(async () => {
        order.push("pools");
        return { errors: [] };
      }),
    });
    const outcome = await runShutdown(deps);
    expect(outcome).toEqual({ clean: true, timedOutWorkers: [], exitCode: 0 });
    // App closes before pools (no new HTTP work mid-drain).
    expect(order).toEqual(["app", "pools"]);
  });

  it("marks unclean (exit 1) and names the worker when a drain times out", async () => {
    const metrics = { gauge: vi.fn(), increment: vi.fn(), histogram: vi.fn(), duration: vi.fn() };
    const deps = baseDeps({
      workers: [
        fakeWorker("drained-one", { status: "drained" }),
        fakeWorker("slow-one", { status: "timed_out", worker: "slow-one" }),
      ],
      metrics: metrics as never,
    });
    const outcome = await runShutdown(deps);
    expect(outcome.clean).toBe(false);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.timedOutWorkers).toEqual(["slow-one"]);
    expect(metrics.gauge).toHaveBeenCalledWith("brain.shutdown.worker_drain_timeout.count", 1);
  });

  it("still closes pools/redis after a worker times out", async () => {
    const closePools = vi.fn(async () => ({ errors: [] }));
    const disconnectRedis = vi.fn();
    const deps = baseDeps({
      workers: [fakeWorker("slow", { status: "timed_out", worker: "slow" })],
      closePools,
      disconnectRedis,
    });
    await runShutdown(deps);
    expect(closePools).toHaveBeenCalledOnce();
    expect(disconnectRedis).toHaveBeenCalledOnce();
  });

  it("marks unclean when a pool fails to close", async () => {
    const deps = baseDeps({
      closePools: vi.fn(async () => ({ errors: [new Error("pool boom")] })),
    });
    const outcome = await runShutdown(deps);
    expect(outcome.clean).toBe(false);
    expect(outcome.exitCode).toBe(1);
  });

  it("marks unclean when a worker stopAndDrain rejects", async () => {
    const deps = baseDeps({
      workers: [
        {
          name: "thrower",
          stop: vi.fn(),
          stopAndDrain: vi.fn(async () => Promise.reject(new Error("drain boom"))),
        },
      ],
    });
    const outcome = await runShutdown(deps);
    expect(outcome.clean).toBe(false);
    expect(outcome.exitCode).toBe(1);
  });

  it("marks unclean when app.close throws", async () => {
    const deps = baseDeps({
      closeApp: vi.fn(async () => Promise.reject(new Error("app boom"))),
    });
    const outcome = await runShutdown(deps);
    expect(outcome.clean).toBe(false);
  });
});
