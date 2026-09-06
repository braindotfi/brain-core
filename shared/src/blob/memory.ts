/**
 * In-memory blob adapter. Test-only. Not exported beyond test utilities.
 */

import type {
  BlobAdapter,
  BlobObject,
  BlobLegalHoldManifest,
  BlobPurgeResult,
  PutOptions,
  SignedUrlOptions,
} from "./types.js";
import { sha256Hex } from "./types.js";
import { assertBlobLegalHoldManifest, buildBlobLegalHoldManifest } from "./types.js";

interface MemoryObject {
  body: Buffer;
  contentType?: string;
  metadata: Record<string, string>;
  tombstoned: boolean;
  legalHold: boolean;
}

export class MemoryBlobAdapter implements BlobAdapter {
  public readonly objects = new Map<string, MemoryObject>();

  public async put(
    path: string,
    body: Uint8Array | NodeJS.ReadableStream,
    opts: PutOptions,
  ): Promise<BlobObject> {
    const buf = await toBuffer(body);
    const entry: {
      body: Buffer;
      contentType?: string;
      metadata: Record<string, string>;
      tombstoned: false;
      legalHold: boolean;
    } = {
      body: buf,
      metadata: { ...(opts.metadata ?? {}) },
      tombstoned: false,
      legalHold: opts.immutable === true,
    };
    if (opts.contentType !== undefined) {
      entry.contentType = opts.contentType;
    }
    this.objects.set(path, entry);
    return { uri: path, sha256: sha256Hex(buf), bytes: buf.length, mimeType: opts.contentType };
  }

  public async get(path: string): Promise<NodeJS.ReadableStream> {
    const obj = this.objects.get(path);
    if (obj === undefined) throw new Error(`memory-blob: missing ${path}`);
    const { Readable } = await import("node:stream");
    return Readable.from(obj.body);
  }

  public async signedUrl(path: string, opts: SignedUrlOptions): Promise<string> {
    return `memory://${path}?expires=${Date.now() + opts.expiresInSeconds * 1000}`;
  }

  public async tombstone(path: string, by: string): Promise<void> {
    const obj = this.objects.get(path);
    if (obj === undefined) return;
    obj.tombstoned = true;
    obj.metadata.tombstoned_at = new Date().toISOString();
    obj.metadata.tombstoned_by = by;
  }

  public async purgeTenant(tenantId: string): Promise<BlobPurgeResult> {
    const prefix = `${tenantId}/`;
    let deleted = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        if (this.objects.get(key)?.legalHold === true) {
          return {
            deleted,
            failures: [
              {
                path: key,
                category: "legal_hold",
                retryable: false,
                message: "memory object is under legal hold",
              },
            ],
          };
        }
        this.objects.delete(key);
        deleted += 1;
      }
    }
    return { deleted, failures: [] };
  }

  public async inspectTenantLegalHolds(tenantId: string): Promise<BlobLegalHoldManifest> {
    const prefix = `${tenantId}/`;
    const versions = [...this.objects.keys()]
      .filter((path) => path.startsWith(prefix))
      .sort()
      .map((path) => ({ path, versionId: null }));
    const heldVersions = versions.filter(({ path }) => this.objects.get(path)?.legalHold === true);
    return buildBlobLegalHoldManifest(tenantId, versions, heldVersions);
  }

  public async releaseTenantLegalHolds(manifest: BlobLegalHoldManifest): Promise<void> {
    assertBlobLegalHoldManifest(manifest);
    for (const { path } of manifest.heldVersions) {
      if (!path.startsWith(manifest.prefix)) throw new Error("legal-hold prefix escaped tenant");
      const object = this.objects.get(path);
      if (object !== undefined) object.legalHold = false;
    }
  }

  public async purgeObject(path: string): Promise<void> {
    this.objects.delete(path);
  }

  public async healthcheck(): Promise<boolean> {
    return true;
  }
}

async function toBuffer(body: Uint8Array | NodeJS.ReadableStream): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as string));
  }
  return Buffer.concat(chunks);
}
