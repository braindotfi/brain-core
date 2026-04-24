import type {
  AuditEmitter,
  EmbeddingAdapter,
  LlmAdapter,
  MetricsEmitter,
} from "@brain/api/shared";
import type { Pool } from "pg";
import type Redis from "ioredis";
import type { SchemaRegistry } from "./schemas.js";

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
}
