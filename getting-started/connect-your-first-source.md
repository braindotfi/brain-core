# Connect Your First Source

Plug in a Plaid sandbox bank account and watch the Ledger populate.

{% hint style="info" %}
Plaid sandbox returns realistic test data: 90 days of transactions across checking, savings, and credit accounts. No real bank credentials needed.
{% endhint %}

### Why Plaid for the First Source

Plaid is the fastest way to see Brain's full ingestion pipeline running end-to-end. In ten lines of code, you'll have a connected source, hundreds of Ledger records, and a Wiki you can query in natural language.

### Connect via the Console

The Console flow is the easiest path on first try.

<table><thead><tr><th width="100">Step</th><th>Action</th></tr></thead><tbody><tr><td>1</td><td>Open <strong>Sources → Add Source</strong></td></tr><tr><td>2</td><td>Choose <strong>Plaid</strong> from the catalog</td></tr><tr><td>3</td><td>Click <strong>Launch Plaid Link</strong></td></tr><tr><td>4</td><td>Pick any sandbox institution (e.g., "First Platypus Bank")</td></tr><tr><td>5</td><td>Use the test credentials: username <code>user_good</code>, password <code>pass_good</code></td></tr><tr><td>6</td><td>Pick the accounts to connect</td></tr><tr><td>7</td><td>Click <strong>Continue</strong>; Brain receives the access token and starts ingesting</td></tr></tbody></table>

Watch **Sources** in the Console. The status moves from `connecting` to `active` within seconds.

### Connect Programmatically

For the SDK path, generate a Plaid link token, complete the link flow, then exchange the public token for a Brain source.

```typescript
import { brain } from "./brain";

// Step 1: Generate a Plaid link token
const linkToken = await brain.sources.createLinkToken({
  tenantId: "acme",
  type:     "plaid",
});

console.log(linkToken.link_token);
// Open Plaid Link in your frontend with this token.
// On success, Plaid returns a public_token.
```

```typescript
// Step 2: Exchange the public token for a Brain source
const source = await brain.sources.connect({
  tenantId: "acme",
  type:     "plaid",
  credentials: {
    public_token: "public-sandbox-...",
  },
  metadata: { label: "Operating Account" },
});

console.log(source.id);     // "src_8231"
console.log(source.status); // "active"
```

### Watch Ingestion Happen

Brain pulls historical transactions immediately after connection, then keeps them current via webhooks.

```typescript
// Subscribe to ingestion events
const unsubscribe = brain.sources.subscribe({
  tenantId: "acme",
  onArtifactIngested: (e) => console.log("raw:", e.artifactId),
  onLedgerRecord:     (e) => console.log("ledger:", e.recordId, e.amount),
});

// Or poll
const status = await brain.sources.get({ id: source.id });
console.log(status.last_sync_at, status.records_ingested);
```

In the Console, the **Source Detail** view shows real-time progress: artifacts received, Ledger records produced, and average confidence.

### Inspect the Ledger

Once ingestion completes (under a minute for Plaid sandbox), query the Ledger.

```typescript
const txns = await brain.ledger.transactions.list({
  tenantId: "acme",
  from:     "2025-01-01",
  to:       "2025-12-31",
  limit:    20,
});

txns.data.forEach((t) => {
  console.log(t.date, t.amount, t.currency, t.counterparty_id);
});
```

Each record carries provenance back to the raw Plaid payload:

```typescript
const txn = txns.data[0];

console.log(txn.raw_refs);          // ["sha256:abc..."]
console.log(txn.extractor_version); // "v3.1"
console.log(txn.confidence);        // 0.98
```

### Ask the Wiki

The Wiki indexes new Ledger records continuously. Within seconds of ingestion, you can ask natural-language questions.

```typescript
const answer = await brain.wiki.question({
  tenantId: "acme",
  question: "What were our top three expense categories last month?",
});

console.log(answer.text);
console.log(answer.citations); // points back to Ledger and Raw
```

Expected output (will vary based on the sandbox data):

```
Last month's top three expense categories were:
1. Food and Drink: $1,234.56 across 23 transactions
2. Travel: $892.30 across 8 transactions
3. Shops: $678.45 across 31 transactions

Citations: tx_001, tx_002, ... (15 records)
```

### Other Source Types You Can Try

Plaid is one of many supported source types. Each follows the same connect-and-ingest pattern.

| Category       | Sandbox Source          | Real-World Source                  |
| -------------- | ----------------------- | ---------------------------------- |
| **Banking**    | Plaid sandbox           | Plaid production, direct bank APIs |
| **On-chain**   | Sepolia testnet wallets | Mainnet wallets via Alchemy        |
| **Accounting** | QuickBooks sandbox      | QuickBooks Online, Xero            |
| **ERP**        | NetSuite sandbox        | NetSuite, SAP, Dynamics 365        |
| **Processors** | Stripe test mode        | Stripe, Adyen production           |
| **Payroll**    | Gusto demo              | Gusto, Rippling, ADP               |
| **Documents**  | Email upload            | Email inbound, CSV/PDF upload      |

**→ Full Sources reference**

### Disconnect a Source

When you're done experimenting:

```typescript
await brain.sources.disconnect({
  tenantId: "acme",
  id:       source.id,
});
```

Disconnecting stops ingestion immediately. Historical Ledger records remain (they're immutable). Raw artifacts enter the configured retention window.
