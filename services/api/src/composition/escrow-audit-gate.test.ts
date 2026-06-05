import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertEscrowAuditApproved, readAuditStatusApproved } from "./escrow-audit-gate.js";

const ANY_ADDR = "0x" + "ab".repeat(20);

describe("readAuditStatusApproved", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function fixtureDir(status: string | undefined): string {
    const root = mkdtempSync(join(tmpdir(), "audit-status-read-"));
    dirs.push(root);
    if (status !== undefined) {
      mkdirSync(join(root, "contracts"), { recursive: true });
      writeFileSync(
        join(root, "contracts/audit-status.json"),
        JSON.stringify({ contract: "BrainEscrow", status }),
      );
    }
    return root;
  }

  it("returns true only when the committed status is 'approved'", () => {
    expect(readAuditStatusApproved(fixtureDir("approved"))).toBe(true);
  });

  it("returns false for a pending/in_progress status (fail-closed)", () => {
    expect(readAuditStatusApproved(fixtureDir("pending"))).toBe(false);
    expect(readAuditStatusApproved(fixtureDir("in_progress"))).toBe(false);
  });

  it("returns false (fail-closed) when the file is absent", () => {
    expect(readAuditStatusApproved(fixtureDir(undefined))).toBe(false);
  });

  it("finds the file by walking up from a nested start dir", () => {
    const root = fixtureDir("approved");
    const nested = join(root, "services", "api", "dist");
    mkdirSync(nested, { recursive: true });
    expect(readAuditStatusApproved(nested)).toBe(true);
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
      }),
    ).toThrow(/audit-status\.json status is not "approved"/);
  });

  it("fails on mainnet when the receipt is an empty string (must be non-empty)", () => {
    expect(() =>
      assertEscrowAuditApproved({
        chainId: 8453,
        escrowAddress: ANY_ADDR,
        auditApproved: "false",
        auditReceipt: "",
        auditStatusApproved: true,
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
        }),
      ).not.toThrow();
    }
  });
});
