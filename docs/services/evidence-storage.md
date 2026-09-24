# Evidence Storage

## Investigation Findings

Evidence is currently stored mostly as JSON pointers. Proposal actions carry
`evidence_ids`, `evidence`, `evidence_refs`, and `wiki_entity_ids`. The proposal
read model normalizes those into `ProposalEvidenceRef` objects with `kind`,
`ref`, and `resolvable`.

Ledger and canonical tables also carry `evidence_ids` string arrays. Those ids
usually point at raw parsed rows or source objects, not a dedicated evidence
content table.

Scanners emit evidence through the agent-router evidence gatherer. The
providers in `services/api/src/agents/evidence-providers.ts` turn Ledger and
Wiki rows into internal-agent `EvidenceRef` objects with fields such as `kind`,
`ref`, `source_system`, `object_type`, `object_id`, `confidence`, `timestamp`,
`hash`, and `excerpt`.

There is already a resolver endpoint at `POST /v1/evidence/resolve`. It resolves
typed proposal evidence refs for account, counterparty, invoice, obligation,
transaction, and wiki entity records. Unsupported kinds remain displayable but
are not dereferenced.

Content-addressed storage already exists for Raw artifacts. `raw_artifacts`
stores `sha256`, `blob_uri`, `mime_type`, and byte count, and the shared
`BlobAdapter` supports memory, S3, and Azure backends. There is not yet a
dedicated evidence table with openable files, external links, retention class,
or read-time tamper verification.

Tenant blob storage exists through the shared blob abstraction used by Raw,
exports, and purge jobs. Production uses object storage behind that adapter.
Local and test paths commonly use `MemoryBlobAdapter`.

## Model

The `evidence` table stores one user-facing evidence item per tenant. Content
items use `sha256://<digest>` storage refs and have a stored SHA-256 digest.
External links store the URL as `storage_ref` and leave `sha256` null.

`proposal_evidence_links` connects proposals to stored evidence ids. The
historical migration materializes existing proposal inline refs into external
evidence rows where possible, then leaves the original proposal payload
unchanged for backward compatibility.

## API

`POST /v1/evidence/upload` accepts base64 content, stores it by digest, and
returns the evidence metadata plus a short-lived URL.

`POST /v1/evidence/register-external` registers a URL-backed citation with no
stored bytes.

`POST /v1/evidence/generate` records generated report or data evidence and
stores a JSON snapshot of the generator input.

`GET /v1/evidence/{id}` returns metadata and a short-lived URL. For stored
content, the service reads bytes and recomputes SHA-256 before returning.

`GET /v1/evidence` lists evidence by proposal, kind, and captured date range.

`DELETE /v1/evidence/{id}` soft deletes evidence unless it is attached to an
open proposal.

## Storage

`EvidenceBlobStore` is the evidence-specific storage interface. Current
adapters are:

- `InMemoryEvidenceBlobStore` for tests and default local development.
- `LocalDiskEvidenceBlobStore` for local runs that need bytes to survive a
  process restart.
- `TodoEvidenceBlobStore` for S3 and GCS placeholder wiring.

Stored evidence uses content-addressed refs and can be tamper-checked without
trusting display metadata.

## Retention

`standard` evidence is archived after 90 days from proposal decision, or after
90 days from capture when it is not attached to any proposal. Archived rows stay
queryable.

`compliance_7yr` evidence is retained for seven years.

`permanent` evidence is never archived by the standard retention job.

## Tamper Verification

Every read of stored content recomputes SHA-256 and compares it to the database
value. A mismatch returns HTTP 409, emits `tamper_detected`, and records the
expected and observed hashes in the audit event.

## Scanner Attachment

Scanners can call `attachScannerArtifactEvidence` when they have a real artifact
such as a PDF, email body, or screening report. They can call
`attachScannerExternalEvidence` for external citations. Both helpers return a
normal internal-agent evidence ref with `ref` set to `evidence.id`.

Existing proposal payload readers continue to render inline evidence refs. New
payloads can point refs at stored evidence ids without changing the proposal
schema.
