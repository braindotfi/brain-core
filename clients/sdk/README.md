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
| 1B.4  | Agents (`brain.agents.list/get/register/listActions/propose`) + raw ingestion (`brain.raw.ingest/get/getParsed`)                    | shipped                 |
| 1B.5  | Wiki: `brain.wiki.question/search/getEntity/getEvidence/getHistory/annotate/schema`, `brain.ask` compound                           | shipped                 |
| 1B.6  | Policy: `brain.policy.get/listVersions/compose/sign/activate/evaluate/simulate`                                                     | shipped                 |
| 1B.7  | Client-side compounds: `brain.snapshot`, `brain.trace`, `brain.cashFlow.summarize`                                                  | **shipping in this PR** |
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

// Wiki — natural language Q&A grounded in the tenant ledger
const answer = await brain.ask("acme", "did cloud spend grow faster than revenue this quarter?");
const search = await brain.wiki.search({ q: "stripe", limit: 10 });
const entity = await brain.wiki.getEntity("ent_8231", { includeNeighbors: true });

// Policy — compose, sign, activate (EIP-712), evaluate, simulate
const signingPayload = await brain.policy.compose("acme", dslDocument);
// (sign signingPayload.typedData with authorised keys, then submit)
await brain.policy.sign("acme", { contentHash: signingPayload.contentHash!, signatures });
const decision = await brain.policy.evaluate("acme", action);

// Agents — register, list, propose
const agents = await brain.agents.list();
await brain.agents.register({
  agent_id: "ext_1",
  role: "reconciliation",
  display_name: "Recon Bot",
});

// Raw ingestion — pull from a URL
await brain.raw.ingest({
  sourceType: "document",
  url: "https://example.com/invoice.pdf",
});

// Client-side compounds — multiple calls under the hood, no server endpoint
const snapshot = await brain.snapshot("acme"); // balances + tx + obligations
const trace = await brain.trace("pi_8231"); // full audit chain for an action
const summary = await brain.cashFlow.summarize({
  tenantId: "acme",
  since: "2026-04-01",
  until: "2026-04-30",
  currency: "USD",
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

## Architecture notes

- **Resource-per-namespace**: each `brain.<namespace>` is an instance of a
  `*Resource` class that wraps the typed HTTP client. Resources are
  exported individually for tree-shaking and stand-alone use.
- **camelCase at the SDK boundary**: arguments and return types are
  camelCase. Snake_case lives on the wire only; the SDK translates in
  both directions.
- **Errors are typed**: `BrainAPIError` carries `status`, `code`,
  `traceId`, `details` from the standard error envelope. Compound
  helpers may additionally throw `PolicyApprovalRequiredError` or
  `PolicyRejectedError` carrying the proposed intent.
- **Idempotency keys**: every mutating method on `payments` and
  `actions` accepts `idempotencyKey` and sends it as the
  `Idempotency-Key` HTTP header. Critical infrastructure for financial
  APIs — set this on every retry-safe write from production callers.
- **Compounds are client-side**: `brain.snapshot`, `brain.trace`, and
  `brain.cashFlow.summarize` issue multiple HTTP calls under the hood,
  no server endpoint backs them directly. If a server-side equivalent
  lands later, these can be retargeted without changing the public
  method signature.
- **Tenant scoping**: most endpoints derive the tenant from the
  authenticated principal. The `policy.*` methods are an exception —
  they take `tenant_id` explicitly. Compound helpers that accept a
  `tenantId` argument (`pay`, `ask`, `snapshot`) match the documented
  signature but currently don't forward the value on the wire. Reserved
  for future cross-tenant API key support.
