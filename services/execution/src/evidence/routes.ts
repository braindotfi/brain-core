import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  requireScope,
  type AuditEmitter,
  type Scope,
  type ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import type { EvidenceBlobStore } from "./blob-store.js";
import { EvidenceStorageService, evidenceRecordToWire, evidenceToWire } from "./service.js";
import type { EvidenceKind, EvidenceRetentionClass } from "./repository.js";
import {
  parseEvidenceResolveBody,
  resolveEvidenceRefs,
  unsupportedEvidenceKinds,
} from "./resolve.js";

const READ: Scope = "execution:read";

export interface EvidenceResolveRoutesDeps {
  pool: Pool;
}

export interface EvidenceRoutesDeps extends EvidenceResolveRoutesDeps {
  audit: AuditEmitter;
  blobStore: EvidenceBlobStore;
}

export async function registerEvidenceResolveRoutes(
  app: FastifyInstance,
  deps: EvidenceResolveRoutesDeps,
): Promise<void> {
  app.post("/evidence/resolve", async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, READ);
    const refs = parseEvidenceResolveBody(request.body);
    const unsupported = unsupportedEvidenceKinds(refs);
    if (unsupported.length > 0) {
      request.log.warn({ unsupported_kinds: unsupported }, "unsupported evidence resolve kinds");
    }
    const results = await resolveEvidenceRefs(deps.pool, ctx, refs);
    reply.status(200);
    return { results };
  });
}

export async function registerEvidenceRoutes(
  app: FastifyInstance,
  deps: EvidenceRoutesDeps,
): Promise<void> {
  await registerEvidenceResolveRoutes(app, deps);
  const service = new EvidenceStorageService(deps.pool, deps.blobStore, deps.audit);

  app.post("/evidence/upload", async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, "execution:write");
    const body = asRecord(request.body);
    rejectTenantOverride(optionalString(body["tenant_id"]), ctx.tenantId);
    const retentionClass = parseRetention(body["retention_class"]);
    const proposalId = optionalString(body["proposal_id"]);
    const uploadInput = {
      kind: parseEvidenceKind(body["kind"]),
      name: requiredString(body["name"], "name"),
      content: Buffer.from(requiredString(body["content_base64"], "content_base64"), "base64"),
      mimeType: requiredString(body["mime_type"], "mime_type"),
      ...(retentionClass !== undefined ? { retentionClass } : {}),
      ...(body["metadata"] !== undefined ? { metadata: objectValue(body["metadata"]) } : {}),
      ...(proposalId !== undefined ? { proposalId } : {}),
    };
    const result = await service.upload(ctx, uploadInput);
    reply.status(201);
    return { evidence: evidenceToWire(result) };
  });

  app.post(
    "/evidence/register-external",
    async (request: FastifyRequest<{ Body: unknown }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, "execution:write");
      const body = asRecord(request.body);
      rejectTenantOverride(optionalString(body["tenant_id"]), ctx.tenantId);
      if (body["kind"] !== undefined && body["kind"] !== "external_link") {
        throw brainError("request_body_invalid", "kind must be external_link");
      }
      const proposalId = optionalString(body["proposal_id"]);
      const result = await service.registerExternal(ctx, {
        name: requiredString(body["name"], "name"),
        url: requiredUrl(body["url"], "url"),
        ...(body["metadata"] !== undefined ? { metadata: objectValue(body["metadata"]) } : {}),
        ...(proposalId !== undefined ? { proposalId } : {}),
      });
      reply.status(201);
      return { evidence: evidenceToWire(result) };
    },
  );

  app.post("/evidence/generate", async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, "execution:write");
    const body = asRecord(request.body);
    rejectTenantOverride(optionalString(body["tenant_id"]), ctx.tenantId);
    const inputRef = optionalString(body["input_ref"]);
    const proposalId = optionalString(body["proposal_id"]);
    const result = await service.generate(ctx, {
      kind: parseGeneratedKind(body["kind"]),
      name: requiredString(body["name"], "name"),
      generator: requiredString(body["generator"], "generator"),
      ...(inputRef !== undefined ? { inputRef } : {}),
      ...(body["metadata"] !== undefined ? { metadata: objectValue(body["metadata"]) } : {}),
      ...(proposalId !== undefined ? { proposalId } : {}),
    });
    reply.status(201);
    return { evidence: evidenceToWire(result) };
  });

  app.get("/evidence/:id", async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, READ);
    return { evidence: evidenceToWire(await service.get(ctx, request.params.id)) };
  });

  app.get(
    "/evidence",
    async (
      request: FastifyRequest<{
        Querystring: {
          proposal_id?: string;
          tenant_id?: string;
          kind?: string;
          from?: string;
          to?: string;
          limit?: string;
        };
      }>,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, READ);
      rejectTenantOverride(request.query.tenant_id, ctx.tenantId);
      const rows = await service.list(ctx, {
        ...(request.query.proposal_id !== undefined
          ? { proposalId: request.query.proposal_id }
          : {}),
        ...(request.query.kind !== undefined
          ? { kind: parseEvidenceKind(request.query.kind) }
          : {}),
        ...(request.query.from !== undefined
          ? { from: parseDate(request.query.from, "from") }
          : {}),
        ...(request.query.to !== undefined ? { to: parseDate(request.query.to, "to") } : {}),
        ...(request.query.limit !== undefined ? { limit: parseLimit(request.query.limit) } : {}),
      });
      return { evidence: rows.map(evidenceRecordToWire) };
    },
  );

  app.delete("/evidence/:id", async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, "execution:write");
    return { evidence: evidenceRecordToWire(await service.delete(ctx, request.params.id)) };
  });
}

