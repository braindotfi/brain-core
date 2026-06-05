/**
 * S3-compatible blob adapter (LocalStack, MinIO). Not used in production —
 * Azure Blob is the prod substrate per §2.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
  type ObjectLockLegalHoldStatus,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  BlobAdapter,
  BlobObject,
  BlobPurgeResult,
  PutOptions,
  SignedUrlOptions,
} from "./types.js";
import { sha256Hex } from "./types.js";

export interface S3AdapterOptions {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

export class S3BlobAdapter implements BlobAdapter {
  private readonly client: S3Client;
  public constructor(private readonly opts: S3AdapterOptions) {
    const cfg: S3ClientConfig = {
      ...(opts.region !== undefined ? { region: opts.region } : {}),
      ...(opts.endpoint !== undefined ? { endpoint: opts.endpoint } : {}),
      ...(opts.forcePathStyle !== undefined ? { forcePathStyle: opts.forcePathStyle } : {}),
      ...(opts.accessKeyId !== undefined && opts.secretAccessKey !== undefined
        ? {
            credentials: {
              accessKeyId: opts.accessKeyId,
              secretAccessKey: opts.secretAccessKey,
            },
          }
        : {}),
    };
    this.client = new S3Client(cfg);
  }

  public async put(
    path: string,
    body: Uint8Array | NodeJS.ReadableStream,
    opts: PutOptions,
  ): Promise<BlobObject> {
    const buf = await toBuffer(body);
    const sha = sha256Hex(buf);
    const legalHold: ObjectLockLegalHoldStatus | undefined =
      opts.immutable === true ? "ON" : undefined;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: path,
        Body: buf,
        ...(opts.contentType !== undefined ? { ContentType: opts.contentType } : {}),
        ...(opts.metadata !== undefined ? { Metadata: { ...opts.metadata } } : {}),
        ...(legalHold !== undefined ? { ObjectLockLegalHoldStatus: legalHold } : {}),
      }),
    );

    return { uri: path, sha256: sha, bytes: buf.length, mimeType: opts.contentType };
  }

  public async get(path: string): Promise<NodeJS.ReadableStream> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.opts.bucket, Key: path }),
    );
    if (res.Body === undefined) throw new Error(`s3: empty body for ${path}`);
    return res.Body as unknown as NodeJS.ReadableStream;
  }

  public async signedUrl(path: string, opts: SignedUrlOptions): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.opts.bucket, Key: path });
    return getSignedUrl(this.client, cmd, { expiresIn: opts.expiresInSeconds });
  }

  public async tombstone(path: string, by: string): Promise<void> {
    await this.client.send(
      new PutObjectTaggingCommand({
        Bucket: this.opts.bucket,
        Key: path,
        Tagging: {
          TagSet: [
            { Key: "tombstoned_at", Value: new Date().toISOString() },
            { Key: "tombstoned_by", Value: by },
          ],
        },
      }),
    );
  }

  /**
   * NOTE: exercised only against a live S3/LocalStack/MinIO bucket (blocked in
   * the unit sandbox). Lists every key under `<tenantId>/` (paginated) and
   * deletes them one by one so a per-object failure (object-lock / legal hold)
   * is captured in `failed` instead of aborting the whole purge. Legal holds
   * are NOT released here.
   */
  public async purgeTenant(tenantId: string): Promise<BlobPurgeResult> {
    const prefix = `${tenantId}/`;
    let deleted = 0;
    const failed: string[] = [];
    let continuationToken: string | undefined;
    do {
      const list = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.opts.bucket,
          Prefix: prefix,
          ...(continuationToken !== undefined ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const obj of list.Contents ?? []) {
        if (obj.Key === undefined) continue;
        try {
          await this.client.send(
            new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: obj.Key }),
          );
          deleted += 1;
        } catch {
          failed.push(obj.Key);
        }
      }
      continuationToken = list.IsTruncated === true ? list.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
    return { deleted, failed };
  }

  public async healthcheck(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
      return true;
    } catch {
      return false;
    }
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
