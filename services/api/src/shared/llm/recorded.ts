/**
 * Recorded-prompt LLM + embedding adapters.
 *
 * §7.2: /wiki/question is tested via a recorded-prompt harness — canonical
 * question + frozen Wiki state + recorded LLM response + assertion on
 * structured output. Changes to an LLM's behavior require updating the
 * recording with explicit PR review.
 *
 * The recording is keyed by a deterministic hash of (model, messages,
 * maxTokens, temperature, jsonSchema). On miss, the adapter throws so
 * tests fail loudly — no accidental silent re-recording.
 */

import { createHash } from "node:crypto";
import { brainError } from "../errors.js";
import type {
  EmbeddingAdapter,
  EmbeddingResult,
  LlmAdapter,
  LlmCompletion,
  LlmCompletionOptions,
} from "./types.js";

export interface LlmRecording {
  key: string;
  response: LlmCompletion;
}

export interface EmbeddingRecording {
  key: string;
  result: EmbeddingResult;
}

export class RecordedLlmAdapter implements LlmAdapter {
  private readonly byKey = new Map<string, LlmCompletion>();
  public constructor(recordings: ReadonlyArray<LlmRecording>) {
    for (const r of recordings) this.byKey.set(r.key, r.response);
  }

  public async complete(opts: LlmCompletionOptions): Promise<LlmCompletion> {
    const key = llmKey(opts);
    const hit = this.byKey.get(key);
    if (hit === undefined) {
      throw brainError(
        "dependency_unavailable",
        `no recorded LLM response for key ${key.slice(0, 12)}…`,
        { details: { key } },
      );
    }
    return hit;
  }
}

export class RecordedEmbeddingAdapter implements EmbeddingAdapter {
  public readonly defaultDimension: number;
  private readonly byKey = new Map<string, EmbeddingResult>();

  public constructor(recordings: ReadonlyArray<EmbeddingRecording>, dimension = 1536) {
    this.defaultDimension = dimension;
    for (const r of recordings) this.byKey.set(r.key, r.result);
  }

  public async embed(input: string, model?: string): Promise<EmbeddingResult> {
    const key = embeddingKey(input, model);
    const hit = this.byKey.get(key);
    if (hit === undefined) {
      throw brainError("dependency_unavailable", `no recorded embedding for key ${key.slice(0, 12)}…`, {
        details: { key },
      });
    }
    return hit;
  }
}

/**
 * A DETERMINISTIC embedding generator for non-LLM tests that need vectors
 * but don't care about semantic quality. Hashes the input into a stable
 * float vector so equality checks work.
 */
export class DeterministicEmbeddingAdapter implements EmbeddingAdapter {
  public readonly defaultDimension: number;
  public constructor(dimension = 1536) {
    this.defaultDimension = dimension;
  }
  public async embed(input: string, model = "deterministic-test"): Promise<EmbeddingResult> {
    const seed = createHash("sha256").update(input).digest();
    const v: number[] = new Array(this.defaultDimension);
    for (let i = 0; i < this.defaultDimension; i += 1) {
      v[i] = (seed[i % seed.length]! / 255) * 2 - 1;
    }
    return { vector: v, model, usage: { inputTokens: 0 } };
  }
}

export function llmKey(opts: LlmCompletionOptions): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        maxTokens: opts.maxTokens ?? null,
        temperature: opts.temperature ?? null,
        jsonSchema: opts.jsonSchema ?? null,
      }),
    )
    .digest("hex");
}

export function embeddingKey(input: string, model?: string): string {
  return createHash("sha256").update(JSON.stringify({ input, model: model ?? null })).digest("hex");
}
