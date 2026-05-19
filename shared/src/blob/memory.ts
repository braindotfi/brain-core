/**
 * In-memory blob adapter. Test-only. Not exported beyond test utilities.
 */

import type { BlobAdapter, BlobObject, PutOptions, SignedUrlOptions } from "./types.js";
import { sha256Hex } from "./types.js";

interface MemoryObject {
  body: Buffer;
  contentType?: string;
  metadata: Record<string, string>;
  tombstoned: boolean;
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
    } = {
      body: buf,
      metadata: { ...(opts.metadata ?? {}) },
      tombstoned: false,
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
