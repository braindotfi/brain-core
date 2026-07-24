/**
 * Process-role resolution for worker/process separation.
 *
 * One image, role via env. A process runs the public `/v1` API surface and/or a
 * selected set of background-worker groups, so the same `brain-core` image can
 * be deployed as an HTTP-only api plus independently restartable/scalable worker
 * processes. Defaults reproduce the historical all-in-one process.
 *
 *   BRAIN_HTTP_ENABLED  gate the /v1 API surface (health stays on regardless).
 *   BRAIN_WORKERS       "all" | "none" | CSV of worker groups.
 *
 * This module is pure (no DB/IO) so the mapping from env -> {http, workers,
 * pools} is unit-testable. main.ts consumes resolveComposition() to decide which
 * pools to create, whether to register /v1, and which workers to start.
 */

export const WORKER_GROUPS = [
  "raw", // sync + interpret workers
  "normalize", // raw_parsed -> ledger normalize worker
  "canonical", // canonical projection worker
  "ledger", // ledger gl + ap/ar projection workers
  "execution", // outbox drain worker
  "audit", // audit consistency verifier + anchor scheduler/reconciler
  "webhook", // webhook dead-letter dispatch worker
  "blob_purge", // tenant blob-purge worker
  "tenant_export", // tenant data export worker
  "agent_route", // domain-event -> internal-agent route worker
  "wiki", // wiki page regeneration worker
] as const;

export type WorkerGroup = (typeof WORKER_GROUPS)[number];

/**
 * The least-privilege role pools (R-12) that are created on demand. The base
 * `brain_app` pool and the `brain_wiki_reader` pool are always created and are
 * not gated here.
 */
export type PoolName =
  | "raw_worker"
  | "canonical_projector"
  | "ledger_projector"
  | "execution_worker"
  | "audit_verifier"
  | "audit_publisher"
  | "resolver"
  | "tenant_deletion";

/** Role pools each worker group needs (groups on the brain_app pool map to []). */
const WORKER_POOLS: Record<WorkerGroup, ReadonlyArray<PoolName>> = {
  raw: ["raw_worker"],
  normalize: [], // brain_app (tenant-scoped)
  canonical: ["canonical_projector"],
  ledger: ["ledger_projector"],
  execution: ["execution_worker"],
  audit: ["audit_verifier", "audit_publisher"], // verifier + anchor enumeration
  webhook: [], // brain_app
  blob_purge: ["tenant_deletion"],
  tenant_export: ["tenant_deletion"],
  agent_route: [], // brain_app
  wiki: ["tenant_deletion"], // tenant discovery only; page generation uses brain_wiki_reader
};

/** Role pools the HTTP /v1 routes need (webhook/SIWX/login, tenant deletion, audit health). */
const ROUTE_POOLS: ReadonlyArray<PoolName> = ["resolver", "tenant_deletion", "audit_verifier"];

/** Env var that supplies each role pool's connection string (db-isolation fence). */
export const POOL_ENV: Record<PoolName, string> = {
  raw_worker: "BRAIN_RAW_WORKER_DB_URL",
  canonical_projector: "BRAIN_CANONICAL_PROJECTOR_DB_URL",
  ledger_projector: "BRAIN_LEDGER_PROJECTOR_DB_URL",
  execution_worker: "BRAIN_EXECUTION_WORKER_DB_URL",
  audit_verifier: "BRAIN_AUDIT_VERIFIER_DB_URL",
  audit_publisher: "BRAIN_AUDIT_PUBLISHER_DB_URL",
  resolver: "BRAIN_RESOLVER_DB_URL",
  tenant_deletion: "BRAIN_TENANT_DELETION_DB_URL",
};

const WORKER_GROUP_SET: ReadonlySet<string> = new Set(WORKER_GROUPS);

/**
 * Parse BRAIN_WORKERS into a set of groups. "all" -> every group, "none" ->
 * empty, otherwise a CSV validated against WORKER_GROUPS. Throws (fail-closed)
 * on an unknown group so a typo cannot silently disable a worker.
 */
export function parseWorkerSelection(value: string): Set<WorkerGroup> {
  const normalized = value.trim().toLowerCase();
  if (normalized === "all") return new Set(WORKER_GROUPS);
  if (normalized === "none" || normalized === "") return new Set();
  const groups = normalized
    .split(",")
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
  const unknown = groups.filter((g) => !WORKER_GROUP_SET.has(g));
  if (unknown.length > 0) {
    throw new Error(
      `BRAIN_WORKERS contains unknown worker group(s): ${unknown.join(", ")}. ` +
        `Valid groups: ${WORKER_GROUPS.join(", ")} (or "all" / "none").`,
    );
  }
  return new Set(groups as WorkerGroup[]);
}

export interface ProcessComposition {
  httpEnabled: boolean;
  workers: Set<WorkerGroup>;
  /** Role pools to create: the union of active route + active worker consumers. */
  pools: Set<PoolName>;
}

/** Resolve the process role from config into {http, workers, pools}. */
export function resolveComposition(input: {
  httpEnabled: boolean;
  workers: string;
}): ProcessComposition {
  const workers = parseWorkerSelection(input.workers);
  const pools = new Set<PoolName>();
  if (input.httpEnabled) for (const p of ROUTE_POOLS) pools.add(p);
  for (const g of workers) for (const p of WORKER_POOLS[g]) pools.add(p);
  return { httpEnabled: input.httpEnabled, workers, pools };
}
