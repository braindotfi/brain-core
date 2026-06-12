/**
 * Connector dispatch — per `SourceType`, validate credentials at
 * connect time and produce a sync-job descriptor at sync time.
 *
 * v0.3 ship: two concrete connectors (Plaid, Stripe) wrap thin
 * credential checks; six stub connectors accept calls but emit
 * `{notes: "stub"}` so callers can detect them. Each stub graduates
 * to concrete by replacing the implementation here — no API change.
 *
 * @packageDocumentation
 */

import { brainError, newSourceSyncJobId } from "@brain/shared";
import {
  CONCRETE_SOURCE_TYPES,
  STUB_SOURCE_TYPES,
  type SourceType,
  type SyncJobDescriptor,
} from "./types.js";

export interface ConnectorContext {
  readonly tenantId: string;
  readonly credentials: Readonly<Record<string, unknown>>;
}

export interface Connector {
  /**
   * Validate credentials. Throws a BrainError on bad credentials —
   * the route layer maps to a 401 / `source_credential_invalid`.
   */
  validateCredentials(ctx: ConnectorContext): Promise<void>;
  /** Trigger an immediate sync. Returns the job descriptor. */
  sync(sourceId: string): Promise<SyncJobDescriptor>;
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

const plaidConnector: Connector = {
  async validateCredentials(ctx) {
    const access = ctx.credentials["access_token"];
    if (typeof access !== "string" || access.length === 0) {
      throw brainError("source_credential_invalid", "Plaid `access_token` is required");
    }
    // Real-deployment hook: a follow-up wires `services/raw/src/adapters/plaid`
    // here to do a balance-get probe against the live Plaid API. v0.3 ship
    // performs the validation above and accepts the connection optimistically.
  },
  async sync(sourceId) {
    return {
      job_id: newSourceSyncJobId(),
      source_id: sourceId,
      status: "enqueued",
    };
  },
};

const stripeConnector: Connector = {
  async validateCredentials(ctx) {
    const apiKey = ctx.credentials["api_key"];
    if (
      typeof apiKey !== "string" ||
      !(apiKey.startsWith("sk_test_") || apiKey.startsWith("sk_live_"))
    ) {
      throw brainError(
        "source_credential_invalid",
        "Stripe `api_key` must start with sk_test_ or sk_live_",
      );
    }
  },
  async sync(sourceId) {
    return {
      job_id: newSourceSyncJobId(),
      source_id: sourceId,
      status: "enqueued",
    };
  },
};

/**
 * Stub connector — accepts the call and emits a `notes: "stub"` marker
 * so SDK consumers can detect that the underlying adapter is not yet
 * live. Per Architecture §3.2 reconciliation stub pattern.
 */
const mergeAccountingConnector: Connector = {
  async validateCredentials(ctx) {
    const apiKey = ctx.credentials["api_key"];
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw brainError("source_credential_invalid", "Merge `api_key` (platform key) is required");
    }
    const accountToken = ctx.credentials["account_token"];
    if (typeof accountToken !== "string" || accountToken.length === 0) {
      throw brainError(
        "source_credential_invalid",
        "Merge `account_token` (linked-account token) is required",
      );
    }
  },
  async sync(sourceId) {
    return {
      job_id: newSourceSyncJobId(),
      source_id: sourceId,
      status: "enqueued",
    };
  },
};

const finchConnector: Connector = {
  async validateCredentials(ctx) {
    const accessToken = ctx.credentials["access_token"];
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw brainError("source_credential_invalid", "Finch `access_token` is required");
    }
  },
  async sync(sourceId) {
    return {
      job_id: newSourceSyncJobId(),
      source_id: sourceId,
      status: "enqueued",
    };
  },
};

const stubConnector: Connector = {
  async validateCredentials() {
    // Stubs accept any credentials — they don't hit a real provider.
    // When a stub graduates to concrete, this method gets the real
    // validation logic.
  },
  async sync(sourceId) {
    return {
      job_id: newSourceSyncJobId(),
      source_id: sourceId,
      status: "enqueued",
      notes: "stub",
    };
  },
};

const REGISTRY: Readonly<Record<SourceType, Connector>> = {
  plaid: plaidConnector,
  stripe: stripeConnector,
  netsuite: stubConnector,
  email_inbound: stubConnector,
  csv_upload: stubConnector,
  pdf_upload: stubConnector,
  alchemy_wallet: stubConnector,
  eth_address: stubConnector,
  merge_accounting: mergeAccountingConnector,
  finch: finchConnector,
};

export function getConnector(type: SourceType): Connector {
  return REGISTRY[type];
}

export function isStub(type: SourceType): boolean {
  return STUB_SOURCE_TYPES.has(type);
}

export function isConcrete(type: SourceType): boolean {
  return CONCRETE_SOURCE_TYPES.has(type);
}
