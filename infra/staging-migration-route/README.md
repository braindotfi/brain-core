# Temporary VM-to-staging migration route

This root creates the temporary, private network path used by Task 2. It is
separate from recurring staging deployment because the source-VNet private
endpoint and private-DNS link require authority on the authoritative VM
network. The staging deployment principal must not receive that authority.

## What it creates

- a second private endpoint for the migration Blob account, placed directly in
  an approved subnet in the production VM VNet
- a link from the staging Blob private DNS zone to the source VNet

This is intentionally narrower than VNet peering. It gives the VM private
reachability to the dedicated Blob account without creating general network
reachability between the production and staging VNets. The migration account
still enforces Entra authorization.

## Task 1 gates

Before planning this root, record:

- exact source VM, resource group, subscription, VNet, and approved private
  endpoint subnet
- whether the source VNet uses Azure-provided DNS
- the operator identity authorized on both VNet resources
- the approved route expiry and removal owner

This implementation directly links the private Blob DNS zone to a source VNet
that uses Azure-provided DNS. If Task 1 finds custom DNS,
`source_uses_azure_provided_dns = false` makes the plan fail. A custom
conditional forwarder or Azure Private Resolver design then requires separate
review. Do not substitute a public Blob firewall exception.

## Validation

From the production VM, the normal Blob hostname must resolve exclusively to a
private RFC 1918 address. `scripts/ops/staging-migration-upload.sh` enforces
that check before issuing a SAS or uploading a canary. The in-VNet validation
job must then decrypt and remove the disposable canary before real extraction
is authorized.

## Removal

Destroy this root through its own reviewed state after the run. Confirm the
source-VNet private endpoint and DNS link are absent. Removing the route must
not destroy the source VNet, staging VNet, storage account, or staging private
DNS zone.
