/**
 * Wallet ↔ tenant identity store — RFC 0002 Phase D.
 *
 * A `wallet_identities` row links a wallet address to a (tenant, principal):
 * either a human owner (`user_…`) or an agent (`agent_…`). This is what will let
 * SIWX resolve a wallet to a human owner (Phase D-2), not just an agent — so a
 * tenant can authenticate with **either** email (Phase B login) **or** a linked
 * wallet, the "support both" model.
 *
 * `linkWallet` writes under `withTenantScope` (RLS WITH CHECK passes only for the
 * caller's tenant). The address is globally single-homed (PK), so a wallet
 * already linked anywhere → `wallet_already_linked` (409). The cross-tenant
 * `resolveByAddress` reader (for SIWX, which has no tenant context) uses the
 * brain_privileged pool — the same sanctioned entry point as the agent lookup.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  brainError,
  requireScope,
  withTenantScope,
  type Scope,
  type TenantScopedClient,
} from "@brain/shared";

export type WalletPrincipalType = "human" | "agent";

export interface WalletLinkInput {
  readonly tenantId: string;
  /** Wallet address; normalized to lowercase here. */
  readonly address: string;
  readonly principalType: WalletPrincipalType;
  /** `user_…` for a human, `agent_…` for an agent. */
  readonly principalId: string;
}

export interface ResolvedWalletIdentity {
  readonly tenantId: string;
  readonly principalType: WalletPrincipalType;
  readonly principalId: string;
}

const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * Link a wallet to a (tenant, principal). Idempotent-safe at the DB: a wallet
 * already linked (here or in any tenant) → `wallet_already_linked` (409), never a
 * silent re-home. Runs under the caller's tenant scope (RLS WITH CHECK).
 */
export async function linkWallet(pool: Pool, input: WalletLinkInput): Promise<void> {
  const address = input.address.toLowerCase();
  try {
    await withTenantScope(pool, input.tenantId, async (c: TenantScopedClient) => {
      await c.query(
        `INSERT INTO wallet_identities (address, tenant_id, principal_type, principal_id)
         VALUES ($1, $2, $3, $4)`,
        [address, input.tenantId, input.principalType, input.principalId],
      );
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw brainError("wallet_already_linked", "this wallet is already linked to an account");
    }
    throw err;
  }
}

/**
 * Resolve a wallet address to its (tenant, principal) across tenants. Uses the
 * brain_privileged (BYPASSRLS) pool — SIWX has no tenant context at sign-in, the
 * same sanctioned cross-tenant entry point as the address→agent lookup. Returns
 * null when the wallet is not linked.
 */
export class PostgresWalletIdentityReader {
  public constructor(private readonly privilegedPool: Pool) {}

  public async resolveByAddress(address: string): Promise<ResolvedWalletIdentity | null> {
    const { rows } = await this.privilegedPool.query<{
      tenant_id: string;
      principal_type: WalletPrincipalType;
      principal_id: string;
    }>(
      `SELECT tenant_id, principal_type, principal_id
         FROM wallet_identities
        WHERE address = LOWER($1)
        LIMIT 1`,
      [address],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      tenantId: row.tenant_id,
      principalType: row.principal_type,
      principalId: row.principal_id,
    };
  }
}

const linkBody = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  principal_type: z.enum(["human", "agent"]),
  principal_id: z.string().min(1).optional(),
});

/**
 * Authenticated link route — RFC 0002 Phase D.
 *
 *   POST /v1/tenants/:tenant_id/wallets  (owner JWT)
 *
 * Links a wallet to the caller's tenant. Tenant equality is enforced (the path
 * id must match the token's tenant), gated on a management scope. A human link
 * defaults to the calling owner (`principal.id`); an agent link must name the
 * agent id. Registered only when self-serve onboarding is enabled.
 */
export async function registerWalletRoutes(
  app: FastifyInstance,
  deps: { pool: Pool },
): Promise<void> {
  app.post(
    "/tenants/:tenant_id/wallets",
    async (req: FastifyRequest<{ Params: { tenant_id: string } }>, reply: FastifyReply) => {
      const principal = req.principal;
      if (principal === undefined) {
        throw brainError("auth_token_missing", "principal required");
      }
      if (req.params.tenant_id !== principal.tenantId) {
        throw brainError(
          "auth_tenant_mismatch",
          "tenant_id does not match the authenticated tenant",
        );
      }
      // Management capability — tenant owners carry policy:write.
      requireScope(principal.scopes, "policy:write" as Scope);

      const parsed = linkBody.safeParse(req.body);
      if (!parsed.success) {
        throw brainError(
          "request_body_invalid",
          "address (0x…40 hex) and principal_type are required",
        );
      }
      const principalType = parsed.data.principal_type;
      // Humans default to the calling owner; agents must name the agent id.
      const principalId =
        principalType === "human"
          ? (parsed.data.principal_id ?? principal.id)
          : parsed.data.principal_id;
      if (principalId === undefined || principalId.length === 0) {
        throw brainError("request_body_invalid", "principal_id is required for an agent link");
      }

      await linkWallet(deps.pool, {
        tenantId: principal.tenantId,
        address: parsed.data.address,
        principalType,
        principalId,
      });

      reply.status(201);
      return {
        linked: true,
        address: parsed.data.address.toLowerCase(),
        principal_type: principalType,
        principal_id: principalId,
      };
    },
  );
}
