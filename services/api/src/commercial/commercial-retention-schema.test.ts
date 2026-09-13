import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0047_commercial_financial_evidence_retention.sql"),
  "utf8",
);
const roles = readFileSync(resolve(process.cwd(), "../../infra/db-roles.sql"), "utf8");
const deletion = readFileSync(
  resolve(process.cwd(), "src/tenant-deletion/admin-delete-worker.ts"),
  "utf8",
);
const workflow = readFileSync(
  resolve(process.cwd(), "../../.github/workflows/commercial-retention.yml"),
  "utf8",
);
const legalHoldWorkflow = readFileSync(
  resolve(process.cwd(), "../../.github/workflows/commercial-retention-legal-hold.yml"),
  "utf8",
);

describe("commercial financial retention schema", () => {
  it("creates an opaque subject and all minimized archives without tenant foreign keys", () => {
    expect(migration).toContain("former_tenant_digest");
    expect(migration).toContain("hmac(convert_to(p_tenant_id, 'UTF8')");
    expect(migration).toContain("gen_random_bytes(32)");
    for (const table of [
      "commercial_retained_stripe_subscriptions",
      "commercial_retained_stripe_events",
      "commercial_retained_charge_facts",
      "commercial_retained_x402_operations",
      "commercial_retained_x402_events",
      "commercial_retained_provider_commands",
    ]) {
      const tableBody = migration.match(
        new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`),
      )?.[1];
      expect(tableBody, table).toBeDefined();
      expect(tableBody).not.toMatch(/tenant_id|REFERENCES tenants/);
    }
  });

  it("allowlists minimized evidence and never copies unrestricted provider material", () => {
    expect(migration).not.toMatch(/'payload',\s*source\.payload/);
    expect(migration).not.toMatch(/'request_envelope',\s*source\.request_envelope/);
    expect(migration).not.toMatch(/'source_evidence',\s*source\.source_evidence/);
    expect(migration).toContain("request_envelope_sha256");
    expect(migration).toContain("source_evidence_sha256");
    expect(migration).toContain("no versioned commercial retention extractor");
  });

  it("seals and reconciles before the tenant row can be deleted", () => {
    const prepare = migration.indexOf("prepare_commercial_financial_retention");
    const seal = migration.indexOf("INSERT INTO public.commercial_retirement_seals", prepare);
    const receipt = migration.indexOf("INSERT INTO public.commercial_retention_receipts", prepare);
    expect(seal).toBeGreaterThan(prepare);
    expect(receipt).toBeGreaterThan(seal);
    expect(migration).toContain("commercial retention source/archive count mismatch");
    expect(migration).toContain("prepared_txid = txid_current()");
    expect(migration).toContain("successful commercial retention receipt required");
    expect(deletion).toContain("SELECT prepare_commercial_financial_retention($1, $2)");
  });

  it("rejects unsettled work and unknown event or command extractors", () => {
    expect(migration).toContain("commercial provider work is unsettled");
    expect(migration).toContain("status IN ('pending', 'dispatched')");
    expect(migration).toContain("status IN ('received', 'failed')");
    expect(migration).toContain("source.provider || ':' || source.command_type");
    expect(migration).toContain("commercial_stripe_events', source.event_type");
  });

  it("keeps normal runtime roles and brain_privileged unable to mutate evidence", () => {
    expect(roles).toContain("CREATE ROLE brain_commercial_retention_worker NOLOGIN");
    expect(roles).toContain("REVOKE ALL PRIVILEGES ON commercial_retention_hmac_keys");
    expect(roles).toContain("brain_privileged");
    expect(roles).toContain("must not have % on %");
    expect(roles).toContain("prepare_commercial_financial_retention(text,text)");
  });

  it("installs the protected inspect, plan, apply, and verify expiry boundary", () => {
    expect(workflow).toContain("options: [inspect, plan-expiry, apply-expiry, verify]");
    expect(workflow).toContain("environment: commercial-retention-production");
    expect(workflow).toContain("PURGE_EXPIRED_COMMERCIAL_RETENTION");
    expect(workflow).toContain("manifest_digest");
    expect(migration).toContain("retain_until < p_now AND NOT legal_hold");
    expect(migration).toContain("commercial_retention_purge_receipts");
  });

  it("installs a separately protected legal-hold operator", () => {
    expect(legalHoldWorkflow).toContain("options: [inspect, set, release]");
    expect(legalHoldWorkflow).toContain("environment: commercial-retention-production");
    expect(legalHoldWorkflow).toContain("SET_COMMERCIAL_RETENTION_LEGAL_HOLD");
    expect(legalHoldWorkflow).toContain("RELEASE_COMMERCIAL_RETENTION_LEGAL_HOLD");
    expect(legalHoldWorkflow).toContain("set_commercial_retention_legal_hold");
  });
});
