import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  SLACK_BOT_SCOPES,
  mintSlackInstallState,
  verifySlackInstallState,
} from "../src/slack-oauth.js";
import { PostgresSlackInstallationStore, SlackInstallationTokenProvider } from "../src/storage.js";

const TENANT_ID = "tnt_01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("Slack install state", () => {
  it("round-trips valid state claims", () => {
    const minted = mintSlackInstallState({
      tenantId: TENANT_ID,
      installedBy: "user_1",
      secret: "state-secret",
      nowMs: 1_000,
      ttlSeconds: 60,
    });

    const verified = verifySlackInstallState({
      token: minted.token,
      secret: "state-secret",
      nowMs: 2_000,
    });

    expect(verified).toMatchObject({
      ok: true,
      claims: { tenantId: TENANT_ID, installedBy: "user_1", nonce: minted.nonce },
    });
  });

  it("rejects expired and tampered state", () => {
    const minted = mintSlackInstallState({
      tenantId: TENANT_ID,
      installedBy: "user_1",
      secret: "state-secret",
      nowMs: 1_000,
      ttlSeconds: 1,
    });
    const tampered = `${minted.token.slice(0, -1)}${minted.token.endsWith("x") ? "y" : "x"}`;

    expect(
      verifySlackInstallState({
        token: minted.token,
        secret: "state-secret",
        nowMs: 3_000,
      }),
    ).toEqual({ ok: false, reason: "expired" });
    expect(
      verifySlackInstallState({
        token: tampered,
        secret: "state-secret",
        nowMs: 1_000,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("Slack installation credential storage", () => {
  it("stores bot tokens encrypted and decrypts only at resolution time", async () => {
    const key = randomBytes(32);
    const captured: { ciphertext?: Buffer | undefined } = {};
    const pool = fakePool(captured);
    const store = new PostgresSlackInstallationStore(pool, { key, keyId: "test-key" });

    await store.upsertInstallation({
      tenantId: TENANT_ID,
      teamId: "T_1",
      botToken: "xoxb-secret-token",
      botUserId: "B_1",
      scopes: [SLACK_BOT_SCOPES[0]],
      installedBy: "user_1",
    });

    expect(captured.ciphertext).toBeInstanceOf(Buffer);
    expect(captured.ciphertext?.toString("utf8")).not.toContain("xoxb-secret-token");
    await expect(store.getTokenForTenant(TENANT_ID)).resolves.toBe("xoxb-secret-token");
  });

  it("fails closed when no installation or fallback token exists", async () => {
    const provider = new SlackInstallationTokenProvider({
      async getTokenForTenant() {
        return null;
      },
    });

    await expect(provider.tokenForTenant(TENANT_ID)).rejects.toThrow(
      "slack_installation_not_found",
    );
  });
});

function fakePool(captured: { ciphertext?: Buffer | undefined }): Pool {
  const client = {
    async query(text: string, params?: unknown[]) {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text) || text.includes("set_config")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("INSERT INTO surface_slack_installations")) {
        captured.ciphertext = params?.[2] as Buffer;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("FROM surface_slack_installations")) {
        return {
          rows: [
            {
              tenant_id: TENANT_ID,
              team_id: "T_1",
              bot_token_encrypted: captured.ciphertext,
              credential_key_id: "test-key",
              bot_user_id: "B_1",
              scopes: [SLACK_BOT_SCOPES[0]],
              installed_by: "user_1",
              installed_at: new Date(),
              status: "active",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { connect: async () => client } as unknown as Pool;
}
