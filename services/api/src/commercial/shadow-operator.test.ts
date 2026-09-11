import { describe, expect, it } from "vitest";
import {
  PROTECTED_TENANT_IDS,
  SHADOW_API_SCOPES,
  inspectCommercialShadow,
  startCommercialShadow,
  transitionCommercialShadow,
} from "./shadow-operator.js";

const approvedSha = "a".repeat(40);

describe("commercial shadow operator", () => {
  it("pins all protected tenant ids and the read-only commercial key scope", () => {
    expect([...PROTECTED_TENANT_IDS]).toEqual([
      "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ",
      "tnt_00000000010000000000000000",
      "tnt_01KYAT7A1QRKHTYW9H4RAR2SEX",
      "tnt_01M1GTBQN8R8PB6X6PN73YB6NP",
    ]);
    expect(SHADOW_API_SCOPES).toEqual(["ledger:read", "audit:read", "governance:read"]);
  });

  it("generates live scoped credentials but sends only their digests to Postgres", async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        calls.push(values === undefined ? { text } : { text, values });
        return {
          rows: [
            {
              tenant_id: values?.[0],
              shadow_period_id: values?.[14],
              started_at: "2026-10-01T00:00:00Z",
              agent_id: values?.[5],
              agent_key_id: values?.[7],
              api_key_id: values?.[10],
            },
          ],
        };
      },
    } as never;
    const result = await startCommercialShadow(pool, {
      approvedSha,
      actor: "github-damon",
      reason: "Approved internal commercial shadow start",
      agentApiKeyPepper: "agent-pepper",
      apiKeyPepper: "api-pepper",
    });

    expect(result.bundle.BRAIN_AGENT_API_KEY).toMatch(/^brain_ak_live_/);
    expect(result.bundle.BRAIN_API_KEY).toMatch(/^brain_sk_live_/);
    const values = calls[0]?.values ?? [];
    expect(values).not.toContain(result.bundle.BRAIN_AGENT_API_KEY);
    expect(values).not.toContain(result.bundle.BRAIN_API_KEY);
    expect(values[8]).toMatch(/^[0-9a-f]{64}$/);
    expect(values[11]).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0]?.text).not.toContain("started_at");
  });

  it("keeps inspect read-only and records lifecycle changes through one narrow function", async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        calls.push(values === undefined ? { text } : { text, values });
        if (text.includes("inspect_internal")) return { rows: [{ result: { state: "running" } }] };
        return {
          rows: [
            {
              tenant_id: "tnt_01M2B3C4D5E6F7G8H9JKMNPQRS",
              shadow_period_id: "csp_01M2B3C4D5E6F7G8H9JKMNPQRS",
              state: "paused",
              started_at: "2026-10-01T00:00:00Z",
            },
          ],
        };
      },
    } as never;

    await expect(inspectCommercialShadow(pool)).resolves.toEqual({ state: "running" });
    await expect(
      transitionCommercialShadow(pool, {
        action: "pause",
        approvedSha,
        actor: "github-damon",
        reason: "Pause for controlled operator review",
      }),
    ).resolves.toMatchObject({ state: "paused" });
    expect(calls[0]?.text).toBe("SELECT inspect_internal_commercial_shadow() AS result");
    expect(calls[1]?.text).toContain("transition_internal_commercial_shadow");
  });
});
