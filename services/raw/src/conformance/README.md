# Connector conformance / certification

The internal connector SDK (Phase 6) lets a new source connector be **certified**
against the source-agnostic contract the platform relies on, instead of each
connector re-deriving the invariants in ad-hoc tests.

A connector is **certified** when it passes:

1. **The static contract** (`assertStaticConformance(adapter, descriptor)`):
   - descriptor `connectorType` matches `adapter.sourceType`; `version` is semver;
   - capability ⇄ implementation parity: `incremental`/`backfill` ⇒ the adapter
     has `fetchIncremental` + `syncObjectTypes`, and an implemented
     `fetchIncremental` ⇒ `incremental` is claimed; `webhooks` ⇒ `handleWebhook`;
   - every synced `objectType` is listed in the descriptor with a valid
     checkpoint type (`cursor` | `page_token` | `watermark` | `snapshot`);
   - an active connector declares at least one `parserVersion`.

   `conformance.test.ts` runs this over **every** registered adapter, so a
   freshly-scaffolded connector is auto-certified (or fails loudly) with no
   per-adapter boilerplate.

2. **The behavioral contract** (`assertFetchConformance(adapter, descriptor, input)`),
   with the provider stubbed deterministically by the caller:
   - the result is a valid §10 shape (`artifacts[]`, `nextCheckpoint` present,
     `hasMore` boolean);
   - every artifact carries a §9 envelope with a non-empty `sourceSchema` and a
     non-empty `idempotencyKey`;
   - **idempotency keys are retry-stable**: re-running the same uncommitted
     partition yields identical keys, so a crash between artifact-ingest and
     checkpoint-commit re-pulls without creating duplicates (§10's
     commit-artifacts-before-advancing-checkpoint invariant depends on this).

## Adding a connector

`pnpm run scaffold-connector <name>` generates the adapter, descriptor entry,
parser, and a test skeleton. In that adapter's `*.test.ts`, after stubbing the
provider, call the harness:

```ts
import { assertStaticConformance, assertFetchConformance } from "@brain/raw";
import { descriptorForSourceType } from "../adapters/registry.js";

const descriptor = descriptorForSourceType("<name>");
assertStaticConformance(MyAdapter, descriptor); // throws on any violation

await assertFetchConformance(MyAdapter, descriptor, {
  tenantId,
  credentials,
  partition, // a backfill partition (committedCheckpoint: null)
});
```

The static check also runs automatically in `conformance.test.ts` once the
adapter is registered. The descriptor CI guard
(`scripts/check-connector-descriptors.mjs`) remains the registration-level
backstop (every adapter described, parsers registered, concrete connectors
tested); the conformance harness adds the behavioral contract on top.
