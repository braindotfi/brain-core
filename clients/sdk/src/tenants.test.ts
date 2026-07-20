import { describe, expect, it, vi } from "vitest";
import { Brain } from "./brain.js";

describe("TenantsResource", () => {
  it("wraps tenant export status and download endpoints", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (url.endsWith("/download")) {
        return new Response("ndjson\n", {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      return Response.json({
        job_id: "texp_01HX0000000000000000000000",
        tenant_id: "tnt_01HX0000000000000000000000",
        status: "queued",
        byte_size: null,
        expires_at: "2026-07-27T00:00:00.000Z",
        error: null,
        created_at: "2026-07-20T00:00:00.000Z",
        updated_at: "2026-07-20T00:00:00.000Z",
      });
    });
    const brain = new Brain({ token: "token", environment: "local", fetch });

    await expect(brain.tenants.export("tnt_01HX0000000000000000000000")).resolves.toMatchObject({
      status: "queued",
    });
    await expect(
      brain.tenants.getExport("tnt_01HX0000000000000000000000", "texp_01HX0000000000000000000000"),
    ).resolves.toMatchObject({ job_id: "texp_01HX0000000000000000000000" });
    await expect(
      brain.tenants.downloadExport(
        "tnt_01HX0000000000000000000000",
        "texp_01HX0000000000000000000000",
      ),
    ).resolves.toBe("ndjson\n");
    expect(calls).toEqual([
      "http://localhost:3000/v1/tenants/tnt_01HX0000000000000000000000/export",
      "http://localhost:3000/v1/tenants/tnt_01HX0000000000000000000000/export/texp_01HX0000000000000000000000",
      "http://localhost:3000/v1/tenants/tnt_01HX0000000000000000000000/export/texp_01HX0000000000000000000000/download",
    ]);
  });
});
