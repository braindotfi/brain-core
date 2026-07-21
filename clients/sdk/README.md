# @brainfinance/sdk

The typed HTTP client for the Brain API.

## Install

```bash
npm install @brainfinance/sdk@rc
```

### Release-candidate compatibility

`0.1.0-rc.0` is generated against, and tested against, the **v0.0.4
deployment** of the Brain API (`https://api.brain.fi`). The SDK version line
is independent of the service version; this note is the compatibility
statement.

**Known issues (RC):**

- The committed generated types lag the OpenAPI spec on two points: the
  deprecated `proposeAgentAction`/`registerAgent` endpoints now return 404 on
  the server but the types still describe their old response shapes, and the
  `listAgents` response type includes an `agents` array field the current
  spec no longer declares. Both will be resolved by a full codegen refresh
  before GA.

This package is the source-of-truth client that backs every code example on
[docs.brain.fi](https://docs.brain.fi). It exposes:

- A high-level `Brain` class with namespaced helpers (`brain.accounts.list`,
  `brain.transactions.get`, `brain.obligations.list`, …) as documented on
  the homepage. The surface lands in slices, see Status below.
- A low-level typed client (`createBrainHttpClient`) generated from
  [`Brain_API_Specification.yaml`](../../Brain_API_Specification.yaml) for
  power users who want raw HTTP access.

## Status

| Slice | Surface                                                                                                                               | Status                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1A    | `createBrainHttpClient` over the full OpenAPI surface                                                                                 | **shipped**             |
| 1B.1  | `Brain` class + ledger reads (accounts, transactions, counterparties, obligations, invoices, balances)                                | shipped                 |
| 1B.2  | Audit surface: `brain.audit.list/get/history/export/verify`, `brain.audit.anchor.latest`, `brain.proof`                               | shipped                 |
| 1B.3  | Payment intents + actions: `brain.payments.*`, `brain.actions.*`, `brain.pay` / `brain.approve` / `brain.reject` (with idempotency)   | shipped                 |
| 1B.4  | Agents (`brain.agents.list/get/register/listActions/propose`) + raw ingestion (`brain.raw.ingest/get/getParsed`)                      | shipped                 |
| 1B.5  | Wiki: `brain.wiki.question/search/getEntity/getEvidence/getHistory/annotate/schema`, `brain.ask` compound                             | shipped                 |
| 1B.6  | Policy: `brain.policy.get/listVersions/compose/sign/activate/evaluate/simulate`                                                       | shipped                 |
| 1B.7  | Client-side compounds: `brain.snapshot`, `brain.trace`, `brain.cashFlow.summarize`                                                    | **shipping in this PR** |
| 1B.8  | Trust surfaces (v0.4): `brain.proof(actionId)` (full Proof artifact, H-07), `brain.agentRuns.get/why/evidence/gateTrace/proof` (H-25) | shipped                 |
| 1C    | Doc-example smoke test (CI extracts every TypeScript block from `*.md` and type-checks against this package)                          | not yet implemented     |

## Quickstart against the hosted sandbox

There is no separate sandbox host: the sandbox/testnet environment IS
**staging** (`https://staging-api.brain.fi`, also reachable via
`environment: "sandbox"` below. Both names resolve to the same host). It
runs in demo mode with a pre-seeded golden-path dataset (Brain Inc.
accounts, Stripe counterparty, invoices).

**Step 1. Get a demo token:**

```bash
export BRAIN_TOKEN=$(curl -s https://staging-api.brain.fi/v1/demo/token | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token))")
```

**Step 2. Run the quickstart:**

```bash
BRAIN_BASE_URL=https://staging-api.brain.fi/v1 \
  npx tsx clients/sdk/examples/quickstart.ts
```

Or from within the workspace after `pnpm install`:

```bash
BRAIN_TOKEN=$(curl -s https://staging-api.brain.fi/v1/demo/token | jq -r .token) \
BRAIN_BASE_URL=https://staging-api.brain.fi/v1 \
  pnpm -C clients/sdk exec tsx examples/quickstart.ts
```

The token is valid for 24 hours. To reset the dataset between demo sessions:

```bash
# (on the server, or via API. See docs/demo-script.md for the pre-flight checklist)
pnpm run demo:reset
```

## Usage

### Authentication

Pass exactly one of `apiKey` or `token`. Passing both, or neither, throws.

**`apiKey` (recommended)**. A long-lived Brain API key (`brain_sk_...`),
issued for a tenant. The SDK sends it directly as
`Authorization: Bearer brain_sk_...`:

```typescript
import { Brain } from "@brainfinance/sdk";

const brain = new Brain({ apiKey: process.env.BRAIN_API_KEY! });
```

**`token`**. A static JWT (e.g. from `brain.dev/demo/token` or your own
auth flow). Sent as-is on every request:

```typescript
const brain = new Brain({ token: process.env.BRAIN_TOKEN! });
```

**`environment`** selects a named base URL (`production` | `sandbox` |
`staging` | `local`); `baseUrl` overrides it explicitly. `sandbox` and
`staging` are the same live shared testnet host
(`https://staging-api.brain.fi/v1`). Two names, one environment.

### High-Level (`Brain` Class)

```typescript
import { Brain } from "@brainfinance/sdk";

const brain = new Brain({ token: process.env.BRAIN_TOKEN! });

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
// H-07 Proof API: one canonical, verifiable proof for an action (PaymentIntent
// or agent-action id). Gate trace, evidence, policy decision, audit Merkle
// proof + anchor, rail receipt, and a human_explanation.
const proof = await brain.proof("pi_8231");
// (For the low-level Merkle inclusion proof of a single audit event, use
//  brain.audit.get(eventId).inclusionProof.)

// H-25 Agent Run History. The reasoning behind an action, step by step.
const run = await brain.agentRuns.get("agnr_8231");
const why = await brain.agentRuns.why("agnr_8231"); // candidates + behavior hash
await brain.agentRuns.evidence("agnr_8231");
await brain.agentRuns.gateTrace("agnr_8231");
await brain.agentRuns.proof("agnr_8231"); // proxies the Proof API

// Payments, propose + execute compound
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

// Wiki, natural language Q&A grounded in the tenant ledger
const answer = await brain.ask("acme", "did cloud spend grow faster than revenue this quarter?");
const search = await brain.wiki.search({ q: "stripe", limit: 10 });
const entity = await brain.wiki.getEntity("ent_8231", { includeNeighbors: true });

// Policy, compose, sign, activate (EIP-712), evaluate, simulate
const signingPayload = await brain.policy.compose("acme", dslDocument);
// (sign signingPayload.typedData with authorised keys, then submit)
await brain.policy.sign("acme", { contentHash: signingPayload.contentHash!, signatures });
const decision = await brain.policy.evaluate("acme", action);

// Agents, register, list, propose
const agents = await brain.agents.list();
await brain.agents.register({
  agent_id: "ext_1",
  role: "reconciliation",
  display_name: "Recon Bot",
});

// Raw ingestion, pull from a URL
await brain.raw.ingest({
  sourceType: "pdf_upload",
  url: "https://example.com/invoice.pdf",
});

// Client-side compounds, multiple calls under the hood, no server endpoint
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

### Low-Level (`createBrainHttpClient`)

For endpoints not yet wrapped by the `Brain` class, or for callers who
want direct typed-fetch access:

```typescript
import { createBrainHttpClient } from "@brainfinance/sdk";

const http = createBrainHttpClient({
  token: process.env.BRAIN_TOKEN!,
});

const { data, error } = await http.GET("/audit/anchor/latest");
```

`createBrainHttpClient` accepts `apiKey` in place of `token` too, with the
same lazy-exchange behavior described above.

The client is fully typed against the OpenAPI spec. Path, query, body, and
response shapes are inferred, there is no hand-written type surface to drift.

## Codegen

```bash
pnpm --filter @brainfinance/sdk run codegen
```

Regenerates `src/generated/openapi.d.ts` from
[`Brain_API_Specification.yaml`](../../Brain_API_Specification.yaml). The
generated file is committed so downstream consumers don't need to run codegen
on `pnpm install`. `codegen:check` detects drift locally; it is not yet wired
into CI.

## Publish Target

Published to the public npm registry as
[`@brainfinance/sdk`](https://www.npmjs.com/package/@brainfinance/sdk) under
the `rc` dist-tag. The package ships `dist/` (ESM + type declarations),
this README, and the Apache-2.0 LICENSE only.

## Conventions

Follows the standard Brain TypeScript package layout: strict mode, ESM,
`tsc -b` build, `dist/` output, Vitest with 80% line / 75% branch coverage.

## Architecture Notes

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
  APIs, set this on every retry-safe write from production callers.
- **Compounds are client-side**: `brain.snapshot`, `brain.trace`, and
  `brain.cashFlow.summarize` issue multiple HTTP calls under the hood,
  no server endpoint backs them directly. If a server-side equivalent
  lands later, these can be retargeted without changing the public
  method signature.
- **Tenant scoping**: most endpoints derive the tenant from the
  authenticated principal. The `policy.*` methods are an exception ,
  they take `tenant_id` explicitly. Compound helpers that accept a
  `tenantId` argument (`pay`, `ask`, `snapshot`) match the documented
  signature but currently don't forward the value on the wire. Reserved
  for future cross-tenant API key support.
