# Partner-connector isolation

Brain's connector catalog distinguishes two trust tiers (`ConnectorDescriptor.trustTier`):

- **`first_party`**, connector code Brain authored and audited (Plaid, Stripe, Merge,
  Finch, the document-upload connectors, ...). It may run **in-process**: registered as a
  `SourceAdapter`, holding provider credentials, running on the sync/interpret workers, and
  registering a Ledger parser that mints high-trust `extracted` evidence.
- **`partner`**, connector code authored **outside Brain's trust boundary**. It must never
  run inside the trusted ingestion pipeline.

This is distinct from `ConnectorDescriptor.origin` (`provider | aggregator | customer | agent
| public`), which describes the nature of the _data source_, not who wrote the _connector
code_. A partner could integrate any kind of source; what makes it a partner connector is that
Brain did not author/audit the code.

## What "isolation" means, and what ships today

Full isolation has two halves:

1. **In-process exclusion** (substrate-independent, **enforced now**). A `partner`-tier
   connector:
   - has **no registered `SourceAdapter`**, partner code never links into the in-process
     adapter registry, holds credentials, or runs on the workers;
   - declares **no `parserVersions`**, it cannot register a Ledger parser, which would mint
     high-trust `extracted` evidence;
   - declares **no webhook delivery**, an in-process, HMAC-verified provider webhook mints
     authenticated provenance; a partner instead reaches Raw only through the authenticated
     generic-ingest boundary.

   A partner connector therefore reaches Raw exactly like any external caller: `POST
/raw/ingest` as an `api_partner` principal. `adapterForGenericIngest` already refuses a
   caller-asserted `source_type` that is `providerAuthenticatedOnly` (e.g. `plaid`/`stripe`),
   so a partner cannot mint high-trust evidence by mislabeling its upload. Its artifacts
   resolve as **low evidence trust** (`customer_asserted`), and the §6 gate (check 9.5)
   refuses to settle on all-low-trust evidence unless the linked obligation was corroborated.

2. **Runtime hosting in an isolated operated runtime** (**deferred to R-03**). Hosting partner
   connector code in a separate process/container that Brain operates needs the Azure deploy
   substrate that R-03 tracks (not yet exercised). Until then, no partner code is hosted at
   all, partners integrate by pushing into Raw over the authenticated boundary above, which
   needs no new substrate.

## Enforcement

The in-process exclusion is enforced at three layers (all fail closed):

| Layer             | Where                                                                        | Trigger                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Boot fence**    | `assertRegistryPartnerIsolation()` in `services/api/src/main.ts`             | api refuses to start (CrashLoopBackoff) if a partner-tier connector is misdeclared. Structural, not env-gated. |
| **Certification** | `services/raw/src/conformance/conformance.test.ts`                           | the conformance suite asserts the invariant over the live registry.                                            |
| **CI guard**      | `scripts/check-partner-connector-isolation.mjs` (wired into `pnpm run lint`) | static lint-time backstop; also flags a descriptor missing `trustTier`.                                        |

The pure assertion lives in `services/raw/src/adapters/isolation.ts`
(`assertPartnerConnectorIsolation`) and is exported from `@brain/raw` as connector-SDK surface.

## Status

Every shipped connector is `first_party`; there are no partner-tier connectors yet, so the
boot fence and guard are no-ops on a healthy tree (exactly like the live-rail fence when a rail
is configured). The contract and its enforcement are in place so the first partner connector
declares `trustTier: "partner"` and is structurally prevented from running in-process. The
runtime-hosting half remains blocked on the R-03 deploy substrate.
