import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { brainError, requireScope, withTenantScope, type TenantScopedClient } from "@brain/shared";

const MAX_RECEIPT_IDS = 100;

export interface X402ReceiptState {
  readonly receiptId: string;
  readonly logicalOperationId: string;
  readonly operationId: string;
  readonly operationClass: "api" | "mcp";
  readonly state:
    | "verified"
    | "settlement_pending"
    | "settled"
    | "fulfilled"
    | "service_failed"
    | "refund_pending"
    | "refunded"
    | "rejected";
  readonly network: string;
  readonly assetContract: string;
  readonly amountAtomic: string;
  readonly settlementTransactionHash: string | null;
  readonly refundTransactionHash: string | null;
  readonly l2Finality: "not_checked" | "sealed" | "reorged";
  readonly l1Finality: "not_checked" | "included" | "failed";
  readonly updatedAt: string;
}

export interface X402ReceiptRepository {
  get(tenantId: string, receiptId: string): Promise<X402ReceiptState | null>;
  query(tenantId: string, receiptIds: readonly string[]): Promise<readonly X402ReceiptState[]>;
}

interface ReceiptRow {
  id: string;
  logical_operation_id: string;
  operation_id: string;
  operation_class: "api" | "mcp";
  state: X402ReceiptState["state"];
  network: string;
  asset_contract: string;
  amount_atomic: string;
  settlement_tx_hash: string | null;
  refund_tx_hash: string | null;
  l2_finality: X402ReceiptState["l2Finality"];
  l1_finality: X402ReceiptState["l1Finality"];
  updated_at: Date | string;
}

export class PostgresX402ReceiptRepository implements X402ReceiptRepository {
  public constructor(private readonly pool: Pool) {}

  public async get(tenantId: string, receiptId: string): Promise<X402ReceiptState | null> {
    const rows = await this.query(tenantId, [receiptId]);
    return rows[0] ?? null;
  }

  public async query(
    tenantId: string,
    receiptIds: readonly string[],
  ): Promise<readonly X402ReceiptState[]> {
    if (receiptIds.length === 0) return [];
    return withTenantScope(this.pool, tenantId, async (client) => {
      const result = await queryRows(client, tenantId, receiptIds);
      return result.map(serializeReceipt);
    });
  }
}

export async function registerX402ReceiptRoutes(
  app: FastifyInstance,
  repository: X402ReceiptRepository,
): Promise<void> {
  app.get<{ Params: { receiptId: string } }>("/x402/receipts/:receiptId", async (request) => {
    const tenantId = requireReceiptReader(request);
    const receiptId = requireReceiptId(request.params.receiptId);
    const receipt = await repository.get(tenantId, receiptId);
    if (receipt === null) {
      throw brainError("commercial_x402_receipt_not_found", "x402 receipt does not exist", {
        statusOverride: 404,
      });
    }
    return serializeResponse(receipt);
  });

  app.post<{ Body?: { receipt_ids?: unknown } }>("/x402/receipts/query", async (request) => {
    const tenantId = requireReceiptReader(request);
    const receiptIds = parseReceiptIds(request.body?.receipt_ids);
    const receipts = await repository.query(tenantId, receiptIds);
    const byId = new Map(receipts.map((receipt) => [receipt.receiptId, receipt]));
    return {
      receipts: receiptIds.map((receiptId) => {
        const receipt = byId.get(receiptId);
        return receipt === undefined
          ? { receipt_id: receiptId, found: false as const, receipt: null }
          : { receipt_id: receiptId, found: true as const, receipt: serializeResponse(receipt) };
      }),
    };
  });
}

function requireReceiptReader(request: FastifyRequest): string {
  const principal = request.principal;
  if (principal === undefined) throw brainError("auth_token_missing", "principal required");
  if (principal.type === "agent" || principal.credentialId !== undefined) {
    throw brainError(
      "auth_scope_insufficient",
      "brain_ak_* agent credentials cannot authorize x402 payment state",
    );
  }
  requireScope(principal.scopes, "ledger:read");
  return principal.tenantId;
}

function parseReceiptIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RECEIPT_IDS) {
    throw brainError(
      "request_body_invalid",
      `receipt_ids must contain between 1 and ${MAX_RECEIPT_IDS} ids`,
    );
  }
  const ids = value.map((id) => requireReceiptId(id));
  if (new Set(ids).size !== ids.length) {
    throw brainError("request_body_invalid", "receipt_ids must not contain duplicates");
  }
  return ids;
}

function requireReceiptId(value: unknown): string {
  if (typeof value !== "string" || !/^x402rcpt_[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) {
    throw brainError("request_body_invalid", "receipt id is malformed");
  }
  return value;
}

async function queryRows(
  client: TenantScopedClient,
  tenantId: string,
  receiptIds: readonly string[],
): Promise<ReceiptRow[]> {
  const result = await client.query<ReceiptRow>(
    `SELECT r.id, r.logical_operation_id, a.operation_id, a.operation_class,
            r.state, q.network, q.asset_contract, q.amount_atomic::text,
            r.settlement_tx_hash, r.refund_tx_hash, r.l2_finality,
            r.l1_finality, r.updated_at
       FROM x402_seller_receipts r
       JOIN x402_seller_logical_operations o ON o.id = r.logical_operation_id
       JOIN x402_seller_operation_allowlist a ON a.id = o.operation_policy_id
       JOIN x402_seller_quotes q ON q.id = r.quote_id
      WHERE r.tenant_id = $1 AND r.id = ANY($2::text[])
      ORDER BY r.id`,
    [tenantId, receiptIds],
  );
  return result.rows;
}

function serializeReceipt(row: ReceiptRow): X402ReceiptState {
  return {
    receiptId: row.id,
    logicalOperationId: row.logical_operation_id,
    operationId: row.operation_id,
    operationClass: row.operation_class,
    state: row.state,
    network: row.network,
    assetContract: row.asset_contract,
    amountAtomic: row.amount_atomic,
    settlementTransactionHash: row.settlement_tx_hash,
    refundTransactionHash: row.refund_tx_hash,
    l2Finality: row.l2_finality,
    l1Finality: row.l1_finality,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function serializeResponse(receipt: X402ReceiptState) {
  return {
    receipt_id: receipt.receiptId,
    logical_operation_id: receipt.logicalOperationId,
    operation_id: receipt.operationId,
    operation_class: receipt.operationClass,
    state: receipt.state,
    network: receipt.network,
    asset_contract: receipt.assetContract,
    amount_atomic: receipt.amountAtomic,
    settlement_transaction_hash: receipt.settlementTransactionHash,
    refund_transaction_hash: receipt.refundTransactionHash,
    l2_finality: receipt.l2Finality,
    l1_finality: receipt.l1Finality,
    updated_at: receipt.updatedAt,
  };
}

export const X402_RECEIPT_QUERY_LIMIT = MAX_RECEIPT_IDS;
