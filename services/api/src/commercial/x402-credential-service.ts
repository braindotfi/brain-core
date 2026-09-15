import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { newApiKeyId, withTenantScope, type Scope, type TenantScopedClient } from "@brain/shared";
import { hashApiKeySecret, type ApiKeyEnvironment } from "../production-tenancy/api-key-routes.js";

export const X402_KEY_PREFIX = Object.freeze({
  sandbox: "brain_xk_test_",
  live: "brain_xk_live_",
});
export const X402_KEY_MAX_DAYS = Object.freeze({ sandbox: 30, live: 90 });
export const X402_KEY_MAX_ROTATION_OVERLAP_HOURS = 24;

export const X402_LAUNCH_OPERATIONS = Object.freeze({
  listAccounts: "ledger:read",
  listTransactions: "ledger:read",
  listAuditEvents: "audit:read",
  "ledger.accounts.list": "ledger:read",
  "ledger.transactions.list": "ledger:read",
  "ledger.obligations.list": "ledger:read",
} satisfies Readonly<Record<string, Scope>>);

export type X402LaunchOperation = keyof typeof X402_LAUNCH_OPERATIONS;

export interface IssuedX402Credential {
  readonly id: string;
  readonly secret: string;
  readonly keyPrefix: string;
  readonly expiresAt: Date;
  readonly operationIds: readonly X402LaunchOperation[];
  readonly scopes: readonly Scope[];
}

export class X402CredentialService {
  constructor(
    private readonly pool: Pool,
    private readonly pepper: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issue(input: {
    readonly tenantId: string;
    readonly name: string;
    readonly environment: ApiKeyEnvironment;
    readonly operationIds: readonly X402LaunchOperation[];
  }): Promise<IssuedX402Credential> {
    const operations = validateOperations(input.operationIds);
    return withTenantScope(this.pool, input.tenantId, (client) =>
      this.insertCredential(client, { ...input, operationIds: operations }),
    );
  }

  async rotate(input: {
    readonly tenantId: string;
    readonly keyId: string;
    readonly overlapHours: number;
  }): Promise<IssuedX402Credential> {
    if (
      !Number.isInteger(input.overlapHours) ||
      input.overlapHours < 0 ||
      input.overlapHours > X402_KEY_MAX_ROTATION_OVERLAP_HOURS
    ) {
      throw new Error("x402 key rotation overlap must be an integer from 0 through 24 hours");
    }
    return withTenantScope(this.pool, input.tenantId, async (client) => {
      const old = await client.query<{
        id: string;
        name: string;
        environment: ApiKeyEnvironment;
        operation_id: X402LaunchOperation;
      }>(
        `SELECT k.id, k.name, k.environment, a.operation_id
           FROM api_keys k
           JOIN x402_api_key_operation_grants grant_row ON grant_row.api_key_id = k.id
           JOIN x402_seller_operation_allowlist a ON a.id = grant_row.operation_policy_id
          WHERE k.id = $1 AND k.tenant_id = $2
            AND k.credential_class = 'x402_pay_per_call'
            AND k.revoked_at IS NULL AND k.expires_at > now()
          FOR UPDATE OF k`,
        [input.keyId, input.tenantId],
      );
      if (old.rows.length === 0) throw new Error("x402 pay-per-call credential is not active");
      const first = old.rows[0]!;
      const cutoff = new Date(this.now().getTime() + input.overlapHours * 3_600_000);
      await client.query(
        `UPDATE api_keys
            SET expires_at = LEAST(expires_at, $2),
                revoked_at = CASE WHEN $3::integer = 0 THEN $2 ELSE revoked_at END
          WHERE id = $1`,
        [input.keyId, cutoff, input.overlapHours],
      );
      return this.insertCredential(client, {
        tenantId: input.tenantId,
        name: first.name,
        environment: first.environment,
        operationIds: validateOperations(old.rows.map((row) => row.operation_id)),
        rotatedFromId: input.keyId,
      });
    });
  }

  private async insertCredential(
    client: TenantScopedClient,
    input: {
      readonly tenantId: string;
      readonly name: string;
      readonly environment: ApiKeyEnvironment;
      readonly operationIds: readonly X402LaunchOperation[];
      readonly rotatedFromId?: string;
    },
  ): Promise<IssuedX402Credential> {
    const secret = `${X402_KEY_PREFIX[input.environment]}${randomBytes(32).toString("base64url")}`;
    const id = newApiKeyId();
    const createdAt = this.now();
    const expiresAt = new Date(
      createdAt.getTime() + X402_KEY_MAX_DAYS[input.environment] * 24 * 3_600_000,
    );
    const scopes = [...new Set(input.operationIds.map((id) => X402_LAUNCH_OPERATIONS[id]))];
    await client.query(
      `INSERT INTO api_keys (
         id, tenant_id, name, environment, scopes, key_prefix, key_last4,
         hashed_secret, expires_at, rotated_from_id, credential_class, created_at
       ) VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10,
                 'x402_pay_per_call', $11)`,
      [
        id,
        input.tenantId,
        input.name,
        input.environment,
        scopes,
        X402_KEY_PREFIX[input.environment],
        secret.slice(-4),
        hashApiKeySecret(secret, this.pepper),
        expiresAt,
        input.rotatedFromId ?? null,
        createdAt,
      ],
    );
    for (const operationId of input.operationIds) {
      const inserted = await client.query(
        `INSERT INTO x402_api_key_operation_grants (
           id, tenant_id, api_key_id, operation_policy_id, granted_at, expires_at
         )
         SELECT $1, $2, $3, id, $4, $5
           FROM x402_seller_operation_allowlist
          WHERE operation_id = $6
         RETURNING id`,
        [`x402grant_${randomUUID()}`, input.tenantId, id, createdAt, expiresAt, operationId],
      );
      if (inserted.rowCount !== 1) throw new Error(`unknown x402 operation ${operationId}`);
    }
    return {
      id,
      secret,
      keyPrefix: X402_KEY_PREFIX[input.environment],
      expiresAt,
      operationIds: input.operationIds,
      scopes,
    };
  }
}

export function validateOperations(values: readonly string[]): readonly X402LaunchOperation[] {
  const unique = [...new Set(values)];
  if (unique.length === 0 || unique.some((value) => !(value in X402_LAUNCH_OPERATIONS))) {
    throw new Error("x402 credential operations must be a nonempty subset of the launch allowlist");
  }
  return unique as X402LaunchOperation[];
}
