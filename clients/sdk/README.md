# @brain/sdk

The typed HTTP client for the Brain API.

This package is the source-of-truth client that backs every code example on
[docs.brain.fi](https://docs.brain.fi). It exposes:

- A high-level `Brain` class with namespaced helpers (`brain.accounts.list`,
  `brain.transactions.get`, `brain.obligations.list`, …) as documented on
  the homepage. The surface lands in slices — see Status below.
- A low-level typed client (`createBrainHttpClient`) generated from
  [`Brain_API_Specification.yaml`](../../Brain_API_Specification.yaml) for
  power users who want raw HTTP access.

## Status

| Slice | Surface                                                                                                                             | Status                  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1A    | `createBrainHttpClient` over the full OpenAPI surface                                                                               | **shipped**             |
| 1B.1  | `Brain` class + ledger reads (accounts, transactions, counterparties, obligations, invoices, balances)                              | shipped                 |
| 1B.2  | Audit surface: `brain.audit.list/get/history/export/verify`, `brain.audit.anchor.latest`, `brain.proof`                             | shipped                 |
| 1B.3  | Payment intents + actions: `brain.payments.*`, `brain.actions.*`, `brain.pay` / `brain.approve` / `brain.reject` (with idempotency) | shipped                 |
| 1B.4  | Agents (`brain.agents.list/get/register/listActions/propose`) + raw ingestion (`brain.raw.ingest/get/getParsed`)                    | **shipping in this PR** |
| 1B.5  | Wiki: `brain.ask` (compound over `/wiki/question`), `brain.wiki.*`                                                                  | not yet implemented     |
| 1B.6  | Policy: `brain.policy.*`                                                                                                            | not yet implemented     |
| 1B.7  | Compounds without REST endpoints today: `brain.snapshot`, `brain.trace`, `brain.cashFlow.summarize`                                 | deferred (need product) |
| 1C    | Doc-example smoke test (CI extracts every TypeScript block from `*.md` and type-checks against this package)                        | not yet implemented     |

## Usage

### High-level (`Brain` class)

```typescript
import { Brain } from "@brain/sdk";

const brain = new Brain({ apiKey: process.env.BRAIN_API_KEY! });

// Ledger reads
const { accounts, nextCursor } = await brain.accounts.list({ status: "active" });
const { account, latestBalance } = await brain.accounts.get("acct_8231");
const { transactions } = await brain.transactions.list({ direction: "inflow", limit: 50 });
const counterparties = await brain.counterparties.list({ q: "stripe" });
const obligations = await brain.obligations.list({ status: "due" });
const invoices = await brain.invoices.list();
const balances = await brain.balances.list();

// Audit and proof
const { events } = await brain.audit.list({ layer: "execution" });
const { event, inclusionProof } = await brain.audit.get("evt_8231");
const history = await brain.audit.history("payment_intent", "pi_8231");
const anchor = await brain.audit.anchor.latest();
const verification = await brain.audit.verify({
  eventHash: "0x...",
  merkleProof: ["0x...", "0x..."],
  merkleRoot: "0x...",
});
const proof = await brain.proof("evt_8231"); // shorthand for audit.get(id).inclusionProof

// Payments — propose + execute compound
const result = await brain.pay("acme", {
  action_type: "ach_outbound",
  source_account_id: "acct_8231",
  destination_counterparty_id: "cp_555",
  amount: "1234.00",
  currency: "USD",
  invoice_id: "inv_8231",
  idempotencyKey: crypto.randomUUID(),
});
// result.intent (always), result.execution (only if policy auto-approved)
// Throws PolicyApprovalRequiredError if pending_approval; PolicyRejectedError if rejected.

// Approve / reject flow when policy required confirmation
await brain.approve("pi_8231");
await brain.payments.execute("pi_8231");

// Or non-financial agent actions
const proposal = await brain.actions.propose({
  agentId: "agent_1",
  action: { type: "reconciliation_match" /* ... */ },
  idempotencyKey: crypto.randomUUID(),
});
```

On a non-2xx response, methods throw `BrainAPIError` carrying `status`,
`code`, `traceId`, and structured `details` from the standard Brain error
envelope.

### Low-level (`createBrainHttpClient`)

For endpoints not yet wrapped by the `Brain` class, or for callers who
want direct typed-fetch access:

```typescript
import { createBrainHttpClient } from "@brain/sdk";

const http = createBrainHttpClient({
  apiKey: process.env.BRAIN_API_KEY!,
});

const { data, error } = await http.GET("/audit/anchor/latest");
```

The client is fully typed against the OpenAPI spec. Path, query, body, and
response shapes are inferred — there is no hand-written type surface to drift.

## Codegen

```bash
pnpm --filter @brain/sdk run codegen
```

Regenerates `src/generated/openapi.d.ts` from
[`Brain_API_Specification.yaml`](../../Brain_API_Specification.yaml). The
generated file is committed so downstream consumers don't need to run codegen
on `pnpm install`. CI runs `codegen:check` to catch drift.

## Publish target

`private: true` for now. Future intent: publish to GitHub Packages with
private access (organisation members and authorised consumers only). The
docs commit to `npm install @brain/sdk`; until a publish workflow lands, that
command does not yet resolve — see Step 1A in the SDK plan thread for
sequencing.

## Conventions

Follows the standard Brain TypeScript package layout: strict mode, ESM,
`tsc -b` build, `dist/` output, Vitest with 80% line / 75% branch coverage.
