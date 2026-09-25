# CI MinIO Image Mirror

The TypeScript integration job starts a short lived MinIO fixture before
running the worker policy tests. Direct pulls from `quay.io/minio/minio` can
return `unauthorized` in GitHub hosted CI, even when the image is pinned by
digest. The fixture therefore pulls the same pinned image content from GHCR.

The CI defaults are:

- Server: `ghcr.io/braindotfi/mirror-minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`
- Client: `ghcr.io/braindotfi/mirror-minio-mc:RELEASE.2024-10-08T09-37-26Z@sha256:c0d345a438dcac5677c1158e4ac46637069b67b3cc38e7b04c08cf93bdee4a62`

Run the manual `Mirror MinIO CI images` workflow after changing either pin.
The workflow copies the upstream Quay image into GHCR with `skopeo copy
--preserve-digests` and verifies the manifest digest before exiting.

If Quay requires authentication during mirroring, set repository secrets
`MINIO_QUAY_USERNAME` and `MINIO_QUAY_PASSWORD`. The normal pull path in CI does
not need those Quay credentials.

Production deploy compose files still use the existing Quay pins. This change is
limited to the CI fixture that was failing before the test suite started.
