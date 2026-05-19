/**
 * Brain per-request context.
 *
 * Collects §6.1 log context (tenant_id, request_id, trace_id, principal_id,
 * principal_type) off a FastifyRequest after auth + request-id plugins have
 * populated them. Used by the logger/metrics/span bindings to ensure every
 * emission carries the right tags.
 */

import type { FastifyRequest } from "fastify";
import type { BrainLogContext } from "../logger.js";
import { currentTraceId } from "../tracing.js";

export interface RequestContext extends BrainLogContext {
  request_id: string;
}

/** Build a BrainLogContext from a Fastify request. Safe to call pre-auth. */
export function contextFromRequest(request: FastifyRequest): RequestContext {
  const principal = request.principal;
  const ctx: RequestContext = {
    request_id: request.id ?? "req_unknown",
  };
  const traceId = currentTraceId();
  if (traceId !== undefined) ctx.trace_id = traceId;
  if (principal !== undefined) {
    ctx.tenant_id = principal.tenantId;
    ctx.principal_id = principal.id;
    ctx.principal_type = principal.type;
  }
  return ctx;
}
