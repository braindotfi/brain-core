import { describe, expect, it } from "vitest";
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
      {
        name: "bank_ach",
        live: true,
        productionAllowed: true,
        requiredEnvPresent: true,
        chainId: null,
        auditRequired: false,
        auditApproved: "not_applicable",
      },
      {
        name: "onchain_base",
        live: true,
        productionAllowed: true,
        requiredEnvPresent: true,
        chainId: 84_532,
        auditRequired: false,
        auditApproved: "not_applicable",
      },
      {
        name: "erp_writeback",
        live: false,
        productionAllowed: false,
        requiredEnvPresent: false,
        chainId: null,
        auditRequired: false,
        auditApproved: "not_applicable",
      },
    ],
    gateLoaders: {
      resolveTenantFlags: true,
      attestCounterpartyAgent: false,
      sumAgentWindowSpend: false,
      resolveEscrowState: false,
      sumActiveReservations: true,
      resolveEvidence: true,
      detectDuplicates: true,
    },
    liveAgentsCount: 19,
    webhookDispatchWorker: true,
    tenantBlobPurgeWorker: true,
    auditAnchorBroadcaster: false,
    mcpProofBuilder: true,
    sourceCredentialEncryption: false,
    sourceCredentialKeyProvider: "none",
    wikiDbIsolation: false,
    privilegedDbIsolation: false,
    pythonAgentSigning: false,
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
    expect(calls[0]![0].gate_loaders_wired).toEqual([
      "resolveTenantFlags",
      "sumActiveReservations",
      "resolveEvidence",
      "detectDuplicates",
    ]);
    expect(calls[0]![0].gate_loaders_dormant).toEqual([
      "attestCounterpartyAgent",
      "sumAgentWindowSpend",
      "resolveEscrowState",
    ]);
  });

  it("emits the new safety-wiring flags (wiki/privileged DB isolation, python agent signing)", () => {
    const { log, calls } = fakeLog();
    logBootCapabilities(
      {
        ...base(),
        wikiDbIsolation: true,
        privilegedDbIsolation: true,
        pythonAgentSigning: true,
      },
      log,
    );
    const payload = calls[0]![0];
    expect(payload.wiki_db_isolation).toBe(true);
    expect(payload.privileged_db_isolation).toBe(true);
    expect(payload.python_agent_signing).toBe(true);
  });

  it("flags storage isolation + python signing as false when unset (default base)", () => {
    const { log, calls } = fakeLog();
    logBootCapabilities(base(), log);
    const payload = calls[0]![0];
    expect(payload.wiki_db_isolation).toBe(false);
    expect(payload.privileged_db_isolation).toBe(false);
    expect(payload.python_agent_signing).toBe(false);
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
    expect(payload.source_credential_key_provider).toBe("none");
    expect(payload.node_env).toBe("development");
  });

  it("surfaces the active credential-key provider source", () => {
    const { log, calls } = fakeLog();
    logBootCapabilities(
      {
        ...base(),
        sourceCredentialEncryption: true,
        sourceCredentialKeyProvider: "azure-key-vault",
      },
      log,
    );
    expect(calls[0]![0].source_credential_key_provider).toBe("azure-key-vault");
    expect(calls[0]![0].source_credential_encryption).toBe(true);
  });

  it("defaults node_env to 'unset' when missing", () => {
    const { log, calls } = fakeLog();
    logBootCapabilities({ ...base(), nodeEnv: undefined }, log);
    expect(calls[0]![0].node_env).toBe("unset");
  });

  it("emits per-rail posture (rec #7): live + production_allowed + env + chain + audit", () => {
    const { log, calls } = fakeLog();
    logBootCapabilities(base(), log);
    const rails = calls[0]![0].rails as Array<Record<string, unknown>>;
    expect(rails).toHaveLength(3);
    const ach = rails.find((r) => r.name === "bank_ach")!;
    expect(ach.live).toBe(true);
    expect(ach.production_allowed).toBe(true);
    expect(ach.required_env_present).toBe(true);
    expect(ach.chain_id).toBeNull();
    expect(ach.audit_required).toBe(false);
    expect(ach.audit_approved).toBe("not_applicable");
    const onchain = rails.find((r) => r.name === "onchain_base")!;
    expect(onchain.chain_id).toBe(84_532);
    const erp = rails.find((r) => r.name === "erp_writeback")!;
    expect(erp.production_allowed).toBe(false);
    expect(erp.live).toBe(false);
  });

  it("surfaces escrow_base mainnet audit posture in the rail entry", () => {
    const { log, calls } = fakeLog();
    logBootCapabilities(
      {
        ...base(),
        rails: [
          {
            name: "escrow_base",
            live: true,
            productionAllowed: true,
            requiredEnvPresent: true,
            chainId: 8453,
            auditRequired: true,
            auditApproved: "approved",
          },
        ],
      },
      log,
    );
    const rails = calls[0]![0].rails as Array<Record<string, unknown>>;
    const escrow = rails[0]!;
    expect(escrow.chain_id).toBe(8453);
    expect(escrow.audit_required).toBe(true);
    expect(escrow.audit_approved).toBe("approved");
  });
});
