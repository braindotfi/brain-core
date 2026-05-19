/**
 * OpenAI adapters.
 *
 * §2 stack positions OpenAI as fallback for completions and primary for
 * embeddings. The completion adapter exists mainly to satisfy §9's
 * "model swap on the second attempt" policy.
 */

import OpenAI from "openai";
import { brainError } from "../errors.js";
import type {
  EmbeddingAdapter,
  EmbeddingResult,
  LlmAdapter,
  LlmCompletion,
  LlmCompletionOptions,
} from "./types.js";

export interface OpenAIAdapterOptions {
  apiKey: string;
  baseURL?: string;
}

export class OpenAICompletionAdapter implements LlmAdapter {
  private readonly client: OpenAI;

  public constructor(opts: OpenAIAdapterOptions) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    });
  }

  public async complete(opts: LlmCompletionOptions): Promise<LlmCompletion> {
    const abort = new AbortController();
    const timeoutHandle =
      opts.timeoutMs !== undefined ? setTimeout(() => abort.abort(), opts.timeoutMs) : null;

    try {
      const res = await this.client.chat.completions.create(
        {
          model: opts.model,
          messages: opts.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        },
        { signal: abort.signal },
      );
      const choice = res.choices[0];
      return {
        text: choice?.message.content ?? "",
        usage: {
          inputTokens: res.usage?.prompt_tokens ?? 0,
          outputTokens: res.usage?.completion_tokens ?? 0,
        },
        model: res.model,
        finishReason: choice?.finish_reason ?? "stop",
      };
    } catch (err) {
      if (abort.signal.aborted) {
        throw brainError("wiki_question_timeout", "LLM call timed out", { cause: err });
      }
      throw brainError("dependency_unavailable", "LLM call failed", { cause: err });
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }
  }
}

export interface OpenAIEmbeddingOptions extends OpenAIAdapterOptions {
  defaultModel?: string;
  /** Must match the vector column dimension in wiki_entities. */
  dimension?: number;
}

export class OpenAIEmbeddingAdapter implements EmbeddingAdapter {
  public readonly defaultDimension: number;
  private readonly defaultModel: string;
  private readonly client: OpenAI;

  public constructor(opts: OpenAIEmbeddingOptions) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    });
    this.defaultModel = opts.defaultModel ?? "text-embedding-3-small";
    this.defaultDimension = opts.dimension ?? 1536;
  }

  public async embed(input: string, model?: string): Promise<EmbeddingResult> {
    try {
      const res = await this.client.embeddings.create({
        model: model ?? this.defaultModel,
        input,
      });
      const vec = res.data[0]?.embedding ?? [];
      return {
        vector: vec,
        model: res.model,
        usage: { inputTokens: res.usage?.prompt_tokens ?? 0 },
      };
    } catch (err) {
      throw brainError("dependency_unavailable", "embedding call failed", { cause: err });
    }
  }
}
