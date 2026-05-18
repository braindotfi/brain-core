/**
 * `brain.audit.*` — append-only Merkle-chained log (Layer 6).
 *
 * Source pages:
 *   - https://docs.brain.fi/api-reference/audit-api
 *   - https://docs.brain.fi/sdks/audit
 *
 * @packageDocumentation
 */

import type { BrainHttp } from "../http/index.js";
import type { Components } from "../index.js";

type Schemas = Components["schemas"];
export type AuditEvent = Schemas["AuditEvent"];

export interface AuditListOptions {
  readonly tenantId?: string;
  readonly layer?: "raw" | "ledger" | "wiki" | "policy" | "agent" | "execution" | "audit";
  readonly actor?: string;
  /** Filter to a specific event_type (e.g. `"action.executed"`). */
  readonly eventType?: string;
  /** Inclusive lower bound. RFC 3339 / ISO 8601. */
  readonly from?: string;
  /** Exclusive upper bound. */
  readonly to?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** Result of a `proof` lookup — Merkle inclusion proof + on-chain anchor. */
export interface AuditProof {
  readonly event: AuditEvent;
  readonly merkle_path: readonly string[];
  readonly anchored_root: string;
  readonly base_tx_hash: string;
  readonly base_block: number;
  readonly batch_index: number;
}

export interface AuditExportOptions {
  readonly tenantId: string;
  /** Per docs/sdk-audit.md decision L. */
  readonly format: "jsonl" | "csv";
  readonly from: string;
  readonly to: string;
  readonly layers?: Array<"raw" | "wiki" | "policy" | "execution">;
}

export interface AuditExportStatus {
  readonly id: string;
  readonly state: "queued" | "running" | "ready" | "failed";
  readonly downloadUrl?: string;
  readonly expiresAt?: string;
}

export interface AuditVerifyInput {
  readonly eventHash: string;
  readonly merkleProof: readonly string[];
  readonly merkleRoot: string;
}

export interface AuditVerifyResult {
  readonly verified: boolean;
  readonly onchainBlock: number | null;
}

export class AuditModule {
  public constructor(private readonly http: BrainHttp) {}

  /**
   * Query audit events.
   *
   * Implements `GET /audit/events` (operationId `queryAuditEvents`).
   * The SDK accepts `from`/`to` per docs; the wire uses `since`/`until`.
   * @see https://docs.brain.fi/api-reference/audit-api
   */
  public async list(
    opts: AuditListOptions = {},
  ): Promise<{ events: AuditEvent[]; next_cursor: string | null }> {
    return this.http.get("/audit/events", {
      query: {
        tenantId: opts.tenantId,
        layer: opts.layer,
        actor: opts.actor,
        event_type: opts.eventType,
        since: opts.from,
        until: opts.to,
        limit: opts.limit,
        cursor: opts.cursor,
      },
    });
  }

  /**
   * Get a single event with its inclusion proof.
   *
   * Implements `GET /audit/event/{event_id}` (operationId `getAuditEvent`).
   */
  public async get(
    eventId: string,
  ): Promise<{ event: AuditEvent; inclusion_proof: AuditProof | null }> {
    return this.http.get(`/audit/event/${encodeURIComponent(eventId)}`);
  }

  /**
   * Every audit event touching a single entity (Ledger row, Action,
   * etc.), ordered ascending by `created_at`.
   *
   * Implements `GET /audit/entity/{entityType}/{entityId}` (operationId
   * `getAuditEntityHistory`). Backs the top-level `brain.trace(actionId)`
   * convenience.
   */
  public async byEntity(
    entityType:
      | "account"
      | "balance"
      | "transaction"
      | "counterparty"
      | "obligation"
      | "document"
      | "invoice"
      | "payment_intent"
      | "reconciliation_match"
      | "proposal"
      | "execution",
    entityId: string,
  ): Promise<{ entity_type: string; entity_id: string; events: AuditEvent[] }> {
    return this.http.get(
      `/audit/entity/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`,
    );
  }

  /**
   * Get the Merkle proof for an event. Returns the full proof bundle
   * suitable for off-line verification with `auditVerify`.
   *
   * Backs `brain.audit.proof(eventId)` and the top-level
   * `brain.proof(actionId)` convenience method. Docs call shape:
   * `brain.audit.proof(eventId)` (https://docs.brain.fi/sdks/audit).
   */
  public async proof(eventId: string): Promise<AuditProof> {
    return this.http.get<AuditProof>(`/audit/event/${encodeURIComponent(eventId)}/proof`);
  }

  /**
   * Request an async audit export job. Returns the job descriptor; poll
   * `exportStatus(id)` until `state === "ready"` and use the
   * `downloadUrl`.
   *
   * Implements `POST /audit/export` (operationId `exportAudit`).
   */
  public async export(opts: AuditExportOptions): Promise<{ job_id: string; status_url: string }> {
    return this.http.post("/audit/export", {
      tenantId: opts.tenantId,
      format: opts.format,
      since: opts.from,
      until: opts.to,
      ...(opts.layers !== undefined ? { layers: opts.layers } : {}),
    });
  }

  /**
   * Poll the status of an in-flight audit export job.
   *
   * Implements `GET /audit/export/{job_id}` (not yet in the spec — see
   * docs/sdk-audit.md §2.1 audit row; PLAN-FIRST item.)
   */
  public async exportStatus(jobId: string): Promise<AuditExportStatus> {
    return this.http.get<AuditExportStatus>(`/audit/export/${encodeURIComponent(jobId)}`);
  }

  /**
   * Verify an event's inclusion against an on-chain root. Public
   * endpoint — does not require authentication.
   *
   * Implements `POST /audit/verify` (operationId `verifyInclusion`).
   */
  public async verify(input: AuditVerifyInput): Promise<AuditVerifyResult> {
    const body = await this.http.post<{
      verified: boolean;
      onchain_block: number | null;
    }>("/audit/verify", {
      event_hash: input.eventHash,
      merkle_proof: input.merkleProof,
      merkle_root: input.merkleRoot,
    });
    return {
      verified: body.verified,
      onchainBlock: body.onchain_block,
    };
  }
}
