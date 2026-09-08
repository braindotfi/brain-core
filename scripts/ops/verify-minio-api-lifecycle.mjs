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

const required = (name) => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
};

for (const name of [
  "MINIO_ROOT_USER",
  "MINIO_ROOT_PASSWORD",
  "MINIO_API_ACCESS_KEY_ID",
  "MINIO_API_SECRET_ACCESS_KEY",
  "MINIO_WORKER_ACCESS_KEY_ID",
  "MINIO_WORKER_SECRET_ACCESS_KEY",
]) {
  if (Object.hasOwn(process.env, name)) {
    throw new Error(`API environment contains credential-source variable ${name}`);
  }
}

const expectedSha = required("EXPECTED_SHA");
if (required("GIT_SHA") !== expectedSha) throw new Error("API SHA does not match expected SHA");
if (required("S3_ACCESS_KEY_ID") !== "brain-api") {
  throw new Error("API does not use the managed brain-api identity");
}

const bucket = required("BLOB_CONTAINER");
if (bucket !== "brain-artifacts") throw new Error("unexpected API artifact bucket");
const prefix = required("VERIFY_PREFIX");
if (!/^tnt_api_verify_[0-9]+\/$/.test(prefix)) throw new Error("unsafe verification prefix");
const key = `${prefix}raw/held`;
const endpoint = required("S3_ENDPOINT");
const client = new S3Client({
  endpoint,
  region: process.env.S3_REGION ?? "us-east-1",
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: {
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
  },
});

try {
  const put = await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Buffer.from("API scoped lifecycle bytes"),
      ObjectLockLegalHoldStatus: "ON",
    }),
  );
  if (put.VersionId === undefined) throw new Error("API upload did not create a version");

  const get = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if ((await streamToString(get.Body)) !== "API scoped lifecycle bytes") {
    throw new Error("scoped API read did not round trip");
  }
  await client.send(
    new PutObjectTaggingCommand({
      Bucket: bucket,
      Key: key,
      Tagging: { TagSet: [{ Key: "brain-tombstone", Value: "true" }] },
    }),
  );
  await client.send(
    new PutObjectLegalHoldCommand({
      Bucket: bucket,
      Key: key,
      VersionId: put.VersionId,
      LegalHold: { Status: "OFF" },
    }),
  );

  await expectDenied(client.send(new ListBucketsCommand({})), "bucket listing");
  await expectDenied(
    client.send(new CreateBucketCommand({ Bucket: `brain-api-forbidden-${Date.now()}` })),
    "bucket creation",
  );
  await expectDenied(client.send(new DeleteBucketCommand({ Bucket: bucket })), "bucket deletion");
  await expectDenied(
    client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix })),
    "object version listing",
  );
  await expectDenied(
    client.send(
      new GetObjectLegalHoldCommand({ Bucket: bucket, Key: key, VersionId: put.VersionId }),
    ),
    "legal hold inspection",
  );
  await expectDenied(
    client.send(
      new GetObjectTaggingCommand({ Bucket: bucket, Key: key, VersionId: put.VersionId }),
    ),
    "tag inspection",
  );
  await expectDenied(
    client.send(
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
    "retention change",
  );
  await expectDenied(
    client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
    "unversioned deletion",
  );
  await expectDenied(
    client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: put.VersionId })),
    "version deletion",
  );
  await expectDenied(
    client.send(
      new PutObjectCommand({
        Bucket: "brain-artifacts-forbidden",
        Key: key,
        Body: Buffer.from("forbidden"),
      }),
    ),
    "other-bucket write",
    ["AccessDenied", "NoSuchBucket"],
  );

  console.log("api_identity=brain-api");
  console.log("api_root_environment=absent");
  console.log("api_allowed_lifecycle=passed");
  console.log("api_denied_operations=passed");
} finally {
  client.destroy();
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
