import {
  CreateBucketCommand,
  DeleteObjectCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { S3BlobAdapter } from "./dist/blob/s3.js";

const required = (name) => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
};

if (Object.hasOwn(process.env, "MINIO_ROOT_USER")) {
  throw new Error("worker environment contains MINIO_ROOT_USER");
}
if (Object.hasOwn(process.env, "MINIO_ROOT_PASSWORD")) {
  throw new Error("worker environment contains MINIO_ROOT_PASSWORD");
}
if (Object.hasOwn(process.env, "MINIO_WORKER_ACCESS_KEY_ID")) {
  throw new Error("worker environment contains the host credential source name");
}
if (Object.hasOwn(process.env, "MINIO_WORKER_SECRET_ACCESS_KEY")) {
  throw new Error("worker environment contains the host credential source name");
}

const expectedSha = required("EXPECTED_SHA");
if (required("GIT_SHA") !== expectedSha) throw new Error("worker SHA does not match expected SHA");
if (required("S3_ACCESS_KEY_ID") !== "brain-worker") {
  throw new Error("worker does not use the managed brain-worker identity");
}

const bucket = required("BLOB_CONTAINER");
if (bucket !== "brain-artifacts") throw new Error("unexpected worker artifact bucket");
const endpoint = required("S3_ENDPOINT");
const tenantId = `tnt_worker_verify_${randomUUID().replaceAll("-", "")}`;
const prefix = `${tenantId}/`;
const client = new S3Client({
  endpoint,
  region: process.env.S3_REGION ?? "us-east-1",
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: {
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
  },
});
const blob = new S3BlobAdapter(
  {
    bucket,
    endpoint,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
  },
  client,
);

try {
  const heldPath = `${prefix}raw/held`;
  const exportPath = `${prefix}exports/out.ndjson`;
  const deniedPath = `${prefix}denied/target`;

  await blob.put(heldPath, Buffer.from("worker lifecycle held bytes"), {
    immutable: true,
    contentType: "application/octet-stream",
  });
  if ((await streamToString(await blob.get(heldPath))) !== "worker lifecycle held bytes") {
    throw new Error("scoped worker read did not round trip");
  }
  const manifest = await blob.inspectTenantLegalHolds(tenantId);
  if (!manifest.heldVersions.some((row) => row.path === heldPath)) {
    throw new Error("scoped worker could not inspect the legal hold");
  }
  await blob.releaseTenantLegalHolds(manifest);

  await blob.put(exportPath, Buffer.from("worker lifecycle export bytes"), {
    immutable: false,
    contentType: "application/x-ndjson",
  });
  await blob.purgeObject(exportPath);

  await blob.put(deniedPath, Buffer.from("denied operation fixture"), { immutable: false });
  await expectDenied(client.send(new ListBucketsCommand({})), "bucket listing");
  await expectDenied(
    client.send(new CreateBucketCommand({ Bucket: `forbidden-${randomUUID()}` })),
    "bucket creation",
  );
  await expectDenied(
    client.send(
      new PutObjectTaggingCommand({
        Bucket: bucket,
        Key: deniedPath,
        Tagging: { TagSet: [{ Key: "forbidden", Value: "true" }] },
      }),
    ),
    "object tagging",
  );
  await expectDenied(
    client.send(new DeleteObjectCommand({ Bucket: bucket, Key: deniedPath })),
    "unversioned deletion",
  );
  await expectDenied(
    client.send(
      new PutObjectCommand({
        Bucket: "brain-artifacts-forbidden",
        Key: deniedPath,
        Body: Buffer.from("forbidden"),
      }),
    ),
    "other-bucket write",
    ["AccessDenied", "NoSuchBucket"],
  );

  const purged = await blob.purgeTenant(tenantId);
  if (purged.failures.length !== 0 || purged.deleted !== 2) {
    throw new Error("scoped worker tenant purge did not delete the two remaining versions");
  }
  const remaining = await client.send(
    new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }),
  );
  if ((remaining.Versions?.length ?? 0) !== 0 || (remaining.DeleteMarkers?.length ?? 0) !== 0) {
    throw new Error("scoped worker lifecycle left object versions behind");
  }

  console.log("worker_identity=brain-worker");
  console.log("worker_root_environment=absent");
  console.log("worker_allowed_lifecycle=passed");
  console.log("worker_denied_operations=passed");
} finally {
  try {
    const manifest = await blob.inspectTenantLegalHolds(tenantId);
    if (manifest.heldVersions.length > 0) await blob.releaseTenantLegalHolds(manifest);
    await blob.purgeTenant(tenantId);
  } finally {
    client.destroy();
  }
}

async function expectDenied(request, operation, acceptedCodes = ["AccessDenied"]) {
  try {
    await request;
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    const code = error?.name ?? error?.Code;
    if ((status === 403 || status === 404) && acceptedCodes.includes(code)) return;
    throw new Error(`${operation} failed with an unexpected provider response`);
  }
  throw new Error(`${operation} was unexpectedly allowed`);
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
