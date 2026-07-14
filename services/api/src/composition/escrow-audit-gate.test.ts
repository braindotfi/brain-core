import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maskedRuntimeSha256 } from "@brain/shared";
import {
  assertBaseRpcChainId,
  assertDeployedEscrowBytecode,
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
    immutable_references: [{ start: 301, length: 32 }],
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
  it("fails closed when BASE_RPC_URL reports a different chain id than config", async () => {
    await expect(
      assertBaseRpcChainId({
        configuredChainId: 84_532,
        rpcUrl: "https://example.invalid",
        getChainId: async () => 8453,
      }),
    ).rejects.toThrow(/BASE_RPC_URL reports chainId=8453/);
  });

  it("passes when BASE_RPC_URL reports the configured chain id", async () => {
    await expect(
      assertBaseRpcChainId({
        configuredChainId: 84_532,
        rpcUrl: "https://example.invalid",
        getChainId: async () => 84_532,
      }),
    ).resolves.toBeUndefined();
  });

  it("skips RPC chain-id probing when BASE_RPC_URL is not configured", async () => {
    const getChainId = vi.fn(async () => 8453);
    await expect(
      assertBaseRpcChainId({
        configuredChainId: 84_532,
        rpcUrl: undefined,
        getChainId,
      }),
    ).resolves.toBeUndefined();
    expect(getChainId).not.toHaveBeenCalled();
  });

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

  it("is silent on local Foundry chain (31_337) regardless of audit flag", () => {
    expect(() =>
      assertEscrowAuditApproved({
        chainId: 31_337,
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

  it("requires audit approval on every non-testnet chain id with escrow configured", () => {
    for (const id of [1, 10, 137, 42_161]) {
      expect(() =>
        assertEscrowAuditApproved({
          chainId: id,
          escrowAddress: ANY_ADDR,
          auditApproved: "false",
          auditStatusApproved: false,
          auditChainApproved: false,
        }),
      ).toThrow(new RegExp(`chainId=${String(id)}`));
    }
  });

  it("passes on any non-testnet chain only when the full audit path is satisfied", () => {
    for (const id of [1, 10, 137, 42_161]) {
      expect(() =>
        assertEscrowAuditApproved({
          chainId: id,
          escrowAddress: ANY_ADDR,
          auditApproved: "true",
          auditStatusApproved: true,
          auditChainApproved: true,
        }),
      ).not.toThrow();
    }
  });
});

describe("assertDeployedEscrowBytecode", () => {
  // 64-byte synthetic runtime with an "immutable" range at bytes [2,6).
  const RUNTIME = "0x60806040" + "00".repeat(60);
  const REFS = [{ start: 2, length: 4 }];
  const EXPECTED = maskedRuntimeSha256(RUNTIME, REFS);

  function withImmutables(value: number): string {
    const buf = Buffer.from(RUNTIME.slice(2), "hex");
    buf.fill(value, 2, 6);
    return "0x" + buf.toString("hex");
  }

  it("is silent on explicit testnet (no eth_getCode call)", async () => {
    const getCode = vi.fn();
    await expect(
      assertDeployedEscrowBytecode({
        chainId: 84_532,
        escrowAddress: ANY_ADDR,
        expectedRuntimeSha256: EXPECTED,
        immutableReferences: REFS,
        getCode,
      }),
    ).resolves.toBeUndefined();
    expect(getCode).not.toHaveBeenCalled();
  });

  it("checks deployed bytecode on every non-testnet chain", async () => {
    for (const id of [1, 10, 137, 42_161]) {
      const getCode = vi.fn(async () => withImmutables(0xff));
      await expect(
        assertDeployedEscrowBytecode({
          chainId: id,
          escrowAddress: ANY_ADDR,
          expectedRuntimeSha256: EXPECTED,
          immutableReferences: REFS,
          getCode,
        }),
      ).resolves.toBeUndefined();
      expect(getCode).toHaveBeenCalledWith(ANY_ADDR);
    }
  });

  it("is silent on mainnet when no escrow address is set", async () => {
    const getCode = vi.fn();
    await expect(
      assertDeployedEscrowBytecode({
        chainId: 8453,
        escrowAddress: undefined,
        expectedRuntimeSha256: EXPECTED,
        immutableReferences: REFS,
        getCode,
      }),
    ).resolves.toBeUndefined();
    expect(getCode).not.toHaveBeenCalled();
  });

  it("passes when the deployed code masks to the audited hash (immutables filled in)", async () => {
    const getCode = vi.fn(async () => withImmutables(0xff)); // arbiter address written
    await expect(
      assertDeployedEscrowBytecode({
        chainId: 8453,
        escrowAddress: ANY_ADDR,
        expectedRuntimeSha256: EXPECTED,
        immutableReferences: REFS,
        getCode,
      }),
    ).resolves.toBeUndefined();
    expect(getCode).toHaveBeenCalledWith(ANY_ADDR);
  });

  it("throws when the deployed code differs OUTSIDE the immutables", async () => {
    const buf = Buffer.from(RUNTIME.slice(2), "hex");
    buf[10] = buf[10]! ^ 0xff;
    const getCode = vi.fn(async () => "0x" + buf.toString("hex"));
    await expect(
      assertDeployedEscrowBytecode({
        chainId: 8453,
        escrowAddress: ANY_ADDR,
        expectedRuntimeSha256: EXPECTED,
        immutableReferences: REFS,
        getCode,
      }),
    ).rejects.toThrow(/does NOT match the audited/);
  });

  it("throws when no contract is deployed at the address (empty code)", async () => {
    const getCode = vi.fn(async () => "0x");
    await expect(
      assertDeployedEscrowBytecode({
        chainId: 8453,
        escrowAddress: ANY_ADDR,
        expectedRuntimeSha256: EXPECTED,
        immutableReferences: REFS,
        getCode,
      }),
    ).rejects.toThrow(/does NOT match the audited/);
  });

  it("throws (fail-closed) when the record lacks the runtime hash or immutable refs", async () => {
    const getCode = vi.fn(async () => RUNTIME);
    await expect(
      assertDeployedEscrowBytecode({
        chainId: 8453,
        escrowAddress: ANY_ADDR,
        expectedRuntimeSha256: undefined,
        immutableReferences: REFS,
        getCode,
      }),
    ).rejects.toThrow(/runtime_bytecode_sha256 or a valid immutable_references/);
    await expect(
      assertDeployedEscrowBytecode({
        chainId: 8453,
        escrowAddress: ANY_ADDR,
        expectedRuntimeSha256: EXPECTED,
        immutableReferences: "not-an-array",
        getCode,
      }),
    ).rejects.toThrow(/immutable_references/);
    expect(getCode).not.toHaveBeenCalled();
  });
});
