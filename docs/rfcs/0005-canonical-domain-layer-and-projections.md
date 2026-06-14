# RFC 0005. Canonical domain layer and rebuildable projections

- Status: Accepted (Phase 5, slice 1)
- Spec: `brain-ingestion-architecture-final.md` §12 (canonical domain model and projections), §13 (authority), Phase 5
- Supersedes the "retained in raw_parsed for the Phase 5 rich domain" placeholders left by connectors 3–5.

## 1. Problem

Today the extractors write **directly** from `raw_parsed` into the compact
Ledger (11 entities). That is lossy by design: a Merge accounting page of
journal entries, GL accounts, payments, and tax rates has no home that
preserves double-entry structure, so those pages are pulled, interpreted into
`raw_parsed`, and then **dropped on the floor** by `merge_accounting_v1` (only
invoices→obligations and contacts→counterparties survive). The OaaS outcomes
Brain monetizes (close-the-books, tax optimization) need that structure.

The spec's answer (§12): keep **rich, versioned domain records**, and make
Ledger and Wiki **projections** of them. "Dumb uniform input, rich typed
output."

## 2. Decision

Introduce a **canonical domain layer** between Raw (layer 1) and Ledger
(layer 2), owned by a new `@brain/canonical` service. It holds rich, versioned
domain records. Ledger and Wiki become rebuildable projections of it.

Two decisions were taken explicitly (with the maintainer) before building:

1. **Scope: the accounting domain first.** Not all nine §12 domain groups.
   The accounting pages are the only rich data already landing with no home,
   and §12 + amendment 19.2 are emphatic about not building schemas
   speculatively ("Instantiate rich schemas only for the domains Brain
   monetizes now. Defer the rest until there is a paying use case"). GL
   account, journal entry, journal line ship now; tax/payroll/payments/identity
   domains are deferred.
2. **Placement: a new layer, not folded into Ledger or Raw.** The spec frames
   canonical as its own store ("Rich canonical domain stores, the Ledger and
   Wiki projections"). Folding it into Ledger would make Ledger own its own
   upstream source, breaking "writes flow upward only." Folding it into Raw
   would mix opaque-payload evidence with resolved, typed, cross-source domain
   records. A different job than Raw owns.

## 3. Layer model

```
Raw (1)  ──►  Canonical (1.5)  ──►  Ledger (2)  ──►  Wiki (3)
evidence      rich typed domain     compact truth     narrative
(opaque)      (versioned, §12)      (projection)      (projection)
```

Boundary rules (consistent with the existing six-layer rules):

- Canonical is **downstream of Raw** (reads `raw_parsed`) and **upstream of
  Ledger** (Ledger projects from it). Writes flow upward only.
- Canonical **never reads Wiki or Policy**, and never mutates Ledger/Audit
  directly. Ledger projection is a Ledger-owned read of canonical, not a
  canonical write into Ledger tables.
- Every canonical record carries `provenance` + `confidence` + `source_ids`
  (raw_artifact) + `evidence_ids` (raw_parsed): provenance-complete per §1.1.
- Provider-only fields live in namespaced `extensions`, never flattened into
  shared columns (§12).

## 4. Rebuildability

The AC for Phase 5 is: **Ledger and Wiki can be rebuilt from canonical without
recontacting providers.** The pipeline is already replay-safe end to end
(idempotent interpreters and extractors; `normalization_log` /
`raw_interpretation_log` consumption markers; Wiki regenerates from Ledger).
This RFC adds the missing middle link:

- **raw_parsed → canonical** is idempotent on `(tenant_id, source_system,
source_natural_key)`. Replaying a page upserts in place. A
  `canonical_projection_log` row per `raw_parsed_id` lets the projector poll
  only unconsumed rows; deleting log rows re-derives canonical from history.
- **canonical → Ledger** (PR-C) regenerates the projected Ledger surface from
  canonical alone.

### 4.1 The human/agent overlay problem

A naive "rebuild Ledger from canonical" would **erase authority that is not
provider-derived**: `setStatus` confirmations, the Phase 4 corroboration lift,
`human_confirmed` name authority. These are §13 "the user owns intent and
approved corrections" facts. They must survive a rebuild.

Therefore _rebuild_ is defined as: **regenerate the provider-derived projection
from canonical, then reapply the retained human/agent overlay.** PR-C carries
the overlay-reapplication design; the invariant is that rebuilding from
canonical is lossless with respect to human decisions, not just provider data.

## 5. Schema (slice 1, `migrations/0001`)

- `canonical_gl_account`. Chart of accounts. Classification normalized to
  {asset, liability, equity, revenue, expense, unknown}; raw value retained in
  extensions.
- `canonical_journal_entry`. Double-entry header.
- `canonical_journal_line`. Debit/credit legs; references the GL account by
  remote key and, once resolved, by `canonical_gl_account` id.
- `canonical_projection_log`. Projector consumption tracker.

All tenant-scoped tables arm RLS (`ENABLE` + `FORCE`), enforced under the
non-owner `brain_app` role per `infra/db-roles.sql`.

## 6. What this RFC does NOT do

- No Ledger/Wiki projection wiring yet (PR-C). The extractors keep writing
  Ledger directly until the projection lands; this slice is purely additive and
  changes no existing flow.
- No JSON Schema validation wiring. Per amendment 19.2 the MVP uses the
  existing provenance enum and does not build the multidimensional evidence
  model speculatively. The TS types + migration CHECKs are the contract for now.
- No new HTTP surface. Canonical is populated by a background projector (PR-B)
  and read by the Ledger projection (PR-C); no external endpoints in this slice.

## 7. Rollout

- **PR-A (this RFC):** layer foundation. Workspace, migration, domain types,
  pure double-entry/classification helpers. No behavior change.
- **PR-B:** the projector. `merge_accounting_canonical_v1` reads the retained
  Merge gl_account/journal_entry pages into canonical records; idempotent,
  replayable, logged.
- **PR-C:** Ledger projects from canonical; rebuild command + overlay
  reapplication; AC test (rebuild without recontacting providers).
- **PR-D:** docs (six-layer table), CLAUDE.md, any invariant, full verification.
