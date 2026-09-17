# x402 Key Vault Premium bootstrap

This isolated Terraform root provisions the Base Sepolia-only x402 seller
custody boundary. It replaces the unapplied Managed HSM scaffold in the main
production root. It creates no Container Apps resource, container registry,
wallet funding, Coinbase credential, sandbox tenant, or payment activation.

The source and restore-drill vaults use the Premium tier. The seller key is
generated inside Azure as a non-exportable `EC-HSM` `P-256K` key with only the
`sign` operation. Its address is classified
`x402_sepolia_bootstrap_only`. The runtime managed identity receives one custom
data action, `Microsoft.KeyVault/vaults/keys/sign/action`, at the exact key
resource scope. It receives no create, import, export, backup, restore, delete,
purge, rotate, encrypt, decrypt, wrap, unwrap, vault, role, or network access.

The key is declared through the Key Vault ARM resource provider. A hosted
GitHub runner therefore needs only ARM and Terraform-state connectivity for
plan and apply. It does not need data-plane connectivity to the private vault,
an Azure Container Registry, or the paused Container Apps Terraform job. The
witnessed restore drill does use the vault data plane and must run from a
short-lived host attached to `snet-restore-drill-runner`. That host uses the
public Azure CLI image directly and does not require a private registry or the
Container Apps production stack.

## Dual approval

Any apply is blocked by two sequential GitHub environments:

1. `x402-treasury-approval`, whose only required reviewer is Damon
   (`damonnam`, GitHub user id `6476148`).
2. `x402-security-approval`, whose only required reviewer is Sanket
   (`sanketdebnath24`, GitHub user id `124357033`).

The apply job checks the live environment protection configuration before
authenticating to Azure. The reviewer sets are disjoint, so a single person
cannot satisfy both gates. Self-review prevention is intentionally not required:
with exactly two operators it would prevent either operator from dispatching
the workflow and completing their own distinct approval. The final `production`
environment remains a third deployment boundary and supplies the OIDC
configuration.

Plan is read-only. Apply additionally requires the exact string
`APPLY-X402-SEPOLIA-KEY-VAULT-BOOTSTRAP`, a successful plan run against the
same full main SHA, and the exact saved Terraform plan.

## Restore drill

The reviewed drill operator is
`scripts/ops/x402-key-vault-restore-drill.mjs`. Damon and Sanket witness the
run. The operator requires temporary, separately approved source backup,
restore-vault restore, read, and sign permissions. Those permissions are not
assigned by this root and must be removed immediately after the receipt is
written.

The drill writes the Azure-protected backup blob only to a mode-0600 temporary
directory. It restores into the isolated Premium vault in the same subscription
and geography, then proves:

- the restored public key fingerprint matches the source;
- both keys derive the same checksummed EVM address;
- both keys sign a fixed challenge and both signatures verify;
- the source and restored key types are `EC-HSM`, curve `P-256K`, and key
  operations exactly `sign`.

The backup file is deleted on exit. The receipt contains only public metadata,
hashes, signature verification booleans, resource identifiers, and timestamps.

## Mainnet prohibition

This root validates chain id `84532` only. Runtime configuration rejects a Key
Vault URI on chain id `8453`. Mainnet requires a genuinely new key generated
inside a `.managedhsm.azure.net` resource, at least three real recovery
holders, a full security-domain ceremony, a witnessed backup and restore
receipt, and full custody reapproval. The Premium-vault key is never migrated
or accepted for mainnet.