function assertCtx(request: FastifyRequest): ServiceCallContext {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  return {
    tenantId: request.principal.tenantId,
    actor: request.principal.id,
    requestId: request.id,
    principalType: request.principal.type,
    scopes: request.principal.scopes,
  };
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw brainError("request_body_invalid", "body must be an object");
  }
  return body as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw brainError("request_body_invalid", `${name} required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredUrl(value: unknown, name: string): string {
  const text = requiredString(value, name);
  try {
    const url = new URL(text);
    if (url.protocol === "http:" || url.protocol === "https:") return text;
  } catch {
    throw brainError("request_body_invalid", `${name} must be a URL`);
  }
  throw brainError("request_body_invalid", `${name} must be a URL`);
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw brainError("request_body_invalid", "metadata must be an object");
  }
  return value as Record<string, unknown>;
}

function parseEvidenceKind(value: unknown): EvidenceKind {
  if (
    value === "pdf" ||
    value === "record" ||
    value === "mail" ||
    value === "image" ||
    value === "external" ||
    value === "report" ||
    value === "data"
  ) {
    return value;
  }
  throw brainError("request_body_invalid", "invalid evidence kind");
}

function parseGeneratedKind(value: unknown): "report" | "data" {
  if (value === "report" || value === "data") return value;
  throw brainError("request_body_invalid", "kind must be report or data");
}

function parseRetention(value: unknown): EvidenceRetentionClass | undefined {
  if (value === undefined) return undefined;
  if (value === "standard" || value === "compliance_7yr" || value === "permanent") return value;
  throw brainError("request_body_invalid", "invalid retention class");
}

function parseDate(value: string, name: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw brainError("request_params_invalid", `${name} must be ISO8601`);
  }
  return date;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw brainError("request_params_invalid", "limit must be between 1 and 100");
  }
  return parsed;
}

function rejectTenantOverride(queryTenantId: string | undefined, ctxTenantId: string): void {
  if (queryTenantId !== undefined && queryTenantId !== ctxTenantId) {
    throw brainError("auth_tenant_mismatch", "tenant_id must match authenticated tenant");
  }
}
