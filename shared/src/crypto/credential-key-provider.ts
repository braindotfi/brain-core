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
 * Azure Key Vault provider stub. The shape is fixed — the only thing missing
 * is the actual SDK call. When wiring it:
 *
 *   import { SecretClient } from "@azure/keyvault-secrets";
 *   import { DefaultAzureCredential } from "@azure/identity";
 *   const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
 *   const secret = await client.getSecret(secretName);
 *   return { key: Buffer.from(secret.value, "base64"), keyId: secret.properties.version };
 *
 * Until that's wired, this throws with a clear pointer rather than silently
 * falling back to env-var keys.
 */
class AzureKeyVaultCredentialKeyProvider implements CredentialKeyProvider {
  public readonly source = "azure-key-vault" as const;
  public constructor(
    private readonly vaultUrl: string,
    private readonly secretName: string,
  ) {}
  public async load(): Promise<CredentialKey> {
    throw new Error(
      `credential-key-provider: Azure Key Vault path is selected (vault=${this.vaultUrl}, secret=${this.secretName}) but the @azure/keyvault-secrets SDK is not wired yet. See shared/src/crypto/credential-key-provider.ts for the integration block.`,
    );
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
