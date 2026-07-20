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
import type {
  BlobAdapter,
  BlobObject,
  BlobPurgeFailure,
  BlobPurgeResult,
  PutOptions,
  SignedUrlOptions,
} from "./types.js";
import { sha256Hex } from "./types.js";
import { classifyBlobDeleteError } from "./purge-classify.js";

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

  public constructor(
    private readonly opts: AzureAdapterOptions,
    service?: BlobServiceClient,
  ) {
    if (service !== undefined) {
      // Injection seam for tests (a fake BlobServiceClient); production builds
      // the client from credentials below. No signing credential in this path.
      this.service = service;
      this.credential = undefined;
      return;
    }
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

  /**
   * NOTE: exercised only against a live Azure Storage account (blocked in the
   * unit sandbox). Lists every blob under `<tenantId>/` and deletes each; a
   * blob under the container immutable policy / legal hold throws and is
   * captured in `failed` rather than aborting the purge. The hold is NOT
   * released here — GDPR erasure of WORM-protected blobs is a deliberate,
   * audited legal-hold-release operation the worker routes from `failed`.
   */
  public async purgeTenant(tenantId: string): Promise<BlobPurgeResult> {
    const prefix = `${tenantId}/`;
    const container = this.containerClient();
    let deleted = 0;
    const failures: BlobPurgeFailure[] = [];
    // Permanent (GDPR Art. 17) erasure must remove every VERSION and SNAPSHOT,
    // not just the current blob — with versioning enabled a plain delete keeps
    // prior versions. Include both and delete each specific version/snapshot.
    for await (const blob of container.listBlobsFlat({
      prefix,
      includeVersions: true,
      includeSnapshots: true,
    })) {
      try {
        const blobClient = container.getBlobClient(blob.name);
        if (blob.versionId !== undefined) {
          await blobClient.withVersion(blob.versionId).delete();
        } else if (blob.snapshot !== undefined) {
          await blobClient.withSnapshot(blob.snapshot).delete();
        } else {
          await container.getBlockBlobClient(blob.name).delete({ deleteSnapshots: "include" });
        }
        deleted += 1;
      } catch (err) {
        // CLASSIFY rather than assume legal hold: ServerBusy / 503 / timeout must
        // be retried, only a real immutability policy (BlobImmutableDueToPolicy)
        // is terminal. The worker reads `category`/`retryable` to decide.
        const id = blob.versionId ?? blob.snapshot;
        const c = classifyBlobDeleteError(err);
        failures.push({
          path: id !== undefined ? `${blob.name}@${id}` : blob.name,
          category: c.category,
          retryable: c.retryable,
          ...(c.providerCode !== undefined ? { providerCode: c.providerCode } : {}),
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { deleted, failures };
  }

  public async purgeObject(path: string): Promise<void> {
    const container = this.containerClient();
    let foundVersionOrSnapshot = false;
    for await (const blob of container.listBlobsFlat({
      prefix: path,
      includeVersions: true,
      includeSnapshots: true,
    })) {
      if (blob.name !== path) continue;
      foundVersionOrSnapshot = true;
      const blobClient = container.getBlobClient(blob.name);
      if (blob.versionId !== undefined) {
        await blobClient.withVersion(blob.versionId).deleteIfExists();
      } else if (blob.snapshot !== undefined) {
        await blobClient.withSnapshot(blob.snapshot).deleteIfExists();
      } else {
        await container
          .getBlockBlobClient(blob.name)
          .deleteIfExists({ deleteSnapshots: "include" });
      }
    }
    if (!foundVersionOrSnapshot) {
      await container.getBlockBlobClient(path).deleteIfExists({ deleteSnapshots: "include" });
    }
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
