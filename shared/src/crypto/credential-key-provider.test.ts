import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCredentialKeyProvider } from "./credential-key-provider.js";

const ENV_KEY_B64 = randomBytes(32).toString("base64");

describe("buildCredentialKeyProvider", () => {
  it("selects the Azure Key Vault provider when both vault URL and secret name are set", () => {
    const p = buildCredentialKeyProvider({
      kmsVaultUrl: "https://vault.example.vault.azure.net",
      kmsSecretName: "brain-source-credential-key",
      envVarKey: ENV_KEY_B64,
      envKeyId: "v1",
      nodeEnv: "production",
    });
    expect(p.source).toBe("azure-key-vault");
  });

  it("falls back to env-var when only one half of the KMS pair is set", () => {
    const justUrl = buildCredentialKeyProvider({
      kmsVaultUrl: "https://vault.example.vault.azure.net",
      kmsSecretName: undefined,
      envVarKey: ENV_KEY_B64,
      envKeyId: "v1",
      nodeEnv: "development",
    });
    expect(justUrl.source).toBe("env-var");

    const justName = buildCredentialKeyProvider({
      kmsVaultUrl: undefined,
      kmsSecretName: "x",
      envVarKey: ENV_KEY_B64,
      envKeyId: "v1",
      nodeEnv: "development",
    });
    expect(justName.source).toBe("env-var");
  });

  it("returns the 'none' provider when nothing is configured", () => {
    const p = buildCredentialKeyProvider({
      kmsVaultUrl: undefined,
      kmsSecretName: undefined,
      envVarKey: undefined,
      envKeyId: "v1",
      nodeEnv: "development",
    });
    expect(p.source).toBe("none");
  });

  it("env-var provider returns the decoded key and id in dev", async () => {
    const p = buildCredentialKeyProvider({
      kmsVaultUrl: undefined,
      kmsSecretName: undefined,
      envVarKey: ENV_KEY_B64,
      envKeyId: "dev-v1",
      nodeEnv: "development",
    });
    const ck = await p.load();
    expect(ck?.key.length).toBe(32);
    expect(ck?.keyId).toBe("dev-v1");
  });

  it("env-var provider load() throws in production (delegates to decodeEnvCredentialKey)", async () => {
    const p = buildCredentialKeyProvider({
      kmsVaultUrl: undefined,
      kmsSecretName: undefined,
      envVarKey: ENV_KEY_B64,
      envKeyId: "v1",
      nodeEnv: "production",
    });
    await expect(p.load()).rejects.toThrow(/forbidden in NODE_ENV=production/);
  });

  it("Azure Key Vault provider load() throws with a wiring pointer (SDK not yet wired)", async () => {
    const p = buildCredentialKeyProvider({
      kmsVaultUrl: "https://vault.example.vault.azure.net",
      kmsSecretName: "brain-source-credential-key",
      envVarKey: undefined,
      envKeyId: "v1",
      nodeEnv: "production",
    });
    await expect(p.load()).rejects.toThrow(/@azure\/keyvault-secrets SDK is not wired/);
  });

  it("'none' provider load() returns undefined", async () => {
    const p = buildCredentialKeyProvider({
      kmsVaultUrl: undefined,
      kmsSecretName: undefined,
      envVarKey: undefined,
      envKeyId: "v1",
      nodeEnv: "development",
    });
    expect(await p.load()).toBeUndefined();
  });
});
