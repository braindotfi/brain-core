import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// Mock the Azure SDK before importing the module under test so the provider
// can be exercised without real Azure credentials / network access.
const getSecret = vi.fn();
vi.mock("@azure/keyvault-secrets", () => ({
  SecretClient: vi.fn().mockImplementation(() => ({ getSecret })),
}));
vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn().mockImplementation(() => ({})),
}));

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

  describe("Azure Key Vault provider", () => {
    const provider = () =>
      buildCredentialKeyProvider({
        kmsVaultUrl: "https://vault.example.vault.azure.net",
        kmsSecretName: "brain-source-credential-key",
        envVarKey: undefined,
        envKeyId: "v1",
        nodeEnv: "production",
      });

    it("load() decodes the base64 secret + returns the secret version as keyId", async () => {
      const raw = randomBytes(32);
      getSecret.mockResolvedValueOnce({
        value: raw.toString("base64"),
        properties: { version: "abc123" },
      });
      const ck = await provider().load();
      // Interface return type is CredentialKey | undefined; mock guarantees a
      // value, so assert non-null here for the typecheck.
      expect(ck!.key.equals(raw)).toBe(true);
      expect(ck!.keyId).toBe("abc123");
      expect(getSecret).toHaveBeenLastCalledWith("brain-source-credential-key");
    });

    it("load() throws when the secret has no value", async () => {
      getSecret.mockResolvedValueOnce({ value: undefined, properties: {} });
      await expect(provider().load()).rejects.toThrow(/has no value/);
    });

    it("load() throws when the secret decodes to a non-32-byte buffer", async () => {
      getSecret.mockResolvedValueOnce({
        value: Buffer.from("too short").toString("base64"),
        properties: { version: "v1" },
      });
      await expect(provider().load()).rejects.toThrow(/expected 32/);
    });

    it("load() falls back to the secret name as keyId when version is missing", async () => {
      const raw = randomBytes(32);
      getSecret.mockResolvedValueOnce({
        value: raw.toString("base64"),
        properties: {},
      });
      const ck = await provider().load();
      expect(ck!.keyId).toBe("brain-source-credential-key");
    });
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
