# Recovery objectives (RPO / RTO)

Recovery Point Objective (RPO = max acceptable data loss) and Recovery Time
Objective (RTO = max acceptable downtime) per data store, for the MVP / staging
posture (single region, East US). Enterprise diligence asks for these; "we don't
know" is the worst answer.

| Store                       | RPO                                                              | RTO                                                       |
| --------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| **Postgres** (primary)      | ≤ 5 min — Azure Database for PostgreSQL Flexible Server PITR. <br>TODO(brain-hardening): confirm the configured backup/redo cadence + retention in Terraform. | ≤ 1 hour target (PITR restore + app redeploy). <br>TODO(brain-hardening): confirm against Azure managed Postgres SLA. |
| **Raw blob store** (Azure Blob) | Near-zero — geo/zone-redundant storage (immutable payloads, write-once). <br>TODO(brain-hardening): confirm redundancy tier (LRS/ZRS/GRS) in Terraform. | ≤ 1 hour (re-point readers; objects are immutable, no replay needed). |
| **Redis** (cache + idempotency + rate-limit windows) | **No RPO commitment** — cache only. Idempotency keys (24h TTL) and rate-limit windows are reconstructible; loss degrades dedup/limits transiently, never correctness (the §6 gate's duplicate guard 11.5 is DB-backed). | RTO ≈ container restart time (seconds–minutes). |
| **Audit chain** (Postgres + on-chain anchor) | Same as Postgres for the rows; the on-chain anchor is permanent once broadcast. | Verification (`POST /v1/audit/verify`) is a pure function — available as soon as the API is up. |

## Smart-contract anchoring

- **Cadence:** the anchor publisher batches audit events and broadcasts a Merkle
  root to `BrainAuditAnchor` on a fixed interval (background worker).
- **Max acceptable gap** between an event and its anchor: **2 hours** (the
  Standards alert threshold). Beyond that, alert; the off-chain chain remains
  verifiable in the interim.
  TODO(brain-hardening): confirm the configured publish interval in the worker config.

## Cross-region

**Single region (East US) at MVP/staging.** Multi-region active-passive (and the
associated cross-region RPO/RTO) is **deferred to post-Series A**. The audit
on-chain anchor is the one inherently cross-region durability guarantee today.

> Numbers marked `TODO(brain-hardening)` need confirmation against the actual
> Terraform / Azure SLA configuration before they go in a customer-facing SLA.
