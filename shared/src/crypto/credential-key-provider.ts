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
 *   3. Nothing set → no-encryption mode. Forbidden in production unless
 *      `allowUnencrypted` is explicitly set (see `buildCredentialKeyProvider`).
 *
 * Both providers are fully implemented: the KMS path authenticates via
 * `DefaultAzureCredential` and reads a base64-encoded 32-byte key from a Key
 * Vault secret.
 *
 * Rotation semantics: a stored ciphertext's `credential_key_id` is the Key
 * Vault secret VERSION it was encrypted under, not a static name. Rotating
 * the secret creates a new version and the active version moves forward, but
 * old ciphertext still names its original version. Decrypting it later must
 * resolve that specific historical version rather than assume the active
 * key — that is what `loadById` is for; the Key Vault secret's own version
 * history IS the keyring, no separate keyring config exists.
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
  /**
   * Resolves the key material for a historical key id (as stored on a row's
   * `credential_key_id`), so ciphertext written under a previous key stays
   * decryptable after rotation.
   */
  loadById(keyId: string): Promise<Buffer>;
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
  /**
   * Explicit operator opt-out from the production credential-encryption fence
   * (`BRAIN_ALLOW_UNENCRYPTED_SOURCE_CREDENTIALS=true`). When false (default),
   * a resolved `none` provider in production throws at boot instead of
   * silently running without encryption.
   */
  allowUnencrypted: boolean;
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
  public async loadById(keyId: string): Promise<Buffer> {
    if (keyId !== this.opts.envKeyId) {
      throw new Error(
        `credential-key-provider: env-var provider has no key for id '${keyId}' ` +
          `(active id is '${this.opts.envKeyId}'); historical key ids are only ` +
          "resolvable via the Azure Key Vault provider",
      );
    }
    const key = decodeEnvCredentialKey({
      envVarKey: this.opts.envVarKey,
      nodeEnv: this.opts.nodeEnv,
    });
    if (key === undefined) {
      throw new Error("credential-key-provider: env-var provider has no key configured");
    }
    return key;
  }
}

class NoneCredentialKeyProvider implements CredentialKeyProvider {
  public readonly source = "none" as const;
  public async load(): Promise<undefined> {
    return undefined;
  }
  public async loadById(keyId: string): Promise<Buffer> {
    throw new Error(
      `credential-key-provider: no key provider configured; cannot resolve key id '${keyId}'`,
    );
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
  // Historical key ids resolved via loadById(), cached so a rotation does not
  // mean a Key Vault round-trip on every decrypt of old ciphertext.
  private readonly byId = new Map<string, Buffer>();
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
  public async loadById(keyId: string): Promise<Buffer> {
    const cached = this.byId.get(keyId);
    if (cached !== undefined) return cached;
    const secret = await this.client.getSecret(this.secretName, { version: keyId });
    if (secret.value === undefined) {
      throw new Error(
        `credential-key-provider: Key Vault secret '${this.secretName}' version '${keyId}' has no value`,
      );
    }
    const key = Buffer.from(secret.value, "base64");
    if (key.length !== 32) {
      throw new Error(
        `credential-key-provider: Key Vault secret '${this.secretName}' version '${keyId}' decodes to ${key.length} bytes; expected 32 (AES-256)`,
      );
    }
    this.byId.set(keyId, key);
    return key;
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
  if (opts.nodeEnv === "production" && !opts.allowUnencrypted) {
    throw new Error(
      "credential-key-provider: no source-credential key configured in NODE_ENV=production. " +
        "Set BRAIN_AZURE_KEY_VAULT_URL + BRAIN_SOURCE_CREDENTIAL_KEY_VAULT_NAME, or set " +
        "BRAIN_ALLOW_UNENCRYPTED_SOURCE_CREDENTIALS=true to explicitly opt out (source " +
        "credentials will not be stored).",
    );
  }
  return new NoneCredentialKeyProvider();
}
