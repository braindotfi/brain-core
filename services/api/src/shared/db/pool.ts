/**
 * Brain Postgres pool factory.
 *
 * Thin wrapper around `pg.Pool` that bakes in Brain-wide connection options
 * (statement timeout, application_name for query logs, TLS enforcement).
 *
 * Every service calls `createPool(config)` once at boot and reuses the result.
 * Tenant scoping is NOT applied here — it is applied per-checkout by
 * `withTenantScope()` in `./tenant-scoped.ts`.
 */

import { Pool, type PoolConfig } from "pg";

export interface CreatePoolOptions {
  connectionString: string;
  max?: number;
  /** `statement_timeout` in ms. Applied on every connection checkout. */
  statementTimeoutMs?: number;
  /** Used as `application_name` in pg_stat_activity and server logs. */
  applicationName?: string;
  /** Enable SSL. Default true for remote hosts, false for localhost. */
  ssl?: boolean | "auto";
  /** Idle socket timeout in ms. */
  idleTimeoutMs?: number;
}

export function createPool(opts: CreatePoolOptions): Pool {
  const {
    connectionString,
    max = 10,
    statementTimeoutMs = 30_000,
    applicationName = "brain",
    ssl = "auto",
    idleTimeoutMs = 30_000,
  } = opts;

  const poolConfig: PoolConfig = {
    connectionString,
    max,
    idleTimeoutMillis: idleTimeoutMs,
    application_name: applicationName,
    // §10 production runs on Azure Postgres which enforces TLS. Local dev
    // against docker compose does not — hence "auto" based on host.
    ...(ssl === "auto"
      ? isLocalHost(connectionString)
        ? {}
        : { ssl: { rejectUnauthorized: true } }
      : ssl === true
        ? { ssl: { rejectUnauthorized: true } }
        : {}),
  };

  const pool = new Pool(poolConfig);

  // Every new connection gets a statement_timeout. Applied via a one-shot
  // SET on the session — survives until that connection is discarded.
  pool.on("connect", (client) => {
    void client.query(`SET statement_timeout = ${statementTimeoutMs}`);
  });

  return pool;
}

export function isLocalHost(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}
