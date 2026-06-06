import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertEscrowAuditApproved,
  readAuditChainApproved,
  readAuditStatusApproved,
} from "./escrow-audit-gate.js";

const ANY_ADDR = "0x" + "ab".repeat(20);

describe("readAuditStatusApproved", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  // A fully-evidenced approved record (the only shape that authorizes a mainnet
  // boot): the runtime fence uses the shared evaluateApproval, so "approved"
  // alone is not enough — auditor, a 40-hex audited commit, a report reference,
  // and zero unresolved critical/high findings are all required.
  const COMPLETE_APPROVED = {
    contract: "BrainEscrow",
    scope_doc: "contracts/AUDIT-SCOPE.md",
    status: "approved",
    auditor: "Acme Smart Contract Audits",
    audited_commit: "0123456789abcdef0123456789abcdef01234567",
    report_url: "https://example.com/report.pdf",
    report_sha256: null,
    unresolved_findings: { critical: 0, high: 0, medium: 1, low: 3 },
    // Build-evidence binding (required for approval).
    compiler: {
      solc_version: "0.8.24+commit.e11b9ed9",
      optimizer_enabled: true,
      optimizer_runs: 200,
      evm_version: "cancun",
    },
    contract_source_tree_sha256: "a".repeat(64),
    creation_bytecode_sha256: "b".repeat(64),
    runtime_bytecode_sha256: "c".repeat(64),
    approved_chain_ids: [8453],
  };

  function writeFixture(doc: Record<string, unknown> | undefined): string {
    const root = mkdtempSync(join(tmpdir(), "audit-status-read-"));
    dirs.push(root);
    if (doc !== undefined) {
      mkdirSync(join(root, "contracts"), { recursive: true });
      writeFileSync(join(root, "contracts/audit-status.json"), JSON.stringify(doc));
    }
    return root;
  }

  // A complete, integrity-valid record at the given status. Only "approved"
  // (with the full evidence above) authorizes boot; other statuses are valid
  // but not approved.
  function fixtureDir(status: string | undefined): string {
    if (status === undefined) return writeFixture(undefined);
    return writeFixture({ ...COMPLETE_APPROVED, status });
  }

  it("returns true when the committed record is approved with full evidence", () => {
    expect(readAuditStatusApproved(fixtureDir("approved"))).toBe(true);
  });

  it("returns false (fail-closed) when status is 'approved' but evidence is incomplete", () => {
    // The exact fail-open this validator closes: a bare status flip without the
    // auditor / 40-hex commit / report / zero-critical-high evidence.
    expect(
      readAuditStatusApproved(writeFixture({ contract: "BrainEscrow", status: "approved" })),
    ).toBe(false);
    expect(readAuditStatusApproved(writeFixture({ ...COMPLETE_APPROVED, auditor: null }))).toBe(
      false,
    );
    expect(
      readAuditStatusApproved(
        writeFixture({ ...COMPLETE_APPROVED, unresolved_findings: { critical: 1, high: 0 } }),
      ),
    ).toBe(false);
  });

  it("returns false for a pending/in_progress status (fail-closed)", () => {
    expect(readAuditStatusApproved(fixtureDir("pending"))).toBe(false);
    expect(readAuditStatusApproved(fixtureDir("in_progress"))).toBe(false);
  });

  it("returns false (fail-closed) when the file is absent", () => {
    expect(readAuditStatusApproved(fixtureDir(undefined))).toBe(false);
  });

  it("returns false (fail-closed) on a malformed file (no walk-up past it)", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-status-read-"));
    dirs.push(root);
    mkdirSync(join(root, "contracts"), { recursive: true });
    writeFileSync(join(root, "contracts/audit-status.json"), "{ not json");
    expect(readAuditStatusApproved(root)).toBe(false);
  });

  it("finds the file by walking up from a nested start dir", () => {
    const root = fixtureDir("approved");
    const nested = join(root, "services", "api", "dist");
    mkdirSync(nested, { recursive: true });
    expect(readAuditStatusApproved(nested)).toBe(true);
  });

  it("readAuditChainApproved: true only for a chain in approved_chain_ids", () => {
    // COMPLETE_APPROVED lists approved_chain_ids: [8453].
    expect(readAuditChainApproved(8453, fixtureDir("approved"))).toBe(true);
    expect(readAuditChainApproved(84532, fixtureDir("approved"))).toBe(false);
  });

  it("readAuditChainApproved: fail-closed on a missing or chain-omitting record", () => {
    expect(readAuditChainApproved(8453, fixtureDir(undefined))).toBe(false);
    expect(
      readAuditChainApproved(8453, writeFixture({ ...COMPLETE_APPROVED, approved_chain_ids: [] })),
    ).toBe(false);
  });
});

