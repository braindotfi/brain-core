import { describe, expect, it } from "vitest";
import { isBrainError } from "../errors.js";
import {
  DeterministicEmbeddingAdapter,
  RecordedEmbeddingAdapter,
  RecordedLlmAdapter,
  embeddingKey,
  llmKey,
} from "./recorded.js";

describe("llmKey / embeddingKey", () => {
  it("are deterministic for the same inputs", () => {
    const a = llmKey({ model: "claude-opus-4-7", messages: [{ role: "user", content: "hi" }] });
    const b = llmKey({ model: "claude-opus-4-7", messages: [{ role: "user", content: "hi" }] });
    expect(a).toBe(b);
    expect(embeddingKey("hi", "m")).toBe(embeddingKey("hi", "m"));
  });
  it("change when inputs change", () => {
    const a = llmKey({ model: "claude-opus-4-7", messages: [{ role: "user", content: "hi" }] });
    const b = llmKey({ model: "claude-opus-4-7", messages: [{ role: "user", content: "hi!" }] });
    expect(a).not.toBe(b);
    expect(embeddingKey("hi", "m")).not.toBe(embeddingKey("hi", "n"));
  });
});

describe("RecordedLlmAdapter", () => {
  it("returns the recorded completion on key hit", async () => {
    const adapter = new RecordedLlmAdapter([
      {
        key: llmKey({ model: "m", messages: [{ role: "user", content: "q" }] }),
        response: {
          text: "answer",
          usage: { inputTokens: 1, outputTokens: 2 },
          model: "m",
          finishReason: "end_turn",
        },
      },
    ]);
    const res = await adapter.complete({ model: "m", messages: [{ role: "user", content: "q" }] });
    expect(res.text).toBe("answer");
    expect(res.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });

  it("throws on miss (no silent re-record)", async () => {
    const adapter = new RecordedLlmAdapter([]);
    try {
      await adapter.complete({ model: "m", messages: [{ role: "user", content: "q" }] });
      expect.fail();
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
    }
  });
});

describe("RecordedEmbeddingAdapter", () => {
  it("returns the recorded vector on key hit", async () => {
    const v = new Array(1536).fill(0);
    v[0] = 1;
    const adapter = new RecordedEmbeddingAdapter([
      { key: embeddingKey("q"), result: { vector: v, model: "m", usage: { inputTokens: 1 } } },
    ]);
    const out = await adapter.embed("q");
    expect(out.vector[0]).toBe(1);
  });
  it("throws on miss", async () => {
    try {
      await new RecordedEmbeddingAdapter([]).embed("q");
      expect.fail();
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
    }
  });
});

describe("DeterministicEmbeddingAdapter", () => {
  it("produces stable vectors for the same input", async () => {
    const a = await new DeterministicEmbeddingAdapter(16).embed("hello");
    const b = await new DeterministicEmbeddingAdapter(16).embed("hello");
    expect(a.vector).toEqual(b.vector);
    expect(a.vector).toHaveLength(16);
  });
  it("different inputs produce different vectors", async () => {
    const a = await new DeterministicEmbeddingAdapter(16).embed("a");
    const b = await new DeterministicEmbeddingAdapter(16).embed("b");
    expect(a.vector).not.toEqual(b.vector);
  });
});
