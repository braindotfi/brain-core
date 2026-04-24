/**
 * Azure Blob Storage adapter. Production substrate per §2.
 *
 * Immutability is enforced at the container level by an immutable blob
 * policy (stage-8 Terraform). A legal hold is applied per-blob when
 * PutOptions.immutable=true.
 */

import {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import type { BlobAdapter, BlobObject, PutOptions, SignedUrlOptions } from "./types.js";
import { sha256Hex } from "./types.js";

export interface AzureAdapterOptions {
  /** Azure Storage account name, e.g. "brainraw". */
  accountName: string;
  /** Account key. Prefer Managed Identity in prod; key is the local/staging path. */
  accountKey?: string;
  container: string;
}

export class AzureBlobAdapter implements BlobAdapter {
  private readonly service: BlobServiceClient;
  private readonly credential: StorageSharedKeyCredential | undefined;

  public constructor(private readonly opts: AzureAdapterOptions) {
    if (opts.accountKey !== undefined) {
      this.credential = new StorageSharedKeyCredential(opts.accountName, opts.accountKey);
      this.service = new BlobServiceClient(
        `https://${opts.accountName}.blob.core.windows.net`,
        this.credential,
      );
    } else {
      // Managed Identity path — expect an ambient DefaultAzureCredential. For
      // MVP we don't wire DAC here (keeps the package dep surface small);
      // stage-8 infra wires a token provider and instantiates via:
      //   new BlobServiceClient(url, new DefaultAzureCredential())
      // When that lands, we'll take an optional `credential` param rather
      // than reading from env here.
      throw new Error(
        "AzureBlobAdapter: accountKey required for now; Managed Identity wiring lands in stage-8",
      );
    }
  }

  private containerClient() {
    return this.service.getContainerClient(this.opts.container);
  }

  public async put(
    path: string,
    body: Uint8Array | NodeJS.ReadableStream,
    opts: PutOptions,
  ): Promise<BlobObject> {
    const buf = await toBuffer(body);
    const sha = sha256Hex(buf);
    const client = this.containerClient().getBlockBlobClient(path);

    await client.uploadData(buf, {
      ...(opts.contentType !== undefined
        ? { blobHTTPHeaders: { blobContentType: opts.contentType } }
        : {}),
      ...(opts.metadata !== undefined ? { metadata: { ...opts.metadata } } : {}),
    });

    if (opts.immutable === true) {
      // Legal hold requires container-level immutability policy (Terraform).
      // In local/staging without that policy, this call is a no-op rather
      // than failing the ingest.
      try {
        await client.setLegalHold(true);
      } catch {
        /* ignore — policy not configured on this container */
      }
    }

    return { uri: path, sha256: sha, bytes: buf.length, mimeType: opts.contentType };
  }

  public async get(path: string): Promise<NodeJS.ReadableStream> {
    const client = this.containerClient().getBlockBlobClient(path);
    const res = await client.download();
    if (res.readableStreamBody === undefined) {
      throw new Error(`azure-blob: empty body for ${path}`);
    }
    return res.readableStreamBody;
  }

  public async signedUrl(path: string, opts: SignedUrlOptions): Promise<string> {
    if (this.credential === undefined) {
      throw new Error("azure-blob: signed URLs require SharedKey credential for MVP");
    }
    const client = this.containerClient().getBlockBlobClient(path);
    const expiresOn = new Date(Date.now() + opts.expiresInSeconds * 1000);
    const sas = generateBlobSASQueryParameters(
      {
        containerName: this.opts.container,
        blobName: path,
        permissions: BlobSASPermissions.parse("r"),
        expiresOn,
        protocol: undefined,
      },
      this.credential,
    );
    return `${client.url}?${sas.toString()}`;
  }

  public async tombstone(path: string, by: string): Promise<void> {
    const client = this.containerClient().getBlockBlobClient(path);
    await client.setMetadata({
      tombstoned_at: new Date().toISOString(),
      tombstoned_by: by,
    });
  }

  public async healthcheck(): Promise<boolean> {
    try {
      await this.containerClient().getProperties();
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
