/**
 * Credential-key provider — selects between the dev/staging env-var path and
 * the production Azure Key Vault path for the AES-256-GCM source-credential
 * key, with a single fail-closed boot fence.
 *
 * Selection rules (evaluated at boot, in order):
 *
 *   1. `BRAIN_AZURE_KEY_VAULT_URL` + `BRAIN_SOURCE_CREDENTIAL_KEY_VAULT_NAME`
 *      both set → KMS path. Production must take this branch.
 *   2. `BRAIN_SOURCE_CREDENTIAL_KEY` set → env-var path. Forbidden in
 *      production (boot throws via {@link decodeEnvCredentialKey}).
 *   3. Nothing set → no-encryption mode. Forbidden in production; the caller
 *      decides whether to allow it elsewhere.
 *
 * Today the KMS provider is a documented throw — wiring `@azure/keyvault-keys`
 * + `@azure/identity` is the remaining mechanical step. The seam exists so
 * that wiring is a single-file change rather than a boot-path rewrite.
 */

import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential } from "@azure/identity";
import { decodeEnvCredentialKey } from "./aes-gcm.js";

export interface CredentialKey {
  key: Buffer;
  keyId: string;
}

export interface CredentialKeyProvider {
  /** Returns the active credential key, or undefined if no key is configured. */
  load(): Promise<CredentialKey | undefined>;
  /** Human-readable description of the active provider, for the boot capability log. */
  readonly source: "azure-key-vault" | "env-var" | "none";
}

export interface CredentialKeyProviderOptions {
  /** Azure Key Vault URL (https://<vault>.vault.azure.net). Pairs with `kmsSecretName`. */
  kmsVaultUrl: string | undefined;
  /** Name of the Key Vault secret holding the base64-encoded 32-byte key. */
  kmsSecretName: string | undefined;
  /** Base64-encoded 32-byte AES key (dev/staging only). */
  envVarKey: string | undefined;
  /** Stable id for the active key (logged with every encrypt; advances on rotation). */
  envKeyId: string;
  /** `process.env.NODE_ENV`. Controls the env-var-in-prod fence. */
  nodeEnv: string | undefined;
}

class EnvCredentialKeyProvider implements CredentialKeyProvider {
  public readonly source = "env-var" as const;
  public constructor(private readonly opts: CredentialKeyProviderOptions) {}
  public async load(): Promise<CredentialKey | undefined> {
    const key = decodeEnvCredentialKey({
      envVarKey: this.opts.envVarKey,
      nodeEnv: this.opts.nodeEnv,
    });
    if (key === undefined) return undefined;
    return { key, keyId: this.opts.envKeyId };
  }
}

class NoneCredentialKeyProvider implements CredentialKeyProvider {
  public readonly source = "none" as const;
  public async load(): Promise<undefined> {
    return undefined;
  }
}

/**
 * Azure Key Vault provider. Authenticates via DefaultAzureCredential, which
 * chains managed identity (production), workload identity (AKS), Azure CLI
 * (dev override), and others. The secret value is a base64-encoded 32-byte AES
 * key — same format as the env-var path so rotation moves the value, not the
 * format. The secret version is used as the keyId so a key rotation in Key
 * Vault is observable end-to-end (logged with every encrypt + carried into
 * ciphertext metadata).
 *
 * The SecretClient is constructed once per provider instance and reused. The
 * caller is expected to call load() once at boot (cached by the consumer); we
 * intentionally do not cache here because rotation should be observable on the
 * next boot, not silently masked by an in-process cache.
 */
class AzureKeyVaultCredentialKeyProvider implements CredentialKeyProvider {
  public readonly source = "azure-key-vault" as const;
  private readonly client: SecretClient;
  public constructor(
    vaultUrl: string,
    private readonly secretName: string,
  ) {
    this.client = new SecretClient(vaultUrl, new DefaultAzureCredential());
  }
  public async load(): Promise<CredentialKey> {
    const secret = await this.client.getSecret(this.secretName);
    if (secret.value === undefined) {
      throw new Error(
        `credential-key-provider: Key Vault secret '${this.secretName}' has no value`,
      );
    }
    const key = Buffer.from(secret.value, "base64");
    if (key.length !== 32) {
      throw new Error(
        `credential-key-provider: Key Vault secret '${this.secretName}' decodes to ${key.length} bytes; expected 32 (AES-256)`,
      );
    }
    const keyId = secret.properties.version ?? this.secretName;
    return { key, keyId };
  }
}

/**
 * Boot-time factory. Picks the provider per the selection rules; never
 * silently downgrades from KMS to env-var.
 */
export function buildCredentialKeyProvider(
  opts: CredentialKeyProviderOptions,
): CredentialKeyProvider {
  if (
    opts.kmsVaultUrl !== undefined &&
    opts.kmsVaultUrl.length > 0 &&
    opts.kmsSecretName !== undefined &&
    opts.kmsSecretName.length > 0
  ) {
    return new AzureKeyVaultCredentialKeyProvider(opts.kmsVaultUrl, opts.kmsSecretName);
  }
  if (opts.envVarKey !== undefined) {
    return new EnvCredentialKeyProvider(opts);
  }
  return new NoneCredentialKeyProvider();
}
