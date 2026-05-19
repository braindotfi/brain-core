/**
 * Brain metrics emitter.
 *
 * §6.2: Datadog custom metrics. RED metrics (Rate/Errors/Duration) emitted per
 * endpoint by the API gateway. Service-specific metrics per `services/*\/metrics.ts`.
 *
 * Required MVP metrics (§6.2):
 *   brain.api.request.count          (tags: endpoint, status_code, tenant_id)
 *   brain.api.request.duration       (same tags)
 *   brain.wiki.question.latency      (tags: model, query_count)
 *   brain.wiki.question.cost         (LLM token cost per question)
 *   brain.policy.evaluation.duration (tags: decision)
 *   brain.execution.proposal.count   (tags: status, agent_type, rail)
 *   brain.audit.anchor.lag           (time since last anchor publication)
 *
 * Service-specific metrics are defined where they're emitted, not here. This
 * module gives them a consistent tagging and prefix surface.
 */

import { StatsD } from "hot-shots";

export interface MetricTags {
  readonly [key: string]: string | number | boolean | undefined;
}

export interface MetricsEmitter {
  increment(name: string, tags?: MetricTags, value?: number): void;
  gauge(name: string, value: number, tags?: MetricTags): void;
  histogram(name: string, value: number, tags?: MetricTags): void;
  /** Convenience for durations in ms — routed to histogram so Datadog gets p50/p95/p99. */
  duration(name: string, ms: number, tags?: MetricTags): void;
  /** Flush pending UDP buffer (shutdown path). */
  close(): Promise<void>;
}

export interface CreateMetricsOptions {
  host: string;
  port: number;
  prefix: string;
  /** Merged into every metric's tag set. */
  globalTags?: MetricTags;
  /** If true, samples are dropped on the floor — for unit tests. */
  mock?: boolean;
}

/**
 * Construct a DogStatsD-backed emitter. When `mock` is true (unit tests), the
 * emitter is a no-op that still records calls for assertion via `getRecorded`
 * on the returned instance.
 */
export function createMetrics(opts: CreateMetricsOptions): MetricsEmitter {
  if (opts.mock === true) {
    return new MockMetrics();
  }
  const globalTags = tagObjectToArray(opts.globalTags);
  const statsd = new StatsD({
    host: opts.host,
    port: opts.port,
    prefix: opts.prefix.endsWith(".") ? opts.prefix : `${opts.prefix}.`,
    errorHandler: (err) => {
      // §6.1: emit a stderr line rather than throwing — metrics emission must
      // never fail a request path.

      console.warn(`[metrics] emission error: ${err.message}`);
    },
    ...(globalTags !== undefined ? { globalTags } : {}),
  });
  return new StatsdMetrics(statsd);
}

/** Convert { k: v } → ["k:v", ...] as DogStatsD expects. */
function tagObjectToArray(tags?: MetricTags): string[] | undefined {
  if (tags === undefined) return undefined;
  const out: string[] = [];
  for (const [k, v] of Object.entries(tags)) {
    if (v === undefined) continue;
    out.push(`${k}:${String(v)}`);
  }
  return out.length > 0 ? out : undefined;
}

class StatsdMetrics implements MetricsEmitter {
  public constructor(private readonly client: StatsD) {}

  public increment(name: string, tags?: MetricTags, value: number = 1): void {
    this.client.increment(name, value, tagObjectToArray(tags));
  }

  public gauge(name: string, value: number, tags?: MetricTags): void {
    this.client.gauge(name, value, tagObjectToArray(tags));
  }

  public histogram(name: string, value: number, tags?: MetricTags): void {
    this.client.histogram(name, value, tagObjectToArray(tags));
  }

  public duration(name: string, ms: number, tags?: MetricTags): void {
    this.client.histogram(name, ms, tagObjectToArray(tags));
  }

  public async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.client.close(() => resolve());
    });
  }
}

/** Unit-test emitter. Captures calls for assertion and never touches the network. */
export class MockMetrics implements MetricsEmitter {
  public readonly calls: Array<{
    kind: "increment" | "gauge" | "histogram" | "duration";
    name: string;
    value: number;
    tags: MetricTags | undefined;
  }> = [];

  public increment(name: string, tags?: MetricTags, value: number = 1): void {
    this.calls.push({ kind: "increment", name, value, tags });
  }
  public gauge(name: string, value: number, tags?: MetricTags): void {
    this.calls.push({ kind: "gauge", name, value, tags });
  }
  public histogram(name: string, value: number, tags?: MetricTags): void {
    this.calls.push({ kind: "histogram", name, value, tags });
  }
  public duration(name: string, ms: number, tags?: MetricTags): void {
    this.calls.push({ kind: "duration", name, value: ms, tags });
  }
  public async close(): Promise<void> {}
}
