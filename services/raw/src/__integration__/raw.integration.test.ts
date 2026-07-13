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
import { buildHarness, signCrossTenantServiceAuth, type Harness } from "./harness.js";

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
      payload: JSON.stringify({ source_type: "csv_upload", url: "http://example.com/doc" }),
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
      `Content-Disposition: form-data; name="source_type"\r\n\r\nother\r\n` +
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
      `Content-Disposition: form-data; name="source_type"\r\n\r\nother\r\n` +
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
      `Content-Disposition: form-data; name="source_type"\r\n\r\nother\r\n` +
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
      `Content-Disposition: form-data; name="source_type"\r\n\r\nother\r\n` +
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

  async function ingestUpload(token: string, content: string): Promise<string> {
    if (h === null) throw new Error("harness not built");
    const boundary = "----brainBoundary";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="source_type"\r\n\r\nother\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="f.txt"\r\nContent-Type: text/plain\r\n\r\n` +
      `${content}\r\n` +
      `--${boundary}--\r\n`;
    const res = await h.app.inject({
      method: "POST",
      url: "/raw/ingest",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    return (res.json() as { raw_id: string }).raw_id;
  }

  it("POST /raw/{raw_id}/parsed writes a record; GET then returns it", async () => {
    if (h === null) return;
    const token = await writeToken();
    const raw_id = await ingestUpload(token, "parsed-write");

    const writeRes = await h.app.inject({
      method: "POST",
      url: `/raw/${raw_id}/parsed`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({
        parser: "doc_obligation_v1",
        parser_version: "1.0.0",
        extracted: { direction: "payable", amount: "100.00", currency: "USD" },
        confidence: 0.4,
      }),
    });
    expect(writeRes.statusCode).toBe(201);
    const written = writeRes.json() as { id: string; raw_artifact_id: string; confidence: number };
    expect(written.raw_artifact_id).toBe(raw_id);
    expect(written.confidence).toBe(0.4);

    const getRes = await h.app.inject({
      method: "GET",
      url: `/raw/${raw_id}/parsed`,
      headers: { authorization: `Bearer ${token}` },
    });
    const listed = getRes.json() as { parsed: Array<{ id: string; parser: string }> };
    expect(listed.parsed).toHaveLength(1);
    expect(listed.parsed[0]?.id).toBe(written.id);
    expect(listed.parsed[0]?.parser).toBe("doc_obligation_v1");
  });

  it("POST /raw/{raw_id}/parsed is idempotent on (artifact, parser, version): re-post returns 200 + same row", async () => {
    if (h === null) return;
    const token = await writeToken();
    const raw_id = await ingestUpload(token, "parsed-idempotent");
    const payload = JSON.stringify({
      parser: "doc_obligation_v1",
      parser_version: "1.0.0",
      extracted: { direction: "receivable", amount: "5.00" },
    });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const first = await h.app.inject({
      method: "POST",
      url: `/raw/${raw_id}/parsed`,
      headers,
      payload,
    });
    const second = await h.app.inject({
      method: "POST",
      url: `/raw/${raw_id}/parsed`,
      headers,
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { id: string }).id).toBe((first.json() as { id: string }).id);
  });

  it("POST /raw/{raw_id}/parsed returns 404 for an unknown artifact", async () => {
    if (h === null) return;
    const token = await writeToken();
    const res = await h.app.inject({
      method: "POST",
      url: `/raw/${newRawArtifactId()}/parsed`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ parser: "p", parser_version: "1", extracted: {} }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "raw_artifact_not_found" } });
  });

  it("POST /raw/{raw_id}/parsed requires raw:write scope (403 with read-only token)", async () => {
    if (h === null) return;
    const writer = await writeToken();
    const raw_id = await ingestUpload(writer, "parsed-scope");
    const readToken = await writeToken(["raw:read"]);
    const res = await h.app.inject({
      method: "POST",
      url: `/raw/${raw_id}/parsed`,
      headers: { authorization: `Bearer ${readToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ parser: "p", parser_version: "1", extracted: {} }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "auth_scope_insufficient" } });
  });

  it("POST /raw/{raw_id}/parsed rejects a malformed body (400)", async () => {
    if (h === null) return;
    const token = await writeToken();
    const raw_id = await ingestUpload(token, "parsed-badbody");
    const res = await h.app.inject({
      method: "POST",
      url: `/raw/${raw_id}/parsed`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ parser: "", parser_version: "1", extracted: {} }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "request_body_invalid" } });
  });

  it("POST /raw/{raw_id}/parsed with a proven HMAC signature writes into the X-Brain-Write-Tenant header tenant, not the JWT tenant", async () => {
    if (h === null) return;
    const tenantB = newTenantId();
    const { token: tenantBToken } = await h.signToken({
      tenantId: tenantB,
      scopes: ["raw:write", "raw:read"],
    });
    const raw_id = await ingestUpload(tenantBToken, "cross-tenant-write");

    // Sign a raw:write token in a different tenant (A), standing in for the
    // static golden-tenant agent JWT, and prove the shared secret (via HMAC
    // over the raw body, never the secret itself) to redirect the write
    // into tenant B.
    const { token: tenantAAgentToken } = await h.signToken({
      tenantId: newTenantId(),
      scopes: ["raw:write"],
      principalType: "agent",
    });

    const payload = JSON.stringify({
      parser: "doc_obligation_v1",
      parser_version: "1.0.0",
      extracted: { direction: "payable", amount: "42.00" },
    });
    const writeRes = await h.app.inject({
      method: "POST",
      url: `/raw/${raw_id}/parsed`,
      headers: {
        authorization: `Bearer ${tenantAAgentToken}`,
        "content-type": "application/json",
        "x-brain-write-tenant": tenantB,
        "x-brain-service-auth": signCrossTenantServiceAuth(payload),
      },
      payload,
    });
    expect(writeRes.statusCode).toBe(201);
    const written = writeRes.json() as { id: string };

    // GET as a tenant-B token proves the row is reachable there.
    const getRes = await h.app.inject({
      method: "GET",
      url: `/raw/${raw_id}/parsed`,
      headers: { authorization: `Bearer ${tenantBToken}` },
    });
    const listed = getRes.json() as { parsed: Array<{ id: string }> };
    expect(listed.parsed.map((p) => p.id)).toContain(written.id);

    // The local test DB role is a superuser (bypasses RLS), so the GET above
    // cannot by itself distinguish "wrote to tenant B" from "wrote to the
    // JWT's own tenant and every tenant can see it anyway". Assert the
    // persisted column directly for real proof of which tenant it landed in.
    const { rows } = await h.pool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM raw_parsed WHERE id = $1",
      [written.id],
    );
    expect(rows[0]?.tenant_id).toBe(tenantB);
  });

  it("POST /raw/{raw_id}/parsed with a valid signature but a malformed X-Brain-Write-Tenant fails closed (403), not open", async () => {
    if (h === null) return;
    const token = await writeToken();
    const raw_id = await ingestUpload(token, "cross-tenant-malformed-tenant");
    const payload = JSON.stringify({
      parser: "doc_obligation_v1",
      parser_version: "1.0.0",
      extracted: { direction: "payable", amount: "3.00" },
    });

    const res = await h.app.inject({
      method: "POST",
      url: `/raw/${raw_id}/parsed`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-brain-write-tenant": "not-a-tenant-id",
        "x-brain-service-auth": signCrossTenantServiceAuth(payload),
      },
      payload,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "auth_tenant_mismatch" } });
  });

  it("POST /raw/{raw_id}/parsed with a valid signature but no X-Brain-Write-Tenant falls back to the JWT tenant (201)", async () => {
    if (h === null) return;
    const token = await writeToken();
    const raw_id = await ingestUpload(token, "cross-tenant-no-target-header");
    const payload = JSON.stringify({
      parser: "doc_obligation_v1",
      parser_version: "1.0.0",
      extracted: { direction: "payable", amount: "4.00" },
    });

    const res = await h.app.inject({
      method: "POST",
      url: `/raw/${raw_id}/parsed`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-brain-service-auth": signCrossTenantServiceAuth(payload),
      },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const written = res.json() as { id: string };

    const getRes = await h.app.inject({
      method: "GET",
      url: `/raw/${raw_id}/parsed`,
      headers: { authorization: `Bearer ${token}` },
    });
    const listed = getRes.json() as { parsed: Array<{ id: string }> };
    expect(listed.parsed.map((p) => p.id)).toContain(written.id);
  });

  it("POST /raw/{raw_id}/parsed ignores X-Brain-Write-Tenant without a matching signature (no cross-tenant leak)", async () => {
    if (h === null) return;
    const token = await writeToken();
    const raw_id = await ingestUpload(token, "cross-tenant-no-secret");
    const otherTenant = newTenantId();

    const writeRes = await h.app.inject({
      method: "POST",
      url: `/raw/${raw_id}/parsed`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-brain-write-tenant": otherTenant,
        "x-brain-service-auth": "sha256=wrong",
      },
      payload: JSON.stringify({
        parser: "doc_obligation_v1",
        parser_version: "1.0.0",
        extracted: { direction: "payable", amount: "1.00" },
      }),
    });
    // Header ignored: the write proceeds against the caller's own tenant, on
    // the same artifact it already owns, so this still succeeds (201); it
    // just does not honor otherTenant.
    expect(writeRes.statusCode).toBe(201);
    const written = writeRes.json() as { id: string };

    const getRes = await h.app.inject({
      method: "GET",
      url: `/raw/${raw_id}/parsed`,
      headers: { authorization: `Bearer ${token}` },
    });
    const listed = getRes.json() as { parsed: Array<{ id: string }> };
    expect(listed.parsed.map((p) => p.id)).toContain(written.id);

    // Affirmatively confirm the row never landed in otherTenant. The test
    // DB role is a superuser (bypasses RLS), so a GET-as-otherTenant cannot
    // prove absence here; assert the persisted column instead.
    const { rows } = await h.pool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM raw_parsed WHERE id = $1",
      [written.id],
    );
    expect(rows[0]?.tenant_id).toBe(tenant);
    expect(rows[0]?.tenant_id).not.toBe(otherTenant);
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
