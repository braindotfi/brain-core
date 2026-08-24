import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import { Client } from "pg";
import { AzureBlobAdapter, buildCredentialKeyProvider } from "@brain/shared";
import {
  assertMountedSecrets,
  assertServiceHealth,
  parseRoleEnvMap,
  requiredEnv,
  safeFailureCode,
} from "./azure-deploy-validation-lib.js";

interface GateResult {
  gate: string;
  ok: boolean;
  duration_ms: number;
  detail: string;
}

const results: GateResult[] = [];

async function gate(name: string, fn: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ gate: name, ok: true, duration_ms: Date.now() - started, detail });
  } catch (error) {
    results.push({
      gate: name,
      ok: false,
      duration_ms: Date.now() - started,
      detail: safeFailureCode(error),
    });
  }
}

interface ValidationRequestOptions {
  method?: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
}

async function fetchResponse(url: string, init?: ValidationRequestOptions): Promise<Response> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  return response;
}

async function fetchJson(url: string): Promise<{ response: Response; body: unknown }> {
  const response = await fetchResponse(url);
  if (!response.ok) throw new Error(`http_${response.status}`);
  return { response, body: await response.json() };
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function validateHttpSurfaces(expectedCommit: string): Promise<void> {
  const apiBase = requiredEnv("BRAIN_VALIDATION_API_BASE_URL");
  const authBase = requiredEnv("BRAIN_VALIDATION_AUTH_BASE_URL");
  const agentsBase = requiredEnv("BRAIN_VALIDATION_AGENTS_BASE_URL");
  const expectedIssuer = requiredEnv("AUTH_ISSUER");

  await gate("api", async () => {
    const { body } = await fetchJson(`${apiBase}/health`);
    assertServiceHealth(body, "brain-api", expectedCommit);
    return "health_and_release_identity";
  });

  await gate("auth", async () => {
    const [{ body: health }, { body: metadata }, { body: jwks }] = await Promise.all([
      fetchJson(`${authBase}/healthz`),
      fetchJson(`${authBase}/.well-known/oauth-authorization-server`),
      fetchJson(`${authBase}/.well-known/jwks.json`),
    ]);
    assertServiceHealth(health, "brain-auth", expectedCommit);
    const md = metadata as { issuer?: unknown; jwks_uri?: unknown };
    if (md.issuer !== expectedIssuer || md.jwks_uri !== `${expectedIssuer}/.well-known/jwks.json`) {
      throw new Error("auth_metadata_mismatch");
    }
    const keys = (jwks as { keys?: unknown }).keys;
    if (!Array.isArray(keys) || keys.length === 0) throw new Error("auth_jwks_empty");
    if (keys.some((key) => typeof key === "object" && key !== null && "d" in key)) {
      throw new Error("auth_jwks_contains_private_key");
    }
    return "health_metadata_jwks_and_release_identity";
  });

  await gate("agents", async () => {
    const { body } = await fetchJson(`${agentsBase}/health`);
    assertServiceHealth(body, "brain-agents", expectedCommit);
    return "internal_health_and_release_identity";
  });

  await gate("mcp", async () => {
    const { body: metadata } = await fetchJson(`${apiBase}/.well-known/oauth-protected-resource`);
    const authorizationServers = (metadata as { authorization_servers?: unknown })
      .authorization_servers;
    if (!Array.isArray(authorizationServers) || !authorizationServers.includes(expectedIssuer)) {
      throw new Error("mcp_discovery_mismatch");
    }
    const challenge = await fetchResponse(`${apiBase}/v1/agents/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "deploy-validation", method: "initialize" }),
    });
    if (challenge.status !== 401) throw new Error(`mcp_challenge_http_${challenge.status}`);
    if (!(challenge.headers.get("www-authenticate") ?? "").toLowerCase().includes("bearer")) {
      throw new Error("mcp_bearer_challenge_missing");
    }
    return "discovery_and_unauthenticated_boundary";
  });
}

async function validateRedis(runId: string): Promise<void> {
  await gate("managed_redis", async () => {
    const redisUrl = requiredEnv("REDIS_URL");
    if (new URL(redisUrl).protocol !== "rediss:") throw new Error("redis_tls_not_required");
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
    const key = `brain:deploy-validation:${runId}`;
    const queueName = `brain-deploy-validation-${runId}`;
    const value = randomBytes(16).toString("hex");
    let queue: Queue | undefined;
    let queueEvents: QueueEvents | undefined;
    let worker: Worker | undefined;
    let processed = 0;
    try {
      if ((await redis.ping()) !== "PONG") throw new Error("redis_ping_failed");
      if ((await redis.set(key, value, "PX", 30_000, "NX")) !== "OK") {
        throw new Error("redis_set_failed");
      }
      if ((await redis.get(key)) !== value) throw new Error("redis_get_mismatch");
      const ttl = await redis.pttl(key);
      if (ttl <= 0 || ttl > 30_000) throw new Error("redis_ttl_invalid");
      await redis.del(key);
      if ((await redis.get(key)) !== null) throw new Error("redis_delete_failed");

      const connection = redis.duplicate({ maxRetriesPerRequest: null });
      queue = new Queue(queueName, { connection });
      queueEvents = new QueueEvents(queueName, { connection: connection.duplicate() });
      worker = new Worker(
        queueName,
        async (job) => {
          processed += 1;
          return { nonce: (job.data as { nonce: string }).nonce };
        },
        { connection: connection.duplicate(), concurrency: 1 },
      );
      await Promise.all([
        queue.waitUntilReady(),
        queueEvents.waitUntilReady(),
        worker.waitUntilReady(),
      ]);
      const job = await queue.add("once", { nonce: value }, { jobId: `job-${runId}` });
      const completed = (await job.waitUntilFinished(queueEvents, 20_000)) as { nonce?: unknown };
      if (completed.nonce !== value || processed !== 1) throw new Error("bullmq_delivery_mismatch");
      return "tls_ping_ttl_cleanup_and_single_delivery";
    } finally {
      await redis.del(key).catch(() => undefined);
      await worker?.close().catch(() => undefined);
      await queue?.obliterate({ force: true }).catch(() => undefined);
      await queueEvents?.close().catch(() => undefined);
      await queue?.close().catch(() => undefined);
      redis.disconnect();
    }
  });
}

async function validateKeyVault(): Promise<void> {
  await gate("key_vault_mounted", async () => {
    const count = assertMountedSecrets(requiredEnv("BRAIN_VALIDATION_REQUIRED_SECRET_ENVS"));
    return `resolved_secret_count:${count}`;
  });

  await gate("key_vault_direct", async () => {
    const provider = buildCredentialKeyProvider({
      kmsVaultUrl: requiredEnv("BRAIN_AZURE_KEY_VAULT_URL"),
      kmsSecretName: requiredEnv("BRAIN_SOURCE_CREDENTIAL_KEY_VAULT_NAME"),
      envVarKey: undefined,
      envKeyId: "unused",
      nodeEnv: "production",
      allowUnencrypted: false,
    });
    if (provider.source !== "azure-key-vault") throw new Error("key_vault_provider_not_selected");
    const loaded = await provider.load();
    if (loaded === undefined || loaded.key.length !== 32) throw new Error("key_vault_key_invalid");
    loaded.key.fill(0);
    return "managed_identity_source_key_resolution";
  });
}

async function validateBlob(runId: string): Promise<void> {
  await gate("azure_blob", async () => {
    const adapter = new AzureBlobAdapter({
      accountName: requiredEnv("AZURE_BLOB_ACCOUNT_NAME"),
      accountKey: requiredEnv("AZURE_BLOB_ACCOUNT_KEY"),
      container: requiredEnv("BRAIN_VALIDATION_BLOB_CONTAINER"),
    });
    const path = `deploy-validation/${runId}/${randomBytes(12).toString("hex")}`;
    const body = randomBytes(64);
    try {
      const stored = await adapter.put(path, body, {
        contentType: "application/octet-stream",
        metadata: { purpose: "deploy-validation", run: runId },
        immutable: false,
      });
      const read = await readStream(await adapter.get(path));
      const digest = createHash("sha256").update(read).digest("hex");
      if (stored.sha256 !== digest || !read.equals(body)) throw new Error("blob_digest_mismatch");
      return "write_read_digest_and_cleanup";
    } finally {
      await adapter.purgeObject(path);
    }
  });
}

async function validatePostgres(): Promise<void> {
  await gate("postgres", async () => {
    const roles = parseRoleEnvMap(requiredEnv("BRAIN_VALIDATION_DB_ROLE_ENVS"));
    for (const [expectedRole, envName] of Object.entries(roles)) {
      const client = new Client({ connectionString: requiredEnv(envName) });
      try {
        await client.connect();
        const result = await client.query<{ current_user: string; ssl: boolean }>(
          `SELECT current_user, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl`,
        );
        if (result.rows[0]?.current_user !== expectedRole) throw new Error("postgres_wrong_role");
        if (result.rows[0]?.ssl !== true) throw new Error("postgres_tls_missing");
      } finally {
        await client.end().catch(() => undefined);
      }
    }

    const app = new Client({ connectionString: requiredEnv("DATABASE_URL") });
    try {
      await app.connect();
      const uncovered = await app.query<{ table_name: string }>(
        `SELECT c.relname AS table_name
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind = 'r'
            AND EXISTS (
              SELECT 1 FROM pg_attribute a
               WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
            )
            AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
          LIMIT 1`,
      );
      if (uncovered.rowCount !== 0) throw new Error("postgres_rls_gap");
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.tenant_id', $1, true)", [
        "tnt_00000000000000000000000000",
      ]);
      const isolated = await app.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger_accounts",
      );
      await app.query("ROLLBACK");
      if (isolated.rows[0]?.count !== "0") throw new Error("postgres_rls_isolation_failed");
    } finally {
      await app.query("ROLLBACK").catch(() => undefined);
      await app.end().catch(() => undefined);
    }

    const mcp = new Client({ connectionString: requiredEnv("BRAIN_MCP_READER_DB_URL") });
    try {
      await mcp.connect();
      await mcp.query("BEGIN");
      try {
        await mcp.query("UPDATE raw_artifacts SET bytes = bytes WHERE false");
        throw new Error("mcp_write_was_allowed");
      } catch (error) {
        if ((error as { code?: string }).code !== "42501") throw error;
      } finally {
        await mcp.query("ROLLBACK");
      }
    } finally {
      await mcp.end().catch(() => undefined);
    }
    return `tls_roles:${Object.keys(roles).length}:rls_and_mcp_read_only`;
  });
}

export async function main(): Promise<void> {
  const expectedCommit = requiredEnv("BRAIN_VALIDATION_EXPECTED_GIT_SHA");
  if (!/^[0-9a-f]{40}$/.test(expectedCommit)) throw new Error("expected_git_sha_not_full");
  const runId = requiredEnv("BRAIN_VALIDATION_RUN_ID");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(runId)) throw new Error("validation_run_id_invalid");

  await validateHttpSurfaces(expectedCommit);
  await validateRedis(runId);
  await validateKeyVault();
  await validateBlob(runId);
  await validatePostgres();

  for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`);
  const failed = results.filter((result) => !result.ok);
  process.stdout.write(
    `${JSON.stringify({ summary: "azure_deploy_validation", ok: failed.length === 0, gates: results.length, failed: failed.map((result) => result.gate) })}\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`azure deploy validation failed: ${safeFailureCode(error)}\n`);
    process.exitCode = 1;
  });
}
