import { createHash } from "node:crypto";

export function commercialDemoRetentionReceiptId(operationId, tenantId) {
  const digest = createHash("sha256")
    .update(`${operationId}:${tenantId}`)
    .digest("hex")
    .slice(0, 26)
    .toUpperCase();
  return `retreceipt_${digest}`;
}

export async function prepareCommercialFinancialRetention(client, operationId, tenantId) {
  const retentionReceiptId = commercialDemoRetentionReceiptId(operationId, tenantId);
  const prepared = await client.query(
    `SELECT prepare_commercial_financial_retention($1, $2) AS retention_subject_id`,
    [tenantId, retentionReceiptId],
  );
  const retentionSubjectId = prepared.rows[0]?.retention_subject_id;
  if (typeof retentionSubjectId !== "string" || !/^retsub_[0-9a-f]{32}$/.test(retentionSubjectId)) {
    throw new Error("commercial financial retention preparation returned no valid subject");
  }
  return { retentionSubjectId, retentionReceiptId };
}
