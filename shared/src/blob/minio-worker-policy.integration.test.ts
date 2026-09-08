import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3BlobAdapter } from "./s3.js";

const enabled = process.env.MINIO_WORKER_POLICY_INTEGRATION === "true";
const describeIntegration = enabled ? describe : describe.skip;

describeIntegration("brain-worker-artifacts-v1 MinIO policy", () => {
  const endpoint = process.env.MINIO_WORKER_POLICY_ENDPOINT ?? "http://127.0.0.1:9000";
  const bucket = "brain-artifacts";
  const tenantId = `tnt_policy_${randomUUID().replaceAll("-", "")}`;
  const prefix = `${tenantId}/`;
  const forbiddenBucket = `brain-worker-forbidden-${randomUUID()}`;
  const worker = new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: requiredEnv("MINIO_WORKER_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("MINIO_WORKER_SECRET_ACCESS_KEY"),
    },
  });
  const admin = new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: requiredEnv("MINIO_ROOT_USER"),
      secretAccessKey: requiredEnv("MINIO_ROOT_PASSWORD"),
    },
  });
  const adapter = new S3BlobAdapter(
    {
      bucket,
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      accessKeyId: requiredEnv("MINIO_WORKER_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("MINIO_WORKER_SECRET_ACCESS_KEY"),
    },
    worker,
  );

  beforeAll(async () => {
    await cleanupPrefix(admin, bucket, prefix);
    await admin.send(new CreateBucketCommand({ Bucket: forbiddenBucket }));
  });

  afterAll(async () => {
    await cleanupPrefix(admin, bucket, prefix);
    await admin.send(new DeleteBucketCommand({ Bucket: forbiddenBucket }));
    worker.destroy();
    admin.destroy();
  });

  it("allows the complete versioned worker lifecycle", async () => {
    const heldPath = `${prefix}raw/held`;
    const exportPath = `${prefix}exports/out.ndjson`;

    await adapter.put(heldPath, Buffer.from("held bytes"), {
      immutable: true,
      contentType: "application/octet-stream",
    });
    const bytes = await streamToString(await adapter.get(heldPath));
    expect(bytes).toBe("held bytes");

    const manifest = await adapter.inspectTenantLegalHolds(tenantId);
    expect(manifest.heldVersions.map((row) => row.path)).toContain(heldPath);
    await adapter.releaseTenantLegalHolds(manifest);

    await adapter.put(exportPath, Buffer.from("export bytes"), {
      immutable: false,
      contentType: "application/x-ndjson",
    });
    await adapter.purgeObject(exportPath);
    await expect(adapter.get(exportPath)).rejects.toBeDefined();

    const purged = await adapter.purgeTenant(tenantId);
    expect(purged.failures).toEqual([]);
    expect(purged.deleted).toBe(1);

    const remaining = await worker.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }),
    );
    expect(remaining.Versions ?? []).toHaveLength(0);
    expect(remaining.DeleteMarkers ?? []).toHaveLength(0);
  });

  it("denies permissions outside the approved worker lifecycle", async () => {
    const objectPath = `${prefix}denied/target`;
    await adapter.put(objectPath, Buffer.from("guarded"), { immutable: false });

    await expectAccessDenied(worker.send(new ListBucketsCommand({})));
    await expectAccessDenied(
      worker.send(new CreateBucketCommand({ Bucket: `forbidden-${randomUUID()}` })),
    );
    await expectAccessDenied(worker.send(new DeleteBucketCommand({ Bucket: forbiddenBucket })));
    await expectAccessDenied(
      worker.send(
        new PutObjectTaggingCommand({
          Bucket: bucket,
          Key: objectPath,
          Tagging: { TagSet: [{ Key: "forbidden", Value: "true" }] },
        }),
      ),
    );
    await expectAccessDenied(
      worker.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectPath })),
    );
    await expectAccessDenied(
      worker.send(
        new PutObjectCommand({
          Bucket: forbiddenBucket,
          Key: objectPath,
          Body: Buffer.from("forbidden"),
        }),
      ),
    );

    const retainedPath = `${prefix}denied/governance-retained`;
    const retained = await admin.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: retainedPath,
        Body: Buffer.from("retained"),
        ObjectLockMode: "GOVERNANCE",
        ObjectLockRetainUntilDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }),
    );
    expect(retained.VersionId).toBeDefined();
    await expectAccessDenied(
      worker.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: retainedPath,
          VersionId: retained.VersionId,
          BypassGovernanceRetention: true,
        }),
      ),
    );

    await adapter.purgeObject(objectPath);
  });
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (enabled && (value === undefined || value === "")) {
    throw new Error(`${name} is required for MinIO worker policy integration tests`);
  }
  return value ?? "integration-disabled";
}

async function expectAccessDenied(request: Promise<unknown>): Promise<void> {
  try {
    await request;
  } catch (error) {
    const record = error as {
      name?: unknown;
      Code?: unknown;
      $metadata?: { httpStatusCode?: number };
    };
    expect([record.name, record.Code]).toContain("AccessDenied");
    expect(record.$metadata?.httpStatusCode).toBe(403);
    return;
  }
  throw new Error("expected MinIO request to be denied");
}

async function cleanupPrefix(client: S3Client, bucket: string, prefix: string): Promise<void> {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix,
        ...(keyMarker !== undefined ? { KeyMarker: keyMarker } : {}),
        ...(versionIdMarker !== undefined ? { VersionIdMarker: versionIdMarker } : {}),
      }),
    );
    for (const row of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
      if (row.Key === undefined || row.VersionId === undefined) {
        throw new Error("cleanup received an unversioned MinIO entry");
      }
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: row.Key,
          VersionId: row.VersionId,
          BypassGovernanceRetention: true,
        }),
      );
    }
    keyMarker = page.IsTruncated === true ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated === true ? page.NextVersionIdMarker : undefined;
  } while (keyMarker !== undefined || versionIdMarker !== undefined);
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}
