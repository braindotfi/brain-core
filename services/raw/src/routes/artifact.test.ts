import { describe, expect, it } from "vitest";
import { isBrainError } from "@brain/shared";
import { newRawArtifactId } from "@brain/shared";

// A narrow unit test covering the id-shape assertions the route layer makes.
// Full integration tests (live DB) live in raw.integration.test.ts.

describe("raw_id path-param validation", () => {
  it("a well-formed raw id passes the shape check used by the route", async () => {
    const { isBrainId } = await import("@brain/shared");
    expect(isBrainId(newRawArtifactId(), "raw")).toBe(true);
  });

  it("a malformed id fails", async () => {
    const { isBrainId } = await import("@brain/shared");
    expect(isBrainId("random-uuid", "raw")).toBe(false);
  });
});

// Smoke: the error factory surfaces the right code when a caller sends a bad id.
describe("bad path-param error code", () => {
  it("produces request_params_invalid", async () => {
    const { brainError } = await import("@brain/shared");
    const err = brainError("request_params_invalid", "malformed raw_id");
    expect(isBrainError(err)).toBe(true);
    expect(err.code).toBe("request_params_invalid");
    expect(err.statusCode).toBe(400);
  });
});
