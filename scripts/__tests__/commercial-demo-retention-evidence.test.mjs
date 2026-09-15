import assert from "node:assert/strict";
import test from "node:test";
import {
  commercialDemoRetentionReceiptId,
  prepareCommercialFinancialRetention,
} from "../ops/commercial-demo-retention-evidence.mjs";

const OPERATION_ID = "commercial-demo-retirement-2026-09-03";
const TENANT_ID = "tnt_01TEST";

test("commercial demo retention receipt ids are stable per operation and tenant", () => {
  assert.equal(
    commercialDemoRetentionReceiptId(OPERATION_ID, TENANT_ID),
    "retreceipt_B2946E3864FBD6845CB33556CD",
  );
  assert.notEqual(
    commercialDemoRetentionReceiptId(OPERATION_ID, TENANT_ID),
    commercialDemoRetentionReceiptId(OPERATION_ID, "tnt_02TEST"),
  );
});

test("commercial demo retirement prepares retention with the stable receipt", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ retention_subject_id: `retsub_${"a".repeat(32)}` }] };
    },
  };

  const result = await prepareCommercialFinancialRetention(client, OPERATION_ID, TENANT_ID);

  assert.deepEqual(result, {
    retentionSubjectId: `retsub_${"a".repeat(32)}`,
    retentionReceiptId: "retreceipt_B2946E3864FBD6845CB33556CD",
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /prepare_commercial_financial_retention\(\$1, \$2\)/);
  assert.deepEqual(calls[0].values, [TENANT_ID, "retreceipt_B2946E3864FBD6845CB33556CD"]);
});

test("commercial demo retirement fails closed when preparation returns no valid subject", async () => {
  for (const retention_subject_id of [undefined, null, "", "tnt_not_a_retention_subject"]) {
    const client = {
      async query() {
        return { rows: [{ retention_subject_id }] };
      },
    };
    await assert.rejects(
      prepareCommercialFinancialRetention(client, OPERATION_ID, TENANT_ID),
      /commercial financial retention preparation returned no valid subject/,
    );
  }
});
