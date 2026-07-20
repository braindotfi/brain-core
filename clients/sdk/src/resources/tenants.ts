import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { components } from "../generated/openapi.js";

export type TenantExportJob = components["schemas"]["TenantExportJob"];

function unwrap<T>(data: T | undefined, error: BrainErrorBody | undefined, status: number): T {
  if (error !== undefined || data === undefined) {
    throw new BrainAPIError(status, error);
  }
  return data;
}

export class TenantsResource {
  constructor(private readonly http: BrainHttpClient) {}

  async export(tenantId: string): Promise<TenantExportJob> {
    const { data, error, response } = await this.http.POST("/tenants/{id}/export", {
      params: { path: { id: tenantId } },
    });
    return unwrap(data, error, response.status);
  }

  async getExport(tenantId: string, jobId: string): Promise<TenantExportJob> {
    const { data, error, response } = await this.http.GET("/tenants/{id}/export/{job_id}", {
      params: { path: { id: tenantId, job_id: jobId } },
    });
    return unwrap(data, error, response.status);
  }

  async downloadExport(tenantId: string, jobId: string): Promise<string> {
    const { data, error, response } = await this.http.GET(
      "/tenants/{id}/export/{job_id}/download",
      {
        params: { path: { id: tenantId, job_id: jobId } },
        parseAs: "text",
      },
    );
    return unwrap(data, error, response.status);
  }
}
