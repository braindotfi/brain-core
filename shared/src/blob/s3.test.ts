import { DeleteObjectCommand, ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { S3BlobAdapter } from "./s3.js";

function adapterWith(send: (command: unknown) => Promise<unknown>): S3BlobAdapter {
  return new S3BlobAdapter({ bucket: "brain-artifacts", region: "us-east-1" }, {
    send,
  } as unknown as S3Client);
}

describe("S3BlobAdapter versioned purge", () => {
  it("deletes an explicitly listed object version", async () => {
    const sent: unknown[] = [];
    const adapter = adapterWith(async (command) => {
      sent.push(command);
      if (command instanceof ListObjectVersionsCommand) {
        return {
          Versions: [{ Key: "tnt_test/exports/file", VersionId: "version-1" }],
          IsTruncated: false,
        };
      }
      return {};
    });

    await adapter.purgeObject("tnt_test/exports/file");

    const deletion = sent.find((command) => command instanceof DeleteObjectCommand);
    expect(deletion).toBeInstanceOf(DeleteObjectCommand);
    expect((deletion as DeleteObjectCommand).input).toMatchObject({
      Bucket: "brain-artifacts",
      Key: "tnt_test/exports/file",
      VersionId: "version-1",
    });
  });

  it("fails closed when a listed object has no version id", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ListObjectVersionsCommand) {
        return { Versions: [{ Key: "tnt_test/exports/file" }], IsTruncated: false };
      }
      return {};
    });
    const adapter = adapterWith(send);

    await expect(adapter.purgeObject("tnt_test/exports/file")).rejects.toThrow(
      "refusing unversioned purge",
    );
    expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(false);
  });

  it("fails closed when tenant purge receives a malformed version entry", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ListObjectVersionsCommand) {
        return { DeleteMarkers: [{ Key: "tnt_test/raw/file" }], IsTruncated: false };
      }
      return {};
    });
    const adapter = adapterWith(send);

    await expect(adapter.purgeTenant("tnt_test")).rejects.toThrow(
      "version listing returned an entry without Key or VersionId",
    );
    expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(false);
  });
});
