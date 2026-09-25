# MinIO Production Image Source Plan

## Current State

Production deploy still pulls MinIO directly from Quay:

- `docker-compose.prod.yml` uses `quay.io/minio/minio` for the MinIO server.
- `docker-compose.prod.yml` uses `quay.io/minio/mc` for MinIO setup containers.
- `.github/workflows/ops-minio-worker-scope.yml` uses `quay.io/minio/mc`.
- `.github/workflows/ops-minio-api-surface-scope.yml` uses `quay.io/minio/mc`.

The images are pinned by digest, which protects version selection, but the
registry source is still a live dependency during recreate.

## If MinIO Is Recreated Today

If Quay returns `unauthorized` or rate limits production during a compose
recreate, Docker cannot pull the pinned MinIO image. A host that already has the
image cached may continue, but a clean host, a host after image pruning, or a
replacement VM can fail before MinIO starts.

The likely impact is a blocked deploy or recovery action. Existing data is not
changed by a failed image pull, but object-store availability can be delayed if
the recreate already stopped the running container.

## Safe Fix

Mirror the same pinned MinIO server and client image manifests into a registry
we operate, such as GHCR or Azure Container Registry. Keep the tag and digest
pin. Do not change the MinIO version during this move.

Recommended rollout:

1. Mirror the current pinned server and client images into the owned registry.
2. Verify the mirrored manifest digest matches the existing Quay digest.
3. Make the mirrored packages private to the deployment principal or public only
   if that is the repository policy.
4. Add a staging-only compose change that points MinIO server and client images
   at the mirror with the same digest.
5. Recreate staging MinIO from the mirror and verify health, bucket policies,
   legal hold operations, and API and worker object access.
6. Update production compose and the two MinIO ops workflows to use the mirror.
7. Run `scripts/check-required-compose-secrets.sh` before production recreate.
8. Recreate production during a maintenance window, with the old Quay image
   references recorded as rollback metadata.

## Fallback Source

Use another source only if it can prove the exact same manifest digest. A tag
match is not enough. If Quay blocks mirroring and Docker Hub cannot prove the
same digest, pause and choose either authenticated Quay access or a vendor
provided signed artifact path. Do not switch to another image version without a
separate approval.

## Open Decisions

- Choose GHCR or Azure Container Registry for production mirrors.
- Decide whether production mirror packages are private or public.
- Decide who owns mirror refresh operations and digest verification.
- Decide whether CI and production should share one mirror namespace or separate
  namespaces.
