/**
 * Integration tests for every endpoint in §Raw of Brain_API_Specification.yaml.
 *
 * §7.1: "Every endpoint in the OpenAPI spec has at least one happy-path
 * integration test and one error-path test."
 *
 * Requires DATABASE_URL. Skip if unset.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newRawArtifactId, newTenantId } from "@brain/shared";
import { buildHarness, type Harness } from "./harness.js";

const DESCRIBE = process.env.DATABASE_URL !== undefined ? describe : describe.skip;

let h: Harness | null = null;
const tenant = newTenantId();

DESCRIBE("raw integration (requires DATABASE_URL)", () => {
  beforeAll(async () => {
    h = await buildHarness();
  }, 60_000);

  afterAll(async () => {
    if (h !== null) await h.cleanup();
  });

  async function writeToken(
    scopes: string[] = ["raw:write", "raw:read", "raw:admin"],
  ): Promise<string> {
    if (h === null) throw new Error("harness not built");
    const { token } = await h.signToken({ tenantId: tenant, scopes });
    return token;
  }

  it("POST /raw/ingest (JSON url path is rejected for non-https)", async () => {
    if (h === null) return;
    const token = await writeToken();
    const res = await h.app.inject({
      method: "POST",
      url: "/raw/ingest",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ source_type: "upload", url: "http://example.com/doc" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: "request_body_invalid" },
    });
  });

  it("POST /raw/ingest requires auth (401 without token)", async () => {
    if (h === null) return;
    const res = await h.app.inject({
      method: "POST",
      url: "/raw/ingest",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "auth_token_missing" } });
  });

  it("POST /raw/ingest multipart happy path: new artifact (201) + dedup (200)", async () => {
    if (h === null) return;
    const token = await writeToken();

    const boundary = "----brainBoundary";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="source_type"\r\n\r\nupload\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\n` +
      `hello\r\n` +
      `--${boundary}--\r\n`;

    const first = await h.app.inject({
      method: "POST",
      url: "/raw/ingest",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(first.statusCode).toBe(201);
    const created = first.json() as { raw_id: string; sha256: string; deduplicated: boolean };
    expect(created.raw_id).toMatch(/^raw_/);
    expect(created.deduplicated).toBe(false);

    const dup = await h.app.inject({
      method: "POST",
      url: "/raw/ingest",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(dup.statusCode).toBe(200);
    const dupBody = dup.json() as { sha256: string; deduplicated: boolean };
    expect(dupBody.sha256).toBe(created.sha256);
    expect(dupBody.deduplicated).toBe(true);
  });

  it("GET /raw/{raw_id} returns a signed URL for a live artifact", async () => {
    if (h === null) return;
    const token = await writeToken();

    const boundary = "----brainBoundary";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="source_type"\r\n\r\nupload\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="f.txt"\r\nContent-Type: text/plain\r\n\r\n` +
      `signed-url-test\r\n` +
      `--${boundary}--\r\n`;
    const ingestRes = await h.app.inject({
      method: "POST",
      url: "/raw/ingest",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    const { raw_id } = ingestRes.json() as { raw_id: string };

    const getRes = await h.app.inject({
      method: "GET",
      url: `/raw/${raw_id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(200);
    const payload = getRes.json() as { signed_url: string; sha256: string };
    expect(payload.signed_url).toMatch(/^memory:\/\//);
    expect(payload.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("GET /raw/{raw_id} returns 404 for unknown id", async () => {
    if (h === null) return;
    const token = await writeToken();
    // A well-formed but non-existent raw_id, so the route passes id validation
    // and reaches the not-found path (404). A malformed id would 400 first.
    const res = await h.app.inject({
      method: "GET",
      url: `/raw/${newRawArtifactId()}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "raw_artifact_not_found" } });
  });

  it("DELETE /raw/{raw_id} tombstones; subsequent GET returns 410", async () => {
    if (h === null) return;
    const token = await writeToken();

    // Seed an artifact.
    const boundary = "----brainBoundary";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="source_type"\r\n\r\nupload\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="f.txt"\r\nContent-Type: text/plain\r\n\r\n` +
      `tombstone-me\r\n` +
      `--${boundary}--\r\n`;
    const ingestRes = await h.app.inject({
      method: "POST",
      url: "/raw/ingest",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    const { raw_id } = ingestRes.json() as { raw_id: string };

    const delRes = await h.app.inject({
      method: "DELETE",
      url: `/raw/${raw_id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(delRes.statusCode).toBe(204);

    const getRes = await h.app.inject({
      method: "GET",
      url: `/raw/${raw_id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(410);
    expect(getRes.json()).toMatchObject({ error: { code: "raw_artifact_tombstoned" } });
  });

  it("GET /raw/{raw_id}/parsed returns empty array for a live artifact (stage-2)", async () => {
    if (h === null) return;
    const token = await writeToken();

    const boundary = "----brainBoundary";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="source_type"\r\n\r\nupload\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="f.txt"\r\nContent-Type: text/plain\r\n\r\n` +
      `parsed-empty\r\n` +
      `--${boundary}--\r\n`;
    const ingestRes = await h.app.inject({
      method: "POST",
      url: "/raw/ingest",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    const { raw_id } = ingestRes.json() as { raw_id: string };

    const parsedRes = await h.app.inject({
      method: "GET",
      url: `/raw/${raw_id}/parsed`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(parsedRes.statusCode).toBe(200);
    const p = parsedRes.json() as { raw_id: string; parsed: unknown[] };
    expect(p.raw_id).toBe(raw_id);
    expect(p.parsed).toEqual([]);
  });

  it("POST /raw/webhooks/plaid rejects missing signature (401)", async () => {
    if (h === null) return;
    const res = await h.app.inject({
      method: "POST",
      url: "/raw/webhooks/plaid",
      headers: { "content-type": "application/json" },
      payload: `{"webhook_id":"test"}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "raw_webhook_signature_invalid" } });
  });

  it("POST /raw/webhooks/stripe returns 501 (stubbed provider)", async () => {
    if (h === null) return;
    const res = await h.app.inject({
      method: "POST",
      url: "/raw/webhooks/stripe",
      headers: { "content-type": "application/json" },
      payload: `{"id":"evt_test"}`,
    });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ error: { code: "raw_source_unsupported" } });
  });
});
