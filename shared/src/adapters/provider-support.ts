import type { AuditEmitter } from "../audit/emitter.js";

export interface ProviderAdapterOptions {
  readonly tenantId?: string;
  readonly audit?: AuditEmitter;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export interface ProviderCallContext {
  readonly adapterKind: string;
  readonly provider: string;
  readonly operation: string;
  readonly tenantId?: string;
}

export interface ProviderSetupState {
  readonly provider: string;
  readonly requires_setup: boolean;
  readonly missing_env: readonly string[];
}

export class ProviderCallFailedError extends Error {
  public constructor(
    message: string,
    public override readonly cause: unknown,
  ) {
    super(message);
  }
}

export function providerSetup(
  provider: string,
  env: Record<string, string | undefined>,
  names: readonly string[],
): ProviderSetupState {
  return {
    provider,
    requires_setup: names.some((name) => env[name] === undefined || env[name] === ""),
    missing_env: names.filter((name) => env[name] === undefined || env[name] === ""),
  };
}

export async function withProviderFallback<T>(
  ctx: ProviderCallContext,
  opts: ProviderAdapterOptions,
  call: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await retry(call, 3);
    await emitProviderAudit(ctx, opts, started, true, false);
    return result;
  } catch (err) {
    await emitProviderAudit(ctx, opts, started, false, true);
    return fallback().catch(() => {
      throw new ProviderCallFailedError(`${ctx.provider}.${ctx.operation} failed`, err);
    });
  }
}

export async function retry<T>(call: () => Promise<T>, attempts: number): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts - 1) {
        await sleep(50 * 2 ** attempt);
      }
    }
  }
  throw lastErr;
}

export async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: Parameters<typeof fetch>[1],
): Promise<unknown> {
  const res = await fetchImpl(url, init);
  if (!res.ok) throw new Error(`provider_http_${res.status}`);
  if (res.status === 204) return {};
  return res.json() as Promise<unknown>;
}

export function bearerHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function emitProviderAudit(
  ctx: ProviderCallContext,
  opts: ProviderAdapterOptions,
  started: number,
  success: boolean,
  fallback_used: boolean,
): Promise<void> {
  if (opts.audit === undefined || ctx.tenantId === undefined) return;
  await opts.audit.emit({
    tenantId: ctx.tenantId,
    layer: "execution",
    actor: "system_provider_adapter",
    action: "adapter.call",
    inputs: {
      adapter_kind: ctx.adapterKind,
      provider: ctx.provider,
      operation: ctx.operation,
    },
    outputs: {
      provider: ctx.provider,
      latency_ms: Date.now() - started,
      success,
      fallback_used,
    },
    outcome: success ? "allow" : "warn",
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
