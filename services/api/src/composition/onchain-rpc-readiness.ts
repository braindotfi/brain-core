/**
 * Runtime readiness for Base RPC dependencies.
 *
 * A verified wrong chain or contract is a deployment safety failure and must
 * stop boot. A provider transport failure is different: HTTP services can
 * continue serving Ledger, Wiki, auth, and ingestion while chain work pauses.
 */

import type { MetricsEmitter } from "@brain/shared";

export type OnchainRpcStatus = "ready" | "degraded";

export interface OnchainRpcSnapshot {
  readonly status: OnchainRpcStatus;
  readonly endpoint: string | undefined;
  readonly lastValidatedAt: string | undefined;
  readonly reason: "rpc_unavailable" | undefined;
}

interface Logger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

export interface OnchainRpcReadinessOptions {
  readonly endpoints: readonly string[];
  /** Performs all chain and deployed-contract safety validation for one endpoint. */
  readonly validate: (endpoint: string) => Promise<void>;
  readonly retryInitialMs?: number;
  readonly retryMaxMs?: number;
  readonly metrics: MetricsEmitter;
  readonly log: Logger;
}

/**
 * Restrict degraded startup to provider or transport failures. Contract and
 * chain assertions deliberately use ordinary Errors, so they remain fatal.
 */
export function isTransientRpcUnavailable(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /no backend is currently healthy|rpc request failed|fetch failed|network error|network request failed|\btimeout\b|\betimedout\b|\beconnrefused\b|\beconnreset\b|\benotfound\b|\b5\d\d\b|\b429\b/i.test(
    text,
  );
}

export class OnchainRpcReadiness {
  private readonly endpoints: readonly string[];
  private readonly validate: (endpoint: string) => Promise<void>;
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;
  private readonly metrics: MetricsEmitter;
  private readonly log: Logger;
  private status: OnchainRpcStatus = "degraded";
  private endpoint: string | undefined;
  private lastValidatedAt: string | undefined;
  private retryAttempt = 0;
  private retryTimer: NodeJS.Timeout | undefined;

  public constructor(options: OnchainRpcReadinessOptions) {
    this.endpoints = [...new Set(options.endpoints.filter((endpoint) => endpoint !== ""))];
    this.validate = options.validate;
    this.retryInitialMs = options.retryInitialMs ?? 5_000;
    this.retryMaxMs = options.retryMaxMs ?? 300_000;
    this.metrics = options.metrics;
    this.log = options.log;
  }

  public snapshot(): OnchainRpcSnapshot {
    return {
      status: this.status,
      endpoint: this.endpoint,
      lastValidatedAt: this.lastValidatedAt,
      reason: this.status === "degraded" ? "rpc_unavailable" : undefined,
    };
  }

  public isReady(): boolean {
    return this.status === "ready";
  }

  /** Validates each configured endpoint in order. Safety failures are fatal. */
  public async validateNow(): Promise<boolean> {
    if (this.endpoints.length === 0) {
      this.markDegraded(new Error("no Base RPC endpoints configured"));
      return false;
    }

    let unavailable: unknown;
    for (const endpoint of this.endpoints) {
      try {
        await this.validate(endpoint);
        this.status = "ready";
        this.endpoint = endpoint;
        this.lastValidatedAt = new Date().toISOString();
        this.retryAttempt = 0;
        this.metrics.gauge("brain.onchain.rpc.available", 1);
        this.log.info({ endpoint }, "Base RPC validation succeeded");
        return true;
      } catch (error) {
        if (!isTransientRpcUnavailable(error)) throw error;
        unavailable = error;
        this.log.warn({ endpoint, err: error }, "Base RPC endpoint unavailable");
      }
    }

    this.markDegraded(unavailable ?? new Error("no Base RPC endpoint responded"));
    return false;
  }

  /** Starts bounded exponential retry only while the chain dependency is degraded. */
  public startRetry(): void {
    if (this.status === "ready" || this.retryTimer !== undefined) return;
    const delayMs = Math.min(this.retryInitialMs * 2 ** this.retryAttempt, this.retryMaxMs);
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.retry();
    }, delayMs);
    this.retryTimer.unref();
    this.log.warn({ delayMs, retryAttempt: this.retryAttempt }, "Base RPC retry scheduled");
  }

  public stop(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private async retry(): Promise<void> {
    try {
      const ready = await this.validateNow();
      if (!ready) this.startRetry();
    } catch (error) {
      // Safety violations discovered after degraded boot are logged loudly. A
      // live process is not terminated from a timer, but chain work stays off.
      this.markDegraded(error);
      this.log.warn({ err: error }, "Base RPC retry found a chain safety failure");
      this.startRetry();
    }
  }

  private markDegraded(error: unknown): void {
    this.status = "degraded";
    this.endpoint = undefined;
    this.metrics.gauge("brain.onchain.rpc.available", 0);
    this.log.warn({ err: error }, "Base RPC unavailable; chain work is degraded");
  }
}
