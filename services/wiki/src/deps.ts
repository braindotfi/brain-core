import type {
  AuditEmitter,
  EmbeddingAdapter,
  LlmAdapter,
  MetricsEmitter,
  SlidingWindowRateLimiter,
} from "@brain/shared";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { SchemaRegistry } from "./schemas.js";
import type { AgentReader, PolicyReader } from "./pages/types.js";

export interface WikiDeps {
  pool: Pool;
  redis: Redis;
  audit: AuditEmitter;
  llm: LlmAdapter;
  embed: EmbeddingAdapter;
  schemas: SchemaRegistry;
  metrics: MetricsEmitter;
  /** Default model for /wiki/question. Env-driven in prod. */
  questionModel: string;
  /**
   * P0.3: per-(tenant, principal) limiter for /wiki/annotate. Optional —
   * when absent the route builds a Redis-backed default (60/hour) from
   * `deps.redis`.
   */
  annotationRateLimiter?: SlidingWindowRateLimiter;
  /** Read ports for the policy/agent page generators (cross-service state). */
  policyReader?: PolicyReader;
  agentReader?: AgentReader;
}
