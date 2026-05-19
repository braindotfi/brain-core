/**
 * Brain LLM adapter interface.
 *
 * §2 stack: Claude via @anthropic-ai/sdk (primary) + OpenAI (fallback +
 * embeddings). §9 retry policy: 2 retries with model swap on the second
 * attempt; per-tenant daily cap enforced above this layer.
 *
 * The adapter deliberately does NOT manage cost accounting — that lives
 * in the `/wiki/question` route via the §6.2 brain.wiki.question.cost
 * metric.
 */

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCompletionOptions {
  model: string;
  messages: ReadonlyArray<LlmMessage>;
  maxTokens?: number;
  temperature?: number;
  /** Request structured JSON output. Provider may embed a tool-use scaffold. */
  jsonSchema?: Record<string, unknown>;
  /** Hard deadline. Underlying client is cancelled. */
  timeoutMs?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmCompletion {
  text: string;
  usage: LlmUsage;
  model: string;
  finishReason: string;
}

export interface LlmAdapter {
  complete(opts: LlmCompletionOptions): Promise<LlmCompletion>;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export interface EmbeddingResult {
  vector: number[];
  model: string;
  usage: { inputTokens: number };
}

export interface EmbeddingAdapter {
  embed(input: string, model?: string): Promise<EmbeddingResult>;
  readonly defaultDimension: number;
}
