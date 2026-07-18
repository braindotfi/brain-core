import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { components } from "../generated/openapi.js";

export type EvidenceResolveRef = components["schemas"]["EvidenceResolveRef"];
export type EvidenceResolveResult = components["schemas"]["EvidenceResolveResult"];

function unwrap<T>(data: T | undefined, error: BrainErrorBody | undefined, status: number): T {
  if (error !== undefined || data === undefined) {
    throw new BrainAPIError(status, error);
  }
  return data;
}

export class EvidenceResource {
  constructor(private readonly http: BrainHttpClient) {}

  async resolve(refs: EvidenceResolveRef[]): Promise<EvidenceResolveResult[]> {
    const { data, error, response } = await this.http.POST("/evidence/resolve", {
      body: { refs },
    });
    const body = unwrap(data, error, response.status);
    return body.results;
  }
}