describe("assertEscrowAuditApproved", () => {
  it("is silent on Base Sepolia (84_532) regardless of audit flag", () => {
    expect(() =>
      assertEscrowAuditApproved({
        chainId: 84_532,
        escrowAddress: ANY_ADDR,
        auditApproved: "false",
        auditStatusApproved: false,
        auditChainApproved: false,
      }),
    ).not.toThrow();
  });

  it("is silent on mainnet when no escrow address is configured", () => {
    expect(() =>
      assertEscrowAuditApproved({
        chainId: 8453,
        escrowAddress: undefined,
        auditApproved: "false",
        auditStatusApproved: false,
        auditChainApproved: false,
      }),
    ).not.toThrow();
  });

  it("throws on mainnet when an escrow address is set without audit approval", () => {
    expect(() =>
      assertEscrowAuditApproved({
        chainId: 8453,
        escrowAddress: ANY_ADDR,
        auditApproved: "false",
        auditStatusApproved: true, // committed record OK, but no env attestation
        auditChainApproved: true,
      }),
    ).toThrow(/neither BRAIN_ESCROW_AUDIT_RECEIPT nor BRAIN_ESCROW_AUDIT_APPROVED/);
  });

  it("passes on mainnet when the operator opted in (legacy boolean) AND the audit record is approved", () => {
    expect(() =>
      assertEscrowAuditApproved({
        chainId: 8453,
        escrowAddress: ANY_ADDR,
        auditApproved: "true",
        auditStatusApproved: true,
        auditChainApproved: true,
      }),
    ).not.toThrow();
  });

  it("passes on mainnet when a receipt is supplied AND the audit record is approved", () => {
    expect(() =>
      assertEscrowAuditApproved({
        chainId: 8453,
        escrowAddress: ANY_ADDR,
        auditApproved: "false",
        auditReceipt: "https://audits.brain.fi/escrow-2026-06.pdf#commit=abc123",
        auditStatusApproved: true,
        auditChainApproved: true,
      }),
    ).not.toThrow();
  });

  it("STILL throws on mainnet when the env attests approval but audit-status.json is not approved", () => {
    // The core R-01 hardening: a bare env flag cannot bypass a pending audit.
    expect(() =>
      assertEscrowAuditApproved({
        chainId: 8453,
        escrowAddress: ANY_ADDR,
        auditApproved: "true",
        auditReceipt: "https://audits.brain.fi/escrow.pdf",
        auditStatusApproved: false, // committed record still pending
        auditChainApproved: true,
      }),
    ).toThrow(/audit-status\.json status is not "approved"/);
  });

  it("throws on mainnet when the record is approved + env attested but this chain is not in approved_chain_ids", () => {
    // An audit approved for some other chain must not authorize Base mainnet.
    expect(() =>
      assertEscrowAuditApproved({
        chainId: 8453,
        escrowAddress: ANY_ADDR,
        auditApproved: "true",
        auditReceipt: "https://audits.brain.fi/escrow.pdf",
        auditStatusApproved: true,
        auditChainApproved: false,
      }),
    ).toThrow(/approved_chain_ids does not list this chain \(8453\)/);
  });

  it("fails on mainnet when the receipt is an empty string (must be non-empty)", () => {
    expect(() =>
      assertEscrowAuditApproved({
        chainId: 8453,
        escrowAddress: ANY_ADDR,
        auditApproved: "false",
        auditReceipt: "",
        auditStatusApproved: true,
        auditChainApproved: true,
      }),
    ).toThrow(/neither BRAIN_ESCROW_AUDIT_RECEIPT nor BRAIN_ESCROW_AUDIT_APPROVED/);
  });

  it("passes on mainnet when record approved AND both receipt and legacy boolean are set", () => {
    expect(() =>
      assertEscrowAuditApproved({
        chainId: 8453,
        escrowAddress: ANY_ADDR,
        auditApproved: "true",
        auditReceipt: "ipfs://Qmabc...",
        auditStatusApproved: true,
        auditChainApproved: true,
      }),
    ).not.toThrow();
  });

  it("Sepolia is silent even when receipt is set (no audit required on testnet)", () => {
    expect(() =>
      assertEscrowAuditApproved({
        chainId: 84_532,
        escrowAddress: ANY_ADDR,
        auditApproved: "false",
        auditReceipt: "https://audits.brain.fi/escrow.pdf",
        auditStatusApproved: false,
        auditChainApproved: false,
      }),
    ).not.toThrow();
  });

  it("does not accept any other chain id as mainnet (defensive)", () => {
    for (const id of [1, 10, 137, 42_161, 84_531]) {
      expect(() =>
        assertEscrowAuditApproved({
          chainId: id,
          escrowAddress: ANY_ADDR,
          auditApproved: "false",
          auditStatusApproved: false,
          auditChainApproved: false,
        }),
      ).not.toThrow();
    }
  });
});
