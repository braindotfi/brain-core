import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AuditEmitter } from "@brain/shared";

export interface EvidenceBlobPutResult {
  storageRef: string;
  sha256: string;
  byteSize: number;
}

export interface EvidenceBlobStore {
  put(body: Buffer, input: { tenantId: string; mimeType: string }): Promise<EvidenceBlobPutResult>;
  get(storageRef: string): Promise<Buffer>;
  signedUrl(storageRef: string, expiresInSeconds: number): Promise<string>;
}

export class InMemoryEvidenceBlobStore implements EvidenceBlobStore {
  public readonly objects = new Map<string, Buffer>();

  public async put(body: Buffer): Promise<EvidenceBlobPutResult> {
    const sha256 = sha256Hex(body);
    const storageRef = storageRefForSha(sha256);
    this.objects.set(storageRef, Buffer.from(body));
    return { storageRef, sha256, byteSize: body.length };
  }

  public async get(storageRef: string): Promise<Buffer> {
    const body = this.objects.get(storageRef);
    if (body === undefined) throw new Error(`evidence blob missing: ${storageRef}`);
    return Buffer.from(body);
  }

  public async signedUrl(storageRef: string, expiresInSeconds: number): Promise<string> {
    return `memory://${storageRef}?expires=${Date.now() + expiresInSeconds * 1000}`;
  }
}

export class LocalDiskEvidenceBlobStore implements EvidenceBlobStore {
  public constructor(private readonly rootDir: string) {}

  public async put(body: Buffer): Promise<EvidenceBlobPutResult> {
    const sha256 = sha256Hex(body);
    const storageRef = storageRefForSha(sha256);
    const target = this.pathFor(storageRef);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, { flag: "wx" }).catch(async (err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
      throw err;
    });
    return { storageRef, sha256, byteSize: body.length };
  }

  public async get(storageRef: string): Promise<Buffer> {
    return readFile(this.pathFor(storageRef));
  }

  public async signedUrl(storageRef: string): Promise<string> {
    return `file://${this.pathFor(storageRef)}`;
  }

  private pathFor(storageRef: string): string {
    const sha = shaFromStorageRef(storageRef);
    return path.join(this.rootDir, sha.slice(0, 2), sha.slice(2, 4), sha);
  }
}

export class TodoEvidenceBlobStore implements EvidenceBlobStore {
  public constructor(private readonly backend: "s3" | "gcs") {}

  public async put(): Promise<EvidenceBlobPutResult> {
    throw new Error(`${this.backend} evidence blob store is not implemented`);
  }

  public async get(): Promise<Buffer> {
    throw new Error(`${this.backend} evidence blob store is not implemented`);
  }

  public async signedUrl(): Promise<string> {
    throw new Error(`${this.backend} evidence blob store is not implemented`);
  }
}

export interface S3EvidenceBlobStoreOptions {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly region: string;
  readonly tenantId?: string;
  readonly audit?: AuditEmitter;
}

export class S3EvidenceBlobStore implements EvidenceBlobStore {
  private readonly client: S3Client;
  private readonly fallback = new InMemoryEvidenceBlobStore();

  public constructor(private readonly opts: S3EvidenceBlobStoreOptions) {
    this.client = new S3Client({
      region: opts.region,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
    });
  }

  public async put(
    body: Buffer,
    input: { tenantId: string; mimeType: string },
  ): Promise<EvidenceBlobPutResult> {
    const started = Date.now();
    const sha256 = sha256Hex(body);
    const key = `${input.tenantId}/evidence/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
    const storageRef = `s3://${this.opts.bucket}/${key}`;
    try {
      await retryS3(() =>
        this.client.send(
          new PutObjectCommand({
            Bucket: this.opts.bucket,
            Key: key,
            Body: body,
            ContentType: input.mimeType,
            ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
            Metadata: {
              retention: "standard",
              sha256,
            },
          }),
        ),
      );
      await this.audit("put", input.tenantId, started, true);
      return { storageRef, sha256, byteSize: body.length };
    } catch {
      await this.audit("put", input.tenantId, started, false);
      return this.fallback.put(body);
    }
  }

  public async get(storageRef: string): Promise<Buffer> {
    const started = Date.now();
    const key = s3KeyFromStorageRef(storageRef, this.opts.bucket);
    try {
      const result = await retryS3(() =>
        this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key })),
      );
      if (result.Body === undefined) throw new Error(`evidence blob missing: ${storageRef}`);
      const chunks: Buffer[] = [];
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      await this.audit("get", this.opts.tenantId, started, true);
      return Buffer.concat(chunks);
    } catch {
      await this.audit("get", this.opts.tenantId, started, false);
      return this.fallback.get(storageRef);
    }
  }

  public async signedUrl(storageRef: string, expiresInSeconds: number): Promise<string> {
    const started = Date.now();
    try {
      const url = await retryS3(() =>
        getSignedUrl(
          this.client,
          new GetObjectCommand({
            Bucket: this.opts.bucket,
            Key: s3KeyFromStorageRef(storageRef, this.opts.bucket),
          }),
          { expiresIn: expiresInSeconds },
        ),
      );
      await this.audit("signedUrl", this.opts.tenantId, started, true);
      return url;
    } catch {
      await this.audit("signedUrl", this.opts.tenantId, started, false);
      return this.fallback.signedUrl(storageRef, expiresInSeconds);
    }
  }

  private async audit(
    operation: string,
    tenantId: string | undefined,
    started: number,
    success: boolean,
  ): Promise<void> {
    if (tenantId === undefined || this.opts.audit === undefined) return;
    await this.opts.audit.emit({
      tenantId,
      layer: "execution",
      actor: "system_provider_adapter",
      action: "adapter.call",
      inputs: { adapter_kind: "blob", provider: "s3", operation },
      outputs: { provider: "s3", latency_ms: Date.now() - started, success },
      outcome: success ? "allow" : "warn",
    });
  }
}

export function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function storageRefForSha(sha256: string): string {
  return `sha256://${sha256}`;
}

function shaFromStorageRef(storageRef: string): string {
  const match = /^sha256:\/\/([0-9a-f]{64})$/.exec(storageRef);
  if (match === null) throw new Error(`invalid evidence storage ref: ${storageRef}`);
  return match[1]!;
}

function s3KeyFromStorageRef(storageRef: string, bucket: string): string {
  const prefix = `s3://${bucket}/`;
  if (!storageRef.startsWith(prefix))
    throw new Error(`invalid evidence storage ref: ${storageRef}`);
  return storageRef.slice(prefix.length);
}

async function retryS3<T>(call: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
  throw lastErr;
}
