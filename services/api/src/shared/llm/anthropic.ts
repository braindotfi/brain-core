/**
 * Anthropic (Claude) LLM adapter.
 *
 * Thin wrapper around @anthropic-ai/sdk that implements LlmAdapter. The
 * caller supplies the model id explicitly — we don't hardcode specific
 * versions here so the MVP knobs live in config rather than code.
 */

import Anthropic from "@anthropic-ai/sdk";
import { brainError } from "../errors.js";
import type { LlmAdapter, LlmCompletion, LlmCompletionOptions } from "./types.js";

export interface AnthropicAdapterOptions {
  apiKey: string;
  baseURL?: string;
}

export class AnthropicAdapter implements LlmAdapter {
  private readonly client: Anthropic;

  public constructor(opts: AnthropicAdapterOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    });
  }

  public async complete(opts: LlmCompletionOptions): Promise<LlmCompletion> {
    const system = opts.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const nonSystem = opts.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const abort = new AbortController();
    const timeoutHandle =
      opts.timeoutMs !== undefined
        ? setTimeout(() => abort.abort(), opts.timeoutMs)
        : null;

    try {
      const res = await this.client.messages.create(
        {
          model: opts.model,
          max_tokens: opts.maxTokens ?? 1024,
          ...(system !== "" ? { system } : {}),
          messages: nonSystem,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        },
        { signal: abort.signal },
      );

      const text = res.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .filter((s) => s !== "")
        .join("");
      return {
        text,
        usage: {
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
        },
        model: res.model,
        finishReason: res.stop_reason ?? "end_turn",
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
