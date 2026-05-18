/**
 * Parses the wire error envelope into a typed `BrainError` subclass.
 *
 * Envelope shape (per https://docs.brain.fi/api-reference/overview and
 * `Brain_API_Specification.yaml` v0.3 `Error` schema):
 *
 *     { error: { code, message, details?, trace_id, docs_url } }
 *
 * @packageDocumentation
 */

import { BRAIN_ERROR_CLASS_BY_CODE, BrainError, type BrainErrorOptions } from "./BrainError.js";
import { isBrainErrorCode, type BrainErrorCode } from "./codes.js";

/** The canonical wire envelope. */
export interface BrainErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly trace_id?: string;
    readonly docs_url?: string;
  };
}

/**
 * Type guard: returns true when `body` looks like a Brain error envelope.
 * Permissive on the optional fields; strict on `error.code` and
 * `error.message` (both required by the §4.1 schema).
 */
export function isBrainErrorEnvelope(body: unknown): body is BrainErrorEnvelope {
  if (body === null || typeof body !== "object") return false;
  const err = (body as { error?: unknown }).error;
  if (err === null || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  return typeof e["code"] === "string" && typeof e["message"] === "string";
}

/**
 * Build a typed `BrainError` from a parsed error envelope.
 *
 * If the code is registered, returns the matching subclass instance.
 * If the code is unknown to this SDK build (e.g. the server is ahead
 * of the client), returns the base `BrainError` with the code preserved
 * verbatim — callers can still match on `err.code` even when the typed
 * class doesn't exist locally.
 */
export function brainErrorFromEnvelope(
  envelope: BrainErrorEnvelope,
  statusCode?: number,
): BrainError {
  const { code, message, details, trace_id, docs_url } = envelope.error;
  const opts: BrainErrorOptions = {
    ...(details !== undefined ? { details } : {}),
    ...(trace_id !== undefined ? { traceId: trace_id } : {}),
    ...(docs_url !== undefined ? { docsUrl: docs_url } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
  };

  if (isBrainErrorCode(code)) {
    const Cls = (
      BRAIN_ERROR_CLASS_BY_CODE as Record<
        string,
        new (m: string, o?: BrainErrorOptions) => BrainError
      >
    )[code];
    if (Cls !== undefined) return new Cls(message, opts);
    // Code is in the registry but has no typed subclass (v0.1/v0.2 legacy
    // codes). Fall through to the base BrainError.
    return new BrainError(code, message, opts);
  }

  // Server emitted a code this SDK build doesn't know yet. Forward it as
  // a base BrainError with the code intact, cast to the union to keep
  // the type contract honest at the call site.
  return new BrainError(code as BrainErrorCode, message, opts);
}
