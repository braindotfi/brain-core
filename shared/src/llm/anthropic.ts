/**
 * Anthropic (Claude) LLM adapter.
 *
 * Thin wrapper around @anthropic-ai/sdk that implements LlmAdapter. The
 * caller supplies the model id explicitly — we don't hardcode specific
 * versions here so the MVP knobs live in config rather than code.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AuditEmitter } from "../audit/emitter.js";
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
    const system = opts.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const nonSystem = opts.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const abort = new AbortController();
    const timeoutHandle =
      opts.timeoutMs !== undefined ? setTimeout(() => abort.abort(), opts.timeoutMs) : null;

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

export interface RoboAnthropicAdapterOptions extends AnthropicAdapterOptions {
  readonly audit?: AuditEmitter;
  readonly tenantId?: string;
  readonly actor?: string;
}

export class RoboAnthropicAdapter implements LlmAdapter {
  public static readonly complexModel = "claude-opus-4-5";
  public static readonly simpleModel = "claude-sonnet-4";
  private readonly delegate: AnthropicAdapter;

  public constructor(private readonly opts: RoboAnthropicAdapterOptions) {
    this.delegate = new AnthropicAdapter(opts);
  }

  public async complete(opts: LlmCompletionOptions): Promise<LlmCompletion> {
    const model = opts.model === "auto" ? this.modelFor(opts) : opts.model;
    const started = Date.now();
    const result = await this.delegate.complete({ ...opts, model });
    if (this.opts.audit !== undefined && this.opts.tenantId !== undefined) {
      await this.opts.audit.emit({
        tenantId: this.opts.tenantId,
        layer: "wiki",
        actor: this.opts.actor ?? "system_robo",
        action: "robo.llm.usage",
        inputs: { provider: "anthropic", model: result.model },
        outputs: {
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
          latency_ms: Date.now() - started,
        },
        outcome: "allow",
      });
    }
    return result;
  }

  private modelFor(opts: LlmCompletionOptions): string {
    const contentLength = opts.messages.reduce((sum, message) => sum + message.content.length, 0);
    if (opts.jsonSchema !== undefined || contentLength > 4000 || (opts.maxTokens ?? 0) > 2048) {
      return RoboAnthropicAdapter.complexModel;
    }
    return RoboAnthropicAdapter.simpleModel;
  }
}
