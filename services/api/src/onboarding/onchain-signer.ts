/**
 * Tenant on-chain signer designation -- RFC 0002 Phase C, increment 4 (tier 2).
 *
 * `POST /v1/tenants/:tenant_id/onchain-signer` lets a tenant name the address
 * that will sign its own BrainMCPAgentRegistry attestations
 * (`attestation_mode: "tenant_signed"`). This is an OFF-CHAIN designation
 * only -- the address is not seated as a registry signer until
 * TenantSignedRegistrationRelayer's phase 1 bootstrap transaction runs
 * (see docs/contracts/production-agents.md).
 *
 * Two independent proofs are required before an address can be designated,
 * because `wallet_identities` answers "which principal is this wallet" and
 * that alone must NOT make an address a registry signer:
 *
 *   1. The address must already be linked to this tenant in
 *      `wallet_identities` (POST /v1/tenants/{tenant_id}/wallets).
 *   2. The caller must submit a FRESH SIWX proof (a brand-new EIP-4361
 *      signature, verified the same way sign-in verifies one) over the
 *      exact address being designated -- an old login session cannot
 *      silently authorize a new registry-signer designation.
 *
 * Own-tenant only, user-principal only: an agent token, or a token for a
 * different tenant than the path, is rejected before either proof is
 * checked.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { z } from "zod";
import {
  brainError,
  requireScope,
  withTenantScope,
  type AuditEmitter,
  type Scope,
  type TenantScopedClient,
} from "@brain/shared";
import { verifySiwxProof } from "../auth/siwx.js";

const designateBody = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  message: z.string().min(1),
  signature: z.string().min(1),
  session_id: z.string().min(1).optional(),
});

export interface OnchainSignerRoutesDeps {
  pool: Pool;
  audit: AuditEmitter;
  redis: Redis;
  /** EIP-4361 `domain` claim -- must match registerSiwxRoutes' domain. Defaults to "api.brain.fi". */
  domain?: string;
}

async function isWalletLinkedToTenant(
  pool: Pool,
  tenantId: string,
  address: string,
): Promise<boolean> {
  const rows = await withTenantScope(pool, tenantId, async (c: TenantScopedClient) => {
    const res = await c.query<{ address: string }>(
      `SELECT address FROM wallet_identities WHERE tenant_id = $1 AND address = LOWER($2) LIMIT 1`,
      [tenantId, address],
    );
    return res.rows;
  });
  return rows.length > 0;
}

/**
 * `POST /v1/tenants/:tenant_id/onchain-signer` (owner JWT).
 *
 * Requires `policy:write` (the tenant-owner management scope) and a
 * user-principal token for the caller's own tenant. See the module doc
 * above for the two proofs required before the designation is stored.
 */
export async function registerOnchainSignerRoutes(
  app: FastifyInstance,
  deps: OnchainSignerRoutesDeps,
): Promise<void> {
  const domain = deps.domain ?? "api.brain.fi";

  app.post(
    "/tenants/:tenant_id/onchain-signer",
    async (req: FastifyRequest<{ Params: { tenant_id: string } }>, reply: FastifyReply) => {
      const principal = req.principal;
      if (principal === undefined) {
        throw brainError("auth_token_missing", "principal required");
      }
      if (principal.type !== "user") {
        throw brainError(
          "auth_scope_insufficient",
          "on-chain signer designation requires a user (owner) principal, not an agent token",
        );
      }
      if (req.params.tenant_id !== principal.tenantId) {
        throw brainError(
          "auth_tenant_mismatch",
          "tenant_id does not match the authenticated tenant",
        );
      }
      requireScope(principal.scopes, "policy:write" as Scope);

      const parsed = designateBody.safeParse(req.body);
      if (!parsed.success) {
        throw brainError(
          "request_body_invalid",
          "address (0x…40 hex), message, and signature are required",
        );
      }
      const address = parsed.data.address.toLowerCase();

      // Proof 1: the address must already be a known wallet of THIS tenant.
      const linked = await isWalletLinkedToTenant(deps.pool, principal.tenantId, address);
      if (!linked) {
        throw brainError(
          "onchain_signer_wallet_not_linked",
          "the address must already be linked to this tenant via " +
            "POST /v1/tenants/{tenant_id}/wallets before it can be designated as the on-chain signer",
        );
      }

      // Proof 2: a fresh SIWX proof of current key control, over exactly the
      // address being designated -- being a linked login wallet is not
      // itself proof of intent to become a registry signer.
      const provenAddress = await verifySiwxProof(
        { domain, redis: deps.redis },
        {
          message: parsed.data.message,
          signature: parsed.data.signature,
          sessionId: parsed.data.session_id,
        },
      );
      if (provenAddress !== address) {
        throw brainError(
          "auth_siwx_invalid",
          "the SIWX proof does not recover to the address being designated",
        );
      }

      await withTenantScope(deps.pool, principal.tenantId, (c) =>
        c.query(
          `UPDATE tenants SET onchain_signer_address = $2, updated_at = now() WHERE id = $1`,
          [principal.tenantId, address],
        ),
      );

      await deps.audit.emit({
        tenantId: principal.tenantId,
        layer: "execution",
        actor: principal.id,
        action: "tenant.onchain_signer_designated",
        inputs: {},
        outputs: { onchain_signer_address: address },
      });

      reply.status(200);
      return { tenant_id: principal.tenantId, onchain_signer_address: address };
    },
  );
}
