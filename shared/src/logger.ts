/**
 * Brain structured logger.
 *
 * §6.1: JSON. Required fields on every line:
 *   timestamp, level, service, tenant_id, request_id, trace_id, message
 *
 * §6.1 also prohibits PII in log bodies. Callers are responsible for hashing
 * or redacting sensitive fields at the call site. This module enforces the
 * minimum contract (required metadata) but does not attempt content-aware
 * redaction — that is a correctness property, not a transport property.
 */

import pino, { type Logger, type LoggerOptions } from "pino";

/**
 * Fields that every Brain log line should carry when available.
 * tenant_id, request_id, and trace_id are bound via child loggers as a
 * request moves through middleware.
 */
export interface BrainLogContext {
  tenant_id?: string;
  request_id?: string;
  trace_id?: string;
  principal_id?: string;
  principal_type?: "user" | "agent" | "api_partner";
  [key: string]: unknown;
}

export interface CreateLoggerOptions {
  /** Service name used as the `service` field on every log line. */
  service: string;
  /** Service version (populated from package.json / CI build metadata). */
  version?: string;
  /** Logger level: trace | debug | info | warn | error | fatal. Defaults to info. */
  level?: LoggerOptions["level"];
  /** If true, use pino-pretty transport (dev only). */
  pretty?: boolean;
  /** Additional bindings merged into every record. */
  base?: Record<string, unknown>;
}

/**
 * Build a root logger for a service. Exported as a factory — services call it
 * once at boot and pass the resulting logger into request-scoped child calls.
 */
export function createLogger(opts: CreateLoggerOptions): Logger {
  const { service, version = "0.0.0-dev", level = "info", pretty = false } = opts;

  const options: LoggerOptions = {
    level,
    base: { service, version, ...(opts.base ?? {}) },
    // §6.1: timestamp field, ISO-8601 with millisecond precision.
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    // Pino by default renames `msg` → not ideal; align with §6.1 "message".
    messageKey: "message",
    // Redact a conservative default set. Services can layer more.
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-brain-signature"]',
        "password",
        "token",
        "jwt",
        "secret",
      ],
      censor: "[REDACTED]",
    },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    ...(pretty
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss.l" },
          },
        }
      : {}),
  };

  return pino(options);
}

/**
 * Create a request-scoped child logger carrying the §6.1 context fields.
 * Safe to call on every request — pino child loggers are cheap.
 */
export function childFromContext(parent: Logger, ctx: BrainLogContext): Logger {
  return parent.child(compactContext(ctx));
}

/** Strip undefined fields so the JSON record stays lean. */
function compactContext(ctx: BrainLogContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export type { Logger } from "pino";
