# RFC 0004. Source-agnostic document ingestion and the confidence path to autonomy

- **Status:** Proposed. Awaiting human signoff before implementation.
- **Date:** 2026-06-05
- **Authors:** ai-assisted
- **Affects:** `Brain_MVP_Architecture.md` Layers 1-3 and 5, `Brain_Engineering_Standards.md`
  §1 Non-Negotiable Principles + §6 gate, `Brain_API_Specification.yaml`
  (`/ledger/normalize` `target_entities` enum), `services/raw` (a new parser
  registry + document-extractor agent), `services/ledger` (new deterministic
  extractors in `normalizeFromRaw`, new `upsertObligationRow` in
  `service/writes.ts`), `services/raw` (a sanctioned `raw_parsed` write route,
  the first producer of that table in the system), `services/wiki`
  (question-corpus extension), and a new Python agent under
  `services/agents/brain_agents/document_extractor/`. Stage 2 additionally
  touches the confidence-plumbing path: `shared/src/gate/gate.ts`
  (`GatePaymentIntent`), `services/policy/src/service.ts` (`evaluateForGate`),
  `services/ledger/src/repository/payment_intents.ts` (drop the hardcoded `1.0`),
  and `services/ledger/src/reconciliation/persist.ts` (confidence write-back).

> This RFC answers a product question: can a company test and adopt Brain by
> uploading the financial documents it already has (bank statements, invoice
> spreadsheets, contracts, GL exports) rather than connecting Plaid, and can
> Brain then organize that data, answer questions about it, and eventually act
> on it autonomously?
>
> The answer is yes, with one hard rule preserved: **Wiki informs what Brain
> proposes; Ledger authorizes what Brain executes.** No part of this design
> lets a payment execute off Wiki data or off low-confidence extraction. The
> §6 gate is unchanged.
>
> This document is spec-only. No code ships with the RFC itself.

## 1. Problem. The financial brain should accept any source, not just Plaid

Today the only wired Raw-to-Ledger path is Plaid. `LedgerService.normalizeFromRaw`
(`services/ledger/src/service/LedgerService.ts:260`) is a `switch(parser)` with
exactly one implemented case, `plaid_tx_v1`, and the normalize worker
(`services/ledger/src/workers/normalizeWorker.ts`) polls `raw_parsed` only for
that parser. An uploaded PDF or spreadsheet ingests into Raw fine
(`source_type=upload` already works) but then sits inert: no parser is assigned,
no Ledger rows are produced, and the Wiki and the agents have nothing to ground
on.

That is a product gap. A prospect's first-touch friction should be "drag in the
files you already have," not "grant a third party access to your bank." Plaid
should be one source among many, not the gate to value.

A trace of the current pipeline (resolving what was open question 1 in the first
draft) found the gap is deeper than "upload has no parser." **Nothing in the
system writes `raw_parsed` today, for any source, including Plaid.** The migration
header says so outright: "Populated by stage-3 extractors; stage-2 only creates
the schema" (`services/raw/migrations/0002_raw_parsed.sql`). Raw exposes no write
route for parsed records (only `GET /raw/{id}/parsed`). The Plaid extractor agent
posts artifacts to `/raw/ingest` but nothing promotes those artifacts into
`raw_parsed`. The golden-path demo works only because the seed tool writes Ledger
rows directly and references fake `raw_parsed` ids in `evidence_ids`; the normalize
worker polls an empty table and processes zero rows.

So the Raw to `raw_parsed` to Ledger-normalize chain has a built consumer (Ledger
normalize) and an unbuilt producer (the stage-3 parse layer). This RFC delivers
that producer. The document extractor is therefore not a special case bolted onto
a working pipeline; it is the first real implementation of a stage that was always
planned, and the write mechanism it needs is reusable infrastructure, not
document-specific.

Two truths have to coexist for this to work:

### Truth A. Ingestion is source-agnostic by design

Raw already declares eight `source_type` values and the Ledger has 11 typed
entities precisely so that any financial document maps onto the same machine
truth. The mapping we want:

