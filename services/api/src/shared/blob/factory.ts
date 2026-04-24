/**
 * Blob adapter factory. Selects Azure vs S3 vs in-memory based on config.
 */

import { AzureBlobAdapter } from "./azure.js";
import { MemoryBlobAdapter } from "./memory.js";
import { S3BlobAdapter } from "./s3.js";
import type { BlobAdapter } from "./types.js";

export type BlobBackend = "azure" | "s3" | "memory";

export interface BlobFactoryConfig {
  backend: BlobBackend;
  container: string; // Azure container name OR S3 bucket name
  // Azure-only:
  azureAccountName?: string;
  azureAccountKey?: string;
  // S3-only:
  s3Endpoint?: string;
  s3Region?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3ForcePathStyle?: boolean;
}

export function createBlobAdapter(cfg: BlobFactoryConfig): BlobAdapter {
  switch (cfg.backend) {
    case "azure":
      if (cfg.azureAccountName === undefined || cfg.azureAccountKey === undefined) {
        throw new Error("azure backend requires azureAccountName and azureAccountKey");
      }
      return new AzureBlobAdapter({
        accountName: cfg.azureAccountName,
        accountKey: cfg.azureAccountKey,
        container: cfg.container,
      });
    case "s3":
      return new S3BlobAdapter({
        bucket: cfg.container,
        ...(cfg.s3Endpoint !== undefined ? { endpoint: cfg.s3Endpoint } : {}),
        ...(cfg.s3Region !== undefined ? { region: cfg.s3Region } : {}),
        ...(cfg.s3AccessKeyId !== undefined ? { accessKeyId: cfg.s3AccessKeyId } : {}),
        ...(cfg.s3SecretAccessKey !== undefined ? { secretAccessKey: cfg.s3SecretAccessKey } : {}),
        ...(cfg.s3ForcePathStyle !== undefined ? { forcePathStyle: cfg.s3ForcePathStyle } : {}),
      });
    case "memory":
      return new MemoryBlobAdapter();
  }
}
