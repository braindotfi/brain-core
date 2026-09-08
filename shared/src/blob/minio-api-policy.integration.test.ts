import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectLegalHoldCommand,
  GetObjectTaggingCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  PutObjectLegalHoldCommand,
  PutObjectRetentionCommand,
  PutObjectTaggingCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.MINIO_API_POLICY_INTEGRATION === "true";
const describeIntegration = enabled ? describe : describe.skip;

describeIntegration("brain-api-artifacts-v1 MinIO policy", () => {
  const endpoint = process.env.MINIO_API_POLICY_ENDPOINT ?? "http://127.0.0.1:9000";
  const bucket = "brain-artifacts";
  const prefix = `tnt_api_policy_${randomUUID().replaceAll("-", "")}/`;
  const forbiddenBucket = `brain-api-forbidden-${randomUUID()}`;
  const api = client(
    endpoint,
    requiredEnv("MINIO_API_ACCESS_KEY_ID"),
    requiredEnv("MINIO_API_SECRET_ACCESS_KEY"),
  );
  const admin = client(
    endpoint,
    requiredEnv("MINIO_ROOT_USER"),
    requiredEnv("MINIO_ROOT_PASSWORD"),
  );

  beforeAll(async () => {
    await cleanupPrefix(admin, bucket, prefix);
    await admin.send(new CreateBucketCommand({ Bucket: forbiddenBucket }));
  });

  afterAll(async () => {
    await releaseHolds(admin, bucket, prefix);
    await cleanupPrefix(admin, bucket, prefix);
    await admin.send(new DeleteBucketCommand({ Bucket: forbiddenBucket }));
    api.destroy();
    admin.destroy();
  });

  it("allows the approved API object lifecycle", async () => {
    const key = `${prefix}raw/held`;
    const put = await api.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: Buffer.from("api scoped bytes"),
        ObjectLockLegalHoldStatus: "ON",
      }),
    );
    expect(put.VersionId).toBeDefined();

    const get = await api.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    expect(await streamToString(get.Body as NodeJS.ReadableStream)).toBe("api scoped bytes");

    await api.send(
      new PutObjectTaggingCommand({
        Bucket: bucket,
        Key: key,
        Tagging: { TagSet: [{ Key: "brain-tombstone", Value: "true" }] },
      }),
    );
    await api.send(
      new PutObjectLegalHoldCommand({
        Bucket: bucket,
        Key: key,
        VersionId: put.VersionId,
        LegalHold: { Status: "OFF" },
      }),
    );
  });

  it("denies operations outside the approved API policy", async () => {
    const key = `${prefix}denied/target`;
    const put = await api.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from("guarded") }),
    );
    expect(put.VersionId).toBeDefined();

    await expectAccessDenied(api.send(new ListBucketsCommand({})));
    await expectAccessDenied(
      api.send(new CreateBucketCommand({ Bucket: `forbidden-${randomUUID()}` })),
    );
    await expectAccessDenied(api.send(new DeleteBucketCommand({ Bucket: forbiddenBucket })));
    await expectAccessDenied(
      api.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix })),
    );
    await expectAccessDenied(
      api.send(
        new GetObjectLegalHoldCommand({ Bucket: bucket, Key: key, VersionId: put.VersionId }),
      ),
    );
    await expectAccessDenied(
      api.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key, VersionId: put.VersionId })),
    );
    await expectAccessDenied(
      api.send(
        new PutObjectRetentionCommand({
          Bucket: bucket,
          Key: key,
          VersionId: put.VersionId,
          Retention: {
            Mode: "GOVERNANCE",
            RetainUntilDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        }),
      ),
    );
    await expectAccessDenied(api.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })));
    await expectAccessDenied(
      api.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: put.VersionId })),
    );
    await expectAccessDenied(
      api.send(
        new PutObjectCommand({
          Bucket: forbiddenBucket,
          Key: key,
          Body: Buffer.from("forbidden"),
        }),
      ),
    );
  });
});

function client(endpoint: string, accessKeyId: string, secretAccessKey: string): S3Client {
  return new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (enabled && (value === undefined || value === "")) {
    throw new Error(`${name} is required for MinIO API policy integration tests`);
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

async function releaseHolds(client: S3Client, bucket: string, prefix: string): Promise<void> {
  const page = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }));
  for (const row of page.Versions ?? []) {
    if (row.Key === undefined || row.VersionId === undefined) continue;
    await client.send(
      new PutObjectLegalHoldCommand({
        Bucket: bucket,
        Key: row.Key,
        VersionId: row.VersionId,
        LegalHold: { Status: "OFF" },
      }),
    );
  }
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
      if (row.Key === undefined || row.VersionId === undefined) continue;
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
