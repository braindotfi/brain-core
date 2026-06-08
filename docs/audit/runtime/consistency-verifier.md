# Audit-consistency verifier: coverage and known boundaries

The runtime audit-consistency verifier (`services/audit/src/audit-consistency.ts`)
is a background detective control over the per-tenant hash chain in
`audit_events`. It runs on a fixed cadence (default every 10 minutes) and has two
layers, both confined to the audit service's own table (no cross-service read):

- **Structural** (`checkAuditConsistency`, global every cycle): fork (two events
  share a predecessor), gap (a predecessor matches no `event_hash`), and genesis
  cardinality (a tenant without exactly one null-predecessor event).
- **Content** (`verifyContentHashCursor`, paged via a durable cursor): recompute
  each event's canonical hash and compare it to the stored `event_hash`, so a
  mutation that left the chain structurally connected is still caught. A durable
  cursor (`audit_verifier_checkpoint`) advances through the table so that over
  successive cycles every covered event is verified, not just the newest N.

A non-zero structural count, or a content `hashMismatch`, is a P0-grade signal:
the Merkle chain the on-chain anchor commits to is no longer a single, faithful,
linear history for that tenant. Content mismatches also persist as durable
`audit_integrity_findings` rows that stay OPEN until an operator resolves them, so
the signal survives a later clean pass (the sticky
`brain.audit.consistency.open_findings.count` gauge).

## Content-verification coverage boundary (disclosed, not silent)

Content recomputation can only cover rows whose `hash_schema_version` matches the
**current** scheme this build knows how to hash (`AUDIT_HASH_SCHEMA_VERSION`). Two
populations therefore fall outside content recomputation and are reported
separately rather than implicitly treated as verified:

| Population          | `hash_schema_version` | Gauge                                               | Meaning                                                                                                          |
| ------------------- | --------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Unsupported (newer) | `> current`           | `brain.audit.consistency.unsupported_version.count` | Written by a newer deployment than this build; recompute would be wrong. Transient during a rollout.             |
| Legacy (older / v0) | `< current`           | `brain.audit.consistency.legacy_unverifiable.count` | Pre-versioning rows this build cannot recompute. A permanent population until/unless a legacy verifier is built. |

Both populations remain covered by the **structural** fork/gap/genesis checks, so
a tamper that breaks chain linkage is still caught for them. What is NOT covered
for them is content-level recomputation: an in-place edit that preserved the
stored (legacy-scheme) hash relationships would not be re-derived by this build.

This is a deliberately **disclosed** gap. The legacy gauge is emitted every cycle
so an operator dashboard or alert can watch the population, but it is intentionally
**not** folded into the per-cycle integrity error log: a permanent legacy
population is a known coverage gap, not a per-cycle break, and must not generate
recurring P0 noise.

### Not done (deferred)

A dedicated legacy verifier that re-derives v0 hashes with the historical
canonicalization is out of scope here. The honest disclosure (count + gauge +
this note) is the fix for the blind spot; building a multi-version recompute path
is a larger, separately scoped change. If the legacy gauge is non-zero and that
population must be content-verified, that work should be scheduled explicitly
rather than assumed to be covered.

> Origin: Codex review `307161b` P2 #5.
