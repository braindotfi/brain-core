/**
 * Brain blob storage adapter interface.
 *
 * Raw artifacts (§3 Layer 1) live in Azure Blob Storage with an immutable
 * blob policy in production. Local development targets LocalStack's S3
 * emulation via the S3-compatible adapter.
 *
 * Storage path: `<tenantId>/<yyyy>/<mm>/<dd>/<sha256>`. Always built via
 * `blobPath()` — never hand-concatenate.
 */

import { createHash } from "node:crypto";

export interface BlobObject {
  uri: string;
  sha256: string;
  bytes: number;
  mimeType: string | undefined;
}

export interface PutOptions {
  contentType?: string;
  metadata?: Readonly<Record<string, string>>;
  /** Request WORM/immutability semantics. Enforced in prod (Azure); LocalStack tags-only. */
  immutable?: boolean;
}

export interface SignedUrlOptions {
  /** Hard cap 10 minutes per OpenAPI spec for /raw/{raw_id}. */
  expiresInSeconds: number;
}

export interface BlobPurgeResult {
  /** Number of objects actually deleted under the tenant prefix. */
  deleted: number;
  /**
   * Paths that could NOT be deleted — typically WORM/legal-hold-protected
   * blobs. They are surfaced (not force-deleted) so a deliberate, audited
   * legal-hold-release runbook / dead-letter path handles them, rather than
   * this primitive silently undermining the immutability guarantee.
   */
  failed: string[];
}

export interface BlobAdapter {
  put(
    path: string,
    body: Uint8Array | NodeJS.ReadableStream,
    opts: PutOptions,
  ): Promise<BlobObject>;
  get(path: string): Promise<NodeJS.ReadableStream>;
  signedUrl(path: string, opts: SignedUrlOptions): Promise<string>;
  /** Tombstone — never deletes bytes (§3 Layer 1 immutability). Attaches metadata flag. */
  tombstone(path: string, by: string): Promise<void>;
  /**
   * GDPR Art. 17 erasure (R-02): permanently delete every object under the
   * `<tenantId>/` prefix. This is the ONLY sanctioned path that removes Raw
   * bytes — distinct from {@link tombstone}, which preserves them — and runs
   * only on tenant deletion, via a privileged worker. It does NOT force-release
   * a legal hold / immutable policy (that would undermine WORM); such blobs are
   * returned in {@link BlobPurgeResult.failed} for the legal-hold-release
   * runbook. Idempotent: a re-run after partial success deletes the remainder.
   */
  purgeTenant(tenantId: string): Promise<BlobPurgeResult>;
  healthcheck(): Promise<boolean>;
}

export function blobPath(tenantId: string, sha256Hex: string, at: Date = new Date()): string {
  const yyyy = at.getUTCFullYear().toString().padStart(4, "0");
  const mm = (at.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = at.getUTCDate().toString().padStart(2, "0");
  return `${tenantId}/${yyyy}/${mm}/${dd}/${sha256Hex}`;
}

export function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}
