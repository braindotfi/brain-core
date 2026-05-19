import type { components } from "./generated/openapi.js";

export type BrainErrorBody = components["schemas"]["Error"];

export class BrainAPIError extends Error {
  readonly status: number;
  readonly code: string;
  readonly traceId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, body: BrainErrorBody | undefined) {
    const code = body?.code ?? "unknown";
    const message = body?.message ?? `Brain API request failed with status ${status}`;
    super(`[${code}] ${message}`);
    this.name = "BrainAPIError";
    this.status = status;
    this.code = code;
    this.traceId = body?.trace_id;
    this.details = body?.details;
  }
}
