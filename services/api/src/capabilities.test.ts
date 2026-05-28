import { describe, expect, it, vi } from "vitest";
import type { Logger } from "@brain/shared";
import { logBootCapabilities, type BootCapabilities } from "./capabilities.js";

function fakeLog(): { log: Logger; calls: Array<[Record<string, unknown>, string]> } {
  const calls: Array<[Record<string, unknown>, string]> = [];
  const log = {
    info: (obj: Record<string, unknown>, msg: string) => {
      calls.push([obj, msg]);
    },
  } as unknown as Logger;
  return { log, calls };
}

function base(): BootCapabilities {
  return {
    nodeEnv: "development",
    rails: [
      { name: "bank_ach", live: true },
      { name: "onchain_base", live: true },
      { name: "erp_writeback", live: false },
    ],
    gateLoaders: {
      resolveTenantFlags: true,
      attestCounterpartyAgent: false,
      sumAgentWindowSpend: false,
      resolveEscrowState: false,
    },
    liveAgentsCount: 19,
    webhookDispatchWorker: true,
    auditAnchorBroadcaster: false,
    mcpProofBuilder: true,
    sourceCredentialEncryption: false,
  };
}

describe("logBootCapabilities", () => {
  it("emits the brain.runtime.capabilities message", () => {
    const { log, calls } = fakeLog();
    logBootCapabilities(base(), log);
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toBe("brain.runtime.capabilities");
  });

  it("splits rails into live + stub, preserving order", () => {
    const { log, calls } = fakeLog();
    logBootCapabilities(base(), log);
    expect(calls[0]![0].rails_live).toEqual(["bank_ach", "onchain_base"]);
    expect(calls[0]![0].rails_stub).toEqual(["erp_writeback"]);
  });

  it("splits gate loaders into wired + dormant — surfaces the M2M dormancy story", () => {
    const { log, calls } = fakeLog();
    logBootCapabilities(base(), log);
    expect(calls[0]![0].gate_loaders_wired).toEqual(["resolveTenantFlags"]);
    expect(calls[0]![0].gate_loaders_dormant).toEqual([
      "attestCounterpartyAgent",
      "sumAgentWindowSpend",
      "resolveEscrowState",
    ]);
  });

  it("emits the booleans + counts verbatim", () => {
    const { log, calls } = fakeLog();
    logBootCapabilities(base(), log);
    const payload = calls[0]![0];
    expect(payload.live_agents_count).toBe(19);
    expect(payload.webhook_dispatch_worker).toBe(true);
    expect(payload.audit_anchor_broadcaster).toBe(false);
    expect(payload.mcp_proof_builder).toBe(true);
    expect(payload.source_credential_encryption).toBe(false);
    expect(payload.node_env).toBe("development");
  });

  it("defaults node_env to 'unset' when missing", () => {
    const { log, calls } = fakeLog();
    logBootCapabilities({ ...base(), nodeEnv: undefined }, log);
    expect(calls[0]![0].node_env).toBe("unset");
  });
});