| Document                      | Target Ledger entities                                      |
| ----------------------------- | ----------------------------------------------------------- |
| Bank statement (PDF / CSV)    | `account`, `transaction`, `balance`                         |
| Invoice spreadsheet export    | `obligation` (payable / receivable), `counterparty`         |
| Contract                      | `obligation` (recurring commitments, terms), `counterparty` |
| GL / financial-records export | `transaction`, `category`, `counterparty`                   |

### Truth B. Autonomy is earned through confidence, not granted by ingestion

Knowing a fact is not the same as being authorized to act on it. The §6 gate
authorizes a payment only against high-confidence Ledger truth. Data an LLM
extracts from an arbitrary document is deliberately low-trust and is capped at
`confidence <= 0.5` for `agent_contributed` provenance, enforced in code at
`services/ledger/src/service/writes.ts:31`. That cap is not an obstacle to the
vision; it is the honest statement that a model's reading of a scanned statement
is not yet trustworthy enough to move money against unattended.

## 2. Non-goals and preserved invariants

This RFC does **not** change, and explicitly preserves:

1. **Policy and Execution never read Wiki** (Standards §1, Principle #5). The
   §6 gate reads Ledger only. Wiki is narrative recall. A hallucinated memory
   structurally cannot authorize a payment.
2. **The §6 deterministic gate.** No new check, no removed check, no LLM
   judgment in the gate. Extracted data enters the gate the same way Plaid data
   does: as Ledger rows with provenance and confidence.
3. **Agents never mutate Ledger directly.** The only sanctioned upward writes
   remain (a) contributions into Raw and (b) the Agent layer creating
   PaymentIntent rows. The document extractor writes into Raw, never into Ledger.
4. **Layer-1 immutability.** Uploaded artifacts are never mutated; extraction
   re-derives, it does not edit.

Out of scope (deferred, not part of this RFC):

- Free-text RAG over the raw document body (the pgvector "Phase 5" path). The
  Q&A in this RFC grounds in the structured Ledger rows extracted from the
  document, which is what the requester confirmed they want.
- New execution rails. The four existing rails are sufficient; on-chain rails
  already require no Plaid.

## 3. Design

### 3.1 The clean shape: extraction is a Raw contribution

```
upload (source_type=upload)                                   [exists today]
  -> document-extractor agent reads the blob via the Raw API,
     runs LLM / OCR, writes a raw_parsed row                  [NEW: contribution INTO Raw, exception (a)]
       parser = 'doc_statement_v1' | 'doc_obligation_v1' | ...
       extracted = typed JSON, confidence = model score
  -> Ledger normalize promotes raw_parsed -> candidate rows   [NEW: deterministic extractor in the switch]
       provenance = agent_contributed -> confidence auto-capped <= 0.5
       source_ids / evidence_ids = [raw_parsed_id]
  -> EXISTING Wiki page-gen, Wiki Q&A, agent-router, reconciliation light up
```

The load-bearing decision: **all non-deterministic model judgment lives in the
Raw-contributing agent.** The Ledger-side extractor is deterministic glue that
maps already-extracted JSON onto typed rows. This mirrors the existing Plaid
split (the Plaid extractor agent is deterministic; here the document extractor
is an LLM, but its output is quarantined as a low-confidence Raw contribution
and never enters the deterministic normalize or gate paths as authoritative).

### 3.2 Parser registry, keyed by document type

Generalize the single `plaid_tx_v1` case into a registry. Each parser declares:

- a stable `parser` id and `parser_version`,
- the `source_type` values it accepts,
- whether it is deterministic (structured exports: CSV / XLSX) or
  model-based (PDF / scan),
- the target Ledger entities it can produce.

The normalize worker's poll filter changes from a hardcoded `parser =
'plaid_tx_v1'` to "any registered parser," and `normalizeFromRaw` dispatches by
registry lookup instead of an inline switch.

### 3.3 Ledger write surface

`services/ledger/src/service/writes.ts` today has `upsertAccountRow`,
`upsertCounterpartyRow`, and `recordTransactionRow`, each routing through
`cappedConfidence`. This RFC adds `upsertObligationRow` with the same cap and
provenance handling. The obligation entity is the priority target because:

- it needs no bank account, so it is creatable in the no-Plaid case;
- it powers the Q&A the requester wants ("what do I owe, what is due, what is
  overdue").

Correction discovered during implementation: the obligations **table**
(`migrations/0007_ledger_obligations.sql`) requires `counterparty_id NOT NULL`
and uses `type` / `amount_due` / `due_date`, which does **not** match the
`schemas/entity/obligation` JSON schema (`direction` / `amount` / `due_at`, no
counterparty). So an obligation is not counterparty-free: the extractor resolves
the document's named party into a counterparty first, then writes the obligation
referencing it. The schema-vs-table mismatch is a pre-existing inconsistency
(the `account` and `transaction` writers have the same gap) and is flagged for a
separate reconciliation, not fixed here.

Statement and GL parsers reuse the existing account / transaction / counterparty
write methods.

### 3.4 API contract

The `/ledger/normalize` `target_entities` enum in `Brain_API_Specification.yaml`
already includes `obligation`, so no Ledger-spec change is needed. The one new
endpoint is the Raw `raw_parsed` write path described in 3.6. Ingestion still
uses the existing `POST /raw/ingest`.

### 3.5 Wiki corpus

`services/wiki/src/question/orchestrator.ts` grounds Q&A in
`ledger_transactions`, `ledger_obligations`, and `ledger_counterparties`.
Obligations are already in the corpus, so statement-derived transactions and
document-derived obligations both become answerable with no Wiki change for the
obligation path. Confirm the transaction path is exercised for statement
imports.

### 3.6 The `raw_parsed` write path (the stage-3 producer this RFC delivers)

There is no write path into `raw_parsed` today (see §1). This RFC specifies the
first one, as reusable Raw-owned infrastructure rather than a document-only hook:

- **A new authenticated route, `POST /raw/{id}/parsed`,** owned by `services/raw`.
  It writes one `raw_parsed` row for the referenced `raw_artifact_id`, carrying
  `parser`, `parser_version`, `extracted` (typed JSON), and `confidence`. It
  enforces the table's existing `UNIQUE (raw_artifact_id, parser, parser_version)`
  constraint (idempotent re-post returns the existing row), is tenant-scoped under
  RLS, and emits an audit event like every other write.
- **The document-extractor agent calls this route over HTTP**, exactly as
  `plaid_extractor` already calls `/raw/ingest`. The agent never touches the
  `raw_parsed` table directly, preserving "agents write only via the owning
  service's API." Non-deterministic model output enters the system here, as a
  low-confidence Raw contribution, and nowhere else.
- **Deterministic parsers** (structured CSV / XLSX) may instead run as an in-Raw
  parse worker that writes through the same internal code path, since they need no
  model and no external agent. Both routes converge on the same Raw-owned writer.

This also retroactively completes the Plaid pipeline: a `plaid_tx_v1` producer
posting to the same route would let real Plaid artifacts flow through normalize
instead of relying on seed-inserted Ledger rows. That is noted as a beneficiary,
not required scope for this RFC.

## 4. The Wiki / Ledger split, made explicit

This is the answer to "the agents should work based on the wiki layer and the
financial brain." They already do, correctly:

- **Agents reason over the whole financial brain to propose.** The
  `EvidenceGatherer` (`services/agent-router/src/evidence-gatherer.ts`) pulls
  from both a Wiki provider and a Ledger provider. An agent proposing a payment
  draws on narrative memory and machine truth together.
- **The gate authorizes against Ledger only.** Balance, limits, policy,
  sanctions, evidence-semantic checks all read machine truth.

So: **Wiki informs the proposal; Ledger authorizes the execution.** This is not
a limit on autonomy. It is the property that lets autonomy ship, because the
answer to "what stops a hallucinated memory from moving money" is "the gate
cannot read it."

## 5. The confidence path to autonomy

Autonomous payment requires high-confidence Ledger truth. Document extraction is
capped at `<= 0.5`. The bridge from one to the other is raising confidence, and
human approval is only one of three routes:

1. **Deterministic parsing of structured exports.** A CSV / XLSX bank or GL
   export parsed by a deterministic parser yields higher confidence than an LLM
   reading a PDF, because the format is verifiable. Provenance `extracted`, not
   capped at 0.5.
2. **Cross-source reconciliation.** The same obligation seen in a contract and
   then matched to a bank debit corroborate each other. The seven existing
   reconciliation matchers can raise confidence with no human in the loop, once
   the write-back in 5.2 below exists.
3. **Human confirm as a bootstrap.** A one-time tenant confirmation promotes a
   row to provenance `human_confirmed`, lifting it above the agent-contributed
   ceiling. A bootstrap, not a permanent per-payment checkpoint.

### 5.1 Provenance follows extraction method (the governing rule)

The extractor sets provenance by how the data was read, which directly bounds
how autonomously Brain may act on it:

- **deterministic parse of a structured export** -> provenance `extracted`,
  uncapped confidence (the format is verifiable);
- **model / OCR extraction of a PDF or scan** -> provenance `agent_contributed`,
  confidence `<= 0.5`.

For OCR, the Python document extractor returns recovered text with a
`confidence_cap` of `0.5`; routes and future callers consume that cap rather
than re-declaring the quarantine rule locally.

This makes the trust model legible: the more structured the source, the closer to
autonomy its data starts. A scanned invoice never autonomously pays on its own
reading; a reconciled or confirmed obligation can.

### 5.2 What is NOT built yet (this is real work, not a threshold tweak)

A verification pass found that **confidence does not gate execution anywhere
today**, so the path above is aspirational until plumbed:

- the §6 gate reads no confidence (zero checks reference it);
- the policy VM has the primitive `agent.confidence.gte`
  (`services/policy/src/vm.ts:199`) but `evaluateForGate`
  (`services/policy/src/service.ts:163`) never populates `Action.confidence`, so
  any such rule fails closed;
- PaymentIntent rows are hardcoded to confidence `1.0`
  (`services/ledger/src/repository/payment_intents.ts:114`) regardless of source;
- reconciliation writes match records and `reconciliation_status='matched'` but
  never writes confidence back to the source rows
  (`services/ledger/src/reconciliation/persist.ts`);
- `human_confirmed` only lifts the write-time 0.5 ceiling; nothing downstream
  reads provenance.

The cleanest fix reuses the existing policy primitive rather than adding a gate
check. The Stage 2 "confidence plumbing" work is:

1. carry real confidence onto the PaymentIntent (stop hardcoding `1.0`);
2. thread it into `GatePaymentIntent`;
3. populate `Action.confidence` in `evaluateForGate` so `agent.confidence.gte`
   becomes a live, tenant-tunable autonomy threshold;
4. add an upward-only confidence write-back to reconciliation `persistMatch`.

With that plumbing, the same data becomes eligible to drive the autonomy modes
defined in `shared/src/agents/autonomy.ts` (`shadow` -> `recommend` -> `confirm`
-> `live`) through the unchanged gate. Brain reaches unattended `live` execution
when, and only when, its own corroborated truth clears the policy threshold. The
hardcoded `1.0` on PaymentIntent is a latent issue worth fixing on its own merits,
independent of this RFC.

## 6. Staging

### Stage 1. Pilot: ingest, organize, explain (no Plaid, advisory)

- Parser registry + document-extractor agent for statement, invoice-sheet, and
  contract document types.
- `doc_obligation_v1` deterministic Ledger extractor + `upsertObligationRow`.
- `target_entities` enum extension.
- Outcome: a prospect uploads the financials they already have, Brain organizes
  what they owe and own and when, and answers plain-language questions about it.
  Recommendations are advisory (summaries, due / overdue awareness, anomalies
  where transaction data exists). No funding rail is required, so no autonomous
  payment yet. This is the low-friction first-touch.

### Stage 2. Earned autonomy

- **Confidence plumbing (the prerequisite, per 5.2):** carry real confidence onto
  PaymentIntent, thread it into `GatePaymentIntent`, populate `Action.confidence`
  in `evaluateForGate`, and add the reconciliation write-back. Until this lands,
  confidence is informational and cannot gate anything.
- Cross-source reconciliation over ingested documents and a confirm flow to
  raise confidence above the tenant's `agent.confidence.gte` policy threshold.
- Bind an execution rail. On-chain rails need no bank; ACH needs a Plaid
  Transfer authorization or equivalent rail credential bound to the account.
- Outcome: autonomous payment through the unchanged §6 gate, gated on confidence
  rather than on Plaid.

## 7. Open questions (resolve before or during implementation; do not guess)

1. **How does `raw_parsed` get written today? RESOLVED.** Nothing writes it, for
   any source. The stage-3 parse layer was never built; the migration says so
   (`services/raw/migrations/0002_raw_parsed.sql`), Raw has no parsed-write route,
   and the golden-path demo bypasses the pipeline by seeding Ledger rows directly.
   Resolution folded into §1 and §3.6: this RFC delivers the first `raw_parsed`
   producer as a Raw-owned `POST /raw/{id}/parsed` route. No further investigation
   needed.
2. **Quarantine. RESOLVED.** A verification pass found the quarantine mechanism
   is a dormant skeleton: the code exists (`services/execution/src/agents/quarantine.ts`,
   `agents.quarantine_threshold` default 5) but `recordContributionAndDecide()` is
   never called outside tests, so no source type is gated between ingest and use
   today. There is nothing to bypass. Decision: do not wire enforcement on the
   upload path; `document_extractor` is a first-party agent and the `<= 0.5` cap
   plus advisory-only autonomy is the safety boundary. Caveat: the skeleton keys on
   `agent_id`, so if quarantine is ever enabled globally, `document_extractor` needs
   an explicit exemption.
3. **Per-type determinism. RESOLVED into a rule (see 5.1).** Provenance follows
   extraction method: deterministic structured-export parse -> `extracted`
   (uncapped); model / OCR -> `agent_contributed` (`<= 0.5`). Stage 1 ships a
   deterministic CSV / XLSX path and a model path for PDF. Infra to add: a
   parsing dependency (`pdfplumber` / `openpyxl`) in
   `services/agents/pyproject.toml`, plus a `post_parsed` method on the Python
   `BrainApiClient` (does not exist today). Remaining decision below.
4. **Confidence is not a lever today; the path must be built (see 5.2).** This was
   the verification pass's main finding, now reflected in §5 and Stage 2. Not an
   open investigation; it is scoped work.

### 7.1 Decisions still genuinely owed (product / policy, not code unknowns)

- **LLM provider for the extractor. DECIDED: OpenAI**, to match the existing
  Python agents (`gpt-4o-mini`, vision via `gpt-4o`). The new agent reuses the
  wired `AsyncOpenAI` client with no new dependency. Revisit only if extraction
  quality on real documents proves insufficient.
- **Threshold values. PARTIALLY DECIDED (Stage 2).** The per-tenant
  `agent.confidence.gte` value for `confirm` vs `live` stays a tenant policy
  knob (not hard-coded). For corroboration lift, the chosen default is: a single
  reconciliation match raises the obligation's confidence upward-only toward the
  match score, capped at **0.9** (corroboration never asserts human-confirmed
  certainty); see `CORROBORATION_CONFIDENCE_CEILING` in
  `services/ledger/src/reconciliation/persist.ts`. The 0.9 ceiling and
  single-match step are open to calibration.
- **Reconciliation write-back scope. DECIDED + DONE (Stage 2).** The upward-only
  write-back landed in `persistMatch`: a match against an obligation raises its
  confidence and promotes `agent_contributed -> extracted` (the sanctioned
  promotion path, since the row is now backed by independent Ledger evidence),
  emitting a `ledger.obligation.corroborated` audit event.

## 8. Layer-boundary compliance checklist

- [x] Extractor writes into Raw, never into Ledger (exception (a)).
- [x] Ledger rows created only via the owning service's normalize path.
- [x] Agent-contributed rows capped at `confidence <= 0.5`.
- [x] Every derived row carries provenance, confidence, source_ids, evidence_ids.
- [x] Policy and Execution read Ledger, never Wiki.
- [x] §6 gate unchanged; no LLM judgment in the gate.
- [x] Uploaded artifacts immutable; extraction re-derives, never edits.
