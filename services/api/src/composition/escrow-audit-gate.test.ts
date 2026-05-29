import { describe, expect, it } from "vitest";
import { assertEscrowAuditApproved } from "./escrow-audit-gate.js";

const ANY_ADDR = "0x" + "ab".repeat(20);

describe("assertEscrowAuditApproved", () => {
  it("is silent on Base Sepolia (84_532) regardless of audit flag", () => {
    expect(() =>
      assertEscrowAuditApproved({
        chainId: 84_532,
        escrowAddress: ANY_ADDR,
        auditApproved: "false",
      }),
    ).not.toThrow();
  });

  it("is silent on mainnet when no escrow address is configured", () => {
    expect(() =>
      assertEscrowAuditApproved({
        chainId: 8453,
        escrowAddress: undefined,
        auditApproved: "false",
      }),
    ).not.toThrow();
  });

  it("throws on mainnet when an escrow address is set without audit approval", () => {
    expect(() =>
      assertEscrowAuditApproved({
        chainId: 8453,
        escrowAddress: ANY_ADDR,
        auditApproved: "false",
      }),
    ).toThrow(/BRAIN_ESCROW_AUDIT_APPROVED is not "true"/);
  });

  it("passes on mainnet when the operator has explicitly opted in", () => {
    expect(() =>
      assertEscrowAuditApproved({
        chainId: 8453,
        escrowAddress: ANY_ADDR,
        auditApproved: "true",
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
        }),
      ).not.toThrow();
    }
  });
});
