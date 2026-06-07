/**
 * Version-aware permanent erasure tests for the cloud blob adapters (GDPR Art. 17).
 *
 * A plain DeleteObject (S3) / blob delete (Azure) in a versioned store only
 * tombstones the current version — prior versions survive and are recoverable,
 * which is NOT erasure. These tests drive the adapters through injected fake
 * clients and assert every version + delete-marker / snapshot is deleted by its
 * specific id, and that lock/immutability failures are surfaced (not swallowed).
 */

import { describe, expect, it, vi } from "vitest";
import { DeleteObjectCommand, ListObjectVersionsCommand, type S3Client } from "@aws-sdk/client-s3";
import type { BlobServiceClient } from "@azure/storage-blob";
import { S3BlobAdapter } from "./s3.js";
import { AzureBlobAdapter } from "./azure.js";

describe("S3BlobAdapter.purgeTenant — version-aware", () => {
  function fakeS3(opts: { lock?: string[]; transient?: string[] } = {}): {
    client: S3Client;
    deletedVersions: string[];
  } {
    const deletedVersions: string[] = [];
    let listCalls = 0;
    const pages = [
      {
        IsTruncated: true,
        NextKeyMarker: "k1",
        NextVersionIdMarker: "v-mark",
        Versions: [
          { Key: "tnt_a/doc", VersionId: "v1" },
          { Key: "tnt_a/doc", VersionId: "v2" },
        ],
        DeleteMarkers: [{ Key: "tnt_a/doc", VersionId: "dm1" }],
      },
      {
        IsTruncated: false,
        Versions: [{ Key: "tnt_a/img", VersionId: "v3" }],
        DeleteMarkers: [],
      },
    ];
    const send = vi.fn((cmd: unknown) => {
      if (cmd instanceof ListObjectVersionsCommand) {
        return Promise.resolve(pages[listCalls++]);
      }
      if (cmd instanceof DeleteObjectCommand) {
        const { Key, VersionId } = cmd.input;
        const id = `${Key}@${VersionId}`;
        if (opts.lock?.includes(id)) return Promise.reject(new Error("object locked"));
        if (opts.transient?.includes(id)) {
          return Promise.reject(
            Object.assign(new Error("please slow down"), {
              name: "SlowDown",
              $metadata: { httpStatusCode: 503 },
            }),
          );
        }
        deletedVersions.push(id);
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    return { client: { send } as unknown as S3Client, deletedVersions };
  }

  it("deletes every version AND delete marker, across pagination, by VersionId", async () => {
    const { client, deletedVersions } = fakeS3();
    const adapter = new S3BlobAdapter({ bucket: "b" }, client);
    const res = await adapter.purgeTenant("tnt_a");
    expect(res.deleted).toBe(4);
    expect(res.failures).toEqual([]);
    expect(deletedVersions.sort()).toEqual(
      ["tnt_a/doc@dm1", "tnt_a/doc@v1", "tnt_a/doc@v2", "tnt_a/img@v3"].sort(),
    );
  });

  it("surfaces object-lock / legal-hold protected versions as a terminal legal_hold failure", async () => {
    const { client } = fakeS3({ lock: ["tnt_a/doc@v2"] });
    const adapter = new S3BlobAdapter({ bucket: "b" }, client);
    const res = await adapter.purgeTenant("tnt_a");
    expect(res.deleted).toBe(3);
    expect(res.failures.map((f) => f.path)).toEqual(["tnt_a/doc@v2"]);
    // An object-lock error is classified terminal (not retried).
    expect(res.failures[0]).toMatchObject({ category: "legal_hold", retryable: false });
  });

  it("classifies a 503/SlowDown as transient (retryable), NOT a legal hold", async () => {
    const { client } = fakeS3({ transient: ["tnt_a/doc@v2"] });
    const adapter = new S3BlobAdapter({ bucket: "b" }, client);
    const res = await adapter.purgeTenant("tnt_a");
    expect(res.deleted).toBe(3);
    expect(res.failures[0]).toMatchObject({
      path: "tnt_a/doc@v2",
      category: "transient",
      retryable: true,
      providerCode: "SlowDown",
    });
  });
});

describe("AzureBlobAdapter.purgeTenant — version-aware", () => {
  interface BlobItem {
    name: string;
    versionId?: string;
    snapshot?: string;
  }

  function fakeAzure(
    items: BlobItem[],
    opts: { lock?: string[] } = {},
  ): { service: BlobServiceClient; deleted: string[]; listOpts: unknown[] } {
    const deleted: string[] = [];
    const listOpts: unknown[] = [];
    const del = (id: string) => {
      if (opts.lock?.includes(id)) return Promise.reject(new Error("immutability policy"));
      deleted.push(id);
      return Promise.resolve({});
    };
    const container = {
      listBlobsFlat: (o: unknown) => {
        listOpts.push(o);
        return (async function* () {
          for (const it of items) yield it;
        })();
      },
      getBlobClient: (name: string) => ({
        withVersion: (v: string) => ({ delete: () => del(`${name}@${v}`) }),
        withSnapshot: (s: string) => ({ delete: () => del(`${name}#${s}`) }),
      }),
      getBlockBlobClient: (name: string) => ({ delete: () => del(name) }),
    };
    const service = {
      getContainerClient: () => container,
    } as unknown as BlobServiceClient;
    return { service, deleted, listOpts };
  }

  it("requests versions + snapshots and deletes each by its specific id", async () => {
    const { service, deleted, listOpts } = fakeAzure([
      { name: "tnt_a/doc", versionId: "v1" },
      { name: "tnt_a/doc", versionId: "v2" },
      { name: "tnt_a/doc", snapshot: "2026-01-01T00:00:00Z" },
      { name: "tnt_a/cur" },
    ]);
    const adapter = new AzureBlobAdapter({ accountName: "a", container: "c" }, service);
    const res = await adapter.purgeTenant("tnt_a");
    expect(res.deleted).toBe(4);
    expect(res.failures).toEqual([]);
    expect(deleted).toEqual([
      "tnt_a/doc@v1",
      "tnt_a/doc@v2",
      "tnt_a/doc#2026-01-01T00:00:00Z",
      "tnt_a/cur",
    ]);
    expect(listOpts[0]).toMatchObject({ includeVersions: true, includeSnapshots: true });
  });

  it("surfaces immutability / legal-hold failures (keyed by version) as terminal legal_hold", async () => {
    const { service } = fakeAzure([{ name: "tnt_a/doc", versionId: "v1" }], {
      lock: ["tnt_a/doc@v1"],
    });
    const adapter = new AzureBlobAdapter({ accountName: "a", container: "c" }, service);
    const res = await adapter.purgeTenant("tnt_a");
    expect(res.deleted).toBe(0);
    expect(res.failures.map((f) => f.path)).toEqual(["tnt_a/doc@v1"]);
    expect(res.failures[0]).toMatchObject({ category: "legal_hold", retryable: false });
  });
});
