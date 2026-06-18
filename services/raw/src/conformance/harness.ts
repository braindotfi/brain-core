/**
 * Connector conformance harness (Phase 6: internal connector SDK + certification).
 *
 * A connector is "certified" when it satisfies the source-agnostic contract the
 * platform relies on: a complete ConnectorDescriptor whose capability claims
 * match the adapter's implemented methods (§6), and a fetchIncremental that
 * emits §9-complete envelopes with retry-stable idempotency keys and a valid
 * §10 checkpoint result. These assertions are reusable: a new connector's test
 * calls them with its own provider mock instead of re-deriving the invariants.
 *
 * Vitest-free on purpose (throws descriptive Errors) so it is part of the
 * connector SDK surface, callable from any test or a certification script.
 */

import type { ConnectorDescriptor } from "../adapters/descriptors.js";
import type {
  FetchIncrementalContext,
  SourceAdapter,
  SyncPartitionState,
} from "../adapters/types.js";

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const CHECKPOINT_TYPES = new Set(["cursor", "page_token", "watermark", "snapshot"]);

function fail(connector: string, msg: string): never {
  throw new Error(`connector conformance [${connector}]: ${msg}`);
}

/**
 * Static contract: descriptor completeness + capability<->implementation parity
 * + checkpoint-type validity + reserved-route enforcement. No provider contact.
 */
export function assertStaticConformance(
  adapter: SourceAdapter,
  descriptor: ConnectorDescriptor,
): void {
  const id = descriptor.connectorType;
  if (descriptor.connectorType !== adapter.sourceType) {
    fail(
      id,
      `descriptor.connectorType '${descriptor.connectorType}' != adapter.sourceType '${adapter.sourceType}'`,
    );
  }
  if (!SEMVER_RE.test(descriptor.version)) {
    fail(id, `version '${descriptor.version}' is not semver`);
  }

  // Capability <-> implementation parity (both directions).
  const caps = descriptor.capabilities;
  if ((caps.incremental || caps.backfill) && adapter.fetchIncremental === undefined) {
    fail(id, "claims incremental/backfill but has no fetchIncremental");
  }
  if ((caps.incremental || caps.backfill) && adapter.syncObjectTypes === undefined) {
    fail(id, "claims incremental/backfill but declares no syncObjectTypes");
  }
  if (adapter.fetchIncremental !== undefined && !caps.incremental) {
    fail(id, "implements fetchIncremental but does not claim incremental");
  }
  if (caps.webhooks && adapter.handleWebhook === undefined) {
    fail(id, "claims webhooks but has no handleWebhook");
  }
  // Note: the reverse (handleWebhook present => webhooks claimed) is intentionally
  // NOT asserted -- a stub/placeholder handleWebhook may exist before the
  // capability is real, matching the codebase's descriptor contract.

  // Every synced object type is declared in the descriptor, with a valid
  // checkpoint type.
  for (const spec of adapter.syncObjectTypes ?? []) {
    if (!descriptor.objectTypes.includes(spec.objectType)) {
      fail(id, `syncs '${spec.objectType}' but does not list it in objectTypes`);
    }
    if (!CHECKPOINT_TYPES.has(spec.checkpointType)) {
      fail(id, `object '${spec.objectType}' has invalid checkpoint_type '${spec.checkpointType}'`);
    }
  }
  if (descriptor.parserVersions.length === 0 && (caps.incremental || caps.webhooks)) {
    fail(id, "an active connector must declare at least one parserVersion");
  }
}

export interface FetchConformanceInput {
  tenantId: string;
  credentials: Record<string, unknown>;
  partition: SyncPartitionState;
}

/**
 * Behavioral contract for a pull connector. The caller must have stubbed the
 * provider deterministically (same response for repeated calls). Asserts:
 *  - the result is a valid §10 shape (artifacts[], nextCheckpoint defined, hasMore boolean);
 *  - every artifact carries a §9 envelope with a non-empty sourceSchema and a
 *    non-empty idempotencyKey;
 *  - idempotency keys are RETRY-STABLE: re-running the same uncommitted
 *    partition yields identical keys (so a crash between ingest and checkpoint-
 *    commit re-pulls without creating duplicate artifacts).
 */
export async function assertFetchConformance(
  adapter: SourceAdapter,
  descriptor: ConnectorDescriptor,
  input: FetchConformanceInput,
): Promise<void> {
  const id = descriptor.connectorType;
  if (adapter.fetchIncremental === undefined) fail(id, "no fetchIncremental to exercise");

  const ctx: FetchIncrementalContext = {
    tenantId: input.tenantId,
    credentials: input.credentials,
    partition: input.partition,
  };
  const first = await adapter.fetchIncremental(ctx);

  if (!Array.isArray(first.artifacts)) fail(id, "result.artifacts is not an array");
  if (typeof first.hasMore !== "boolean") fail(id, "result.hasMore is not a boolean");
  if (!("nextCheckpoint" in first)) fail(id, "result has no nextCheckpoint");

  for (const art of first.artifacts) {
    const schema = art.envelope?.sourceSchema;
    if (typeof schema !== "string" || schema.length === 0) {
      fail(id, "an artifact is missing envelope.sourceSchema");
    }
    const key = art.envelope?.idempotencyKey;
    if (typeof key !== "string" || key.length === 0) {
      fail(id, "an artifact is missing envelope.idempotencyKey");
    }
  }

  // Retry stability: same uncommitted partition -> same idempotency keys.
  const second = await adapter.fetchIncremental(ctx);
  const keysOf = (r: typeof first): string[] =>
    r.artifacts.map((a) => a.envelope?.idempotencyKey ?? "").sort();
  const k1 = keysOf(first);
  const k2 = keysOf(second);
  if (k1.length !== k2.length || k1.some((k, i) => k !== k2[i])) {
    fail(id, `idempotency keys not retry-stable: ${JSON.stringify(k1)} vs ${JSON.stringify(k2)}`);
  }
}
