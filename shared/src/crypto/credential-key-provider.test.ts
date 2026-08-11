import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// Mock the Azure SDK before importing the module under test so the provider
// can be exercised without real Azure credentials / network access.
const getSecret = vi.fn();
vi.mock("@azure/keyvault-secrets", () => ({
  SecretClient: vi.fn(function () {
    return { getSecret };
  }),
}));
vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn(function () {
    return {};
  }),
}));

import { buildCredentialKeyProvider } from "./credential-key-provider.js";
import { encryptCredentials, decryptCredentials } from "./aes-gcm.js";

const ENV_KEY_B64 = randomBytes(32).toString("base64");

describe("buildCredentialKeyProvider", () => {
  it("selects the Azure Key Vault provider when both vault URL and secret name are set", () => {
    const p = buildCredentialKeyProvider({
      kmsVaultUrl: "https://vault.example.vault.azure.net",
      kmsSecretName: "brain-source-credential-key",
      envVarKey: ENV_KEY_B64,
      envKeyId: "v1",
      nodeEnv: "production",
      allowUnencrypted: false,
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
      allowUnencrypted: false,
    });
    expect(justUrl.source).toBe("env-var");

    const justName = buildCredentialKeyProvider({
      kmsVaultUrl: undefined,
      kmsSecretName: "x",
      envVarKey: ENV_KEY_B64,
      envKeyId: "v1",
      nodeEnv: "development",
      allowUnencrypted: false,
    });
    expect(justName.source).toBe("env-var");
  });

  it("returns the 'none' provider when nothing is configured (non-production)", () => {
    const p = buildCredentialKeyProvider({
      kmsVaultUrl: undefined,
      kmsSecretName: undefined,
      envVarKey: undefined,
      envKeyId: "v1",
      nodeEnv: "development",
      allowUnencrypted: false,
    });
    expect(p.source).toBe("none");
  });

  it("production boot fence: throws when nothing is configured and allowUnencrypted is false", () => {
    expect(() =>
      buildCredentialKeyProvider({
        kmsVaultUrl: undefined,
        kmsSecretName: undefined,
        envVarKey: undefined,
        envKeyId: "v1",
        nodeEnv: "production",
        allowUnencrypted: false,
      }),
    ).toThrow(
      /BRAIN_AZURE_KEY_VAULT_URL.*BRAIN_SOURCE_CREDENTIAL_KEY_VAULT_NAME.*BRAIN_ALLOW_UNENCRYPTED_SOURCE_CREDENTIALS/s,
    );
  });

  it("production boot fence: returns the 'none' provider when allowUnencrypted is true", () => {
    const p = buildCredentialKeyProvider({
      kmsVaultUrl: undefined,
      kmsSecretName: undefined,
      envVarKey: undefined,
      envKeyId: "v1",
      nodeEnv: "production",
      allowUnencrypted: true,
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
      allowUnencrypted: false,
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
      allowUnencrypted: false,
    });
    await expect(p.load()).rejects.toThrow(/forbidden in NODE_ENV=production/);
  });

  describe("EnvCredentialKeyProvider.loadById", () => {
    it("returns the key for the matching (active) id", async () => {
      const p = buildCredentialKeyProvider({
        kmsVaultUrl: undefined,
        kmsSecretName: undefined,
        envVarKey: ENV_KEY_B64,
        envKeyId: "dev-v1",
        nodeEnv: "development",
        allowUnencrypted: false,
      });
      const key = await p.loadById("dev-v1");
      expect(key.length).toBe(32);
      expect(key.toString("base64")).toBe(ENV_KEY_B64);
    });

    it("throws for a non-matching id", async () => {
      const p = buildCredentialKeyProvider({
        kmsVaultUrl: undefined,
        kmsSecretName: undefined,
        envVarKey: ENV_KEY_B64,
        envKeyId: "dev-v1",
        nodeEnv: "development",
        allowUnencrypted: false,
      });
      await expect(p.loadById("some-old-id")).rejects.toThrow(
        /only resolvable via the Azure Key Vault provider/,
      );
    });
  });

  describe("Azure Key Vault provider", () => {
    const provider = () =>
      buildCredentialKeyProvider({
        kmsVaultUrl: "https://vault.example.vault.azure.net",
        kmsSecretName: "brain-source-credential-key",
        envVarKey: undefined,
        envKeyId: "v1",
        nodeEnv: "production",
        allowUnencrypted: false,
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

    it("loadById() fetches the specific secret version and caches it", async () => {
      const raw = randomBytes(32);
      getSecret.mockResolvedValueOnce({ value: raw.toString("base64"), properties: {} });
      const p = provider();
      const key1 = await p.loadById("historical-version-id");
      expect(key1.equals(raw)).toBe(true);
      expect(getSecret).toHaveBeenLastCalledWith("brain-source-credential-key", {
        version: "historical-version-id",
      });

      // Second call for the same id must hit the cache, not Key Vault again.
      getSecret.mockClear();
      const key2 = await p.loadById("historical-version-id");
      expect(key2.equals(raw)).toBe(true);
      expect(getSecret).not.toHaveBeenCalled();
    });
  });

  it("'none' provider load() returns undefined", async () => {
    const p = buildCredentialKeyProvider({
      kmsVaultUrl: undefined,
      kmsSecretName: undefined,
      envVarKey: undefined,
      envKeyId: "v1",
      nodeEnv: "development",
      allowUnencrypted: false,
    });
    expect(await p.load()).toBeUndefined();
  });

  it("'none' provider loadById() throws", async () => {
    const p = buildCredentialKeyProvider({
      kmsVaultUrl: undefined,
      kmsSecretName: undefined,
      envVarKey: undefined,
      envKeyId: "v1",
      nodeEnv: "development",
      allowUnencrypted: false,
    });
    await expect(p.loadById("anything")).rejects.toThrow(/no key provider configured/);
  });

  it("rotation round-trip: ciphertext written under key A/id v1 decrypts via loadById while a different key is active", async () => {
    const keyA = randomBytes(32);
    const plaintext = { access_token: "rotate-me" };
    const { ciphertext, keyId } = encryptCredentials(plaintext, keyA, "v1");
    expect(keyId).toBe("v1");

    // Simulate the active provider having rotated forward, but still able to
    // resolve "v1" for old rows via loadById -- a stub in place of a real
    // "the vault now serves a different active version" scenario.
    getSecret.mockResolvedValueOnce({ value: keyA.toString("base64"), properties: {} });
    const provider = buildCredentialKeyProvider({
      kmsVaultUrl: "https://vault.example.vault.azure.net",
      kmsSecretName: "brain-source-credential-key",
      envVarKey: undefined,
      envKeyId: "v1",
      nodeEnv: "production",
      allowUnencrypted: false,
    });

    const resolvedKey = await provider.loadById(keyId);
    expect(decryptCredentials(ciphertext, resolvedKey)).toEqual(plaintext);
  });
});
