# Brain Investor Demo Script

**Duration:** 12–15 min  
**Audience:** Investors and technical evaluators  
**Prerequisite:** Pre-flight checklist complete (see bottom of this doc)

---

## Beat 1. What Brain is (2 min)

Brain is a financial intelligence protocol that sits between a company's raw data (bank feeds, invoices, contracts) and the decisions that move money. It answers questions like "can we pay this vendor?" with cryptographic certainty, not human judgment. And leaves an immutable, on-chain audit trail for every decision.

Show the architecture diagram or just say:

> "Six layers: ingest raw evidence, structure it into a ledger, build a narrative memory, run a deterministic policy gate, orchestrate agent actions, and anchor every decision root to Base. Tonight's demo touches every layer."

---

## Beat 2. SDK ledger read (2 min)

Open a terminal. The SDK is five lines:

```typescript
import { Brain } from "@brain/sdk";

const brain = new Brain({ token: process.env.BRAIN_TOKEN });
const accounts = await brain.accounts.list();
console.log(accounts);
```

Run the quickstart:

```bash
BRAIN_TOKEN=$(pnpm -C tools/dev-token exec tsx src/index.ts --tenant tnt_01GOLDEN00000000000000000) \
  pnpm -C clients/sdk exec tsx examples/quickstart.ts
```

**Expected output:** Two bank accounts (First National, Silicon Valley Bank), one card (Brex), one counterparty (Stripe). Tenant is "Brain Inc." The data is live from Postgres. Not mocked.

**Talking point:** This is the SDK investors use. When we ship `@brain/sdk` to npm, this code works without changing a line.

---

## Beat 3. Wiki Q&A (2 min)

```typescript
const answer = await brain.ask("What is our largest unpaid invoice?");
console.log(answer.text);
```

Expected: A natural-language answer citing the $15,000 invoice from AWS (evidence-backed, `source_ids` attached). The Wiki layer ingests narrative context from raw payloads and answers questions. But it never drives decisions. That's what Beat 4 is for.

---

## Beat 4. MCP agent proposes a payment (2 min)

The MCP server exposes Brain to external AI agents over JSON-RPC. Show a raw `curl` or the MCP client:

```bash
curl -s -X POST http://localhost:3000/v1/agents/mcp \
  -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "payment.propose",
      "arguments": {
        "amount": 50000,
        "currency": "USD",
        "counterparty_id": "<stripe-id>",
        "description": "Platform fee. May 2026"
      }
    },
    "id": 1
  }'
```

Response carries a `payment_intent_id`. Note: agents can only _propose_. They can never execute.

---

## Beat 5. §6 gate rejects, then approves (3 min)

This is the core of the protocol.

**Step 5a. Trigger a rejection.**  
Use the `payment_intent_id` from Beat 4. The seeded data includes an active policy with a $25,000 single-payment limit. A $50,000 attempt will be blocked:

```bash
curl -s -X POST http://localhost:3000/v1/payment-intents/$PI_ID/execute \
  -H "Authorization: Bearer $BRAIN_TOKEN"
```

Response:

```json
{
  "error": {
    "code": "policy_amount_exceeded",
    "message": "Payment exceeds the $25,000 per-transaction limit set by policy rule R-003.",
    "details": { "policy_decision_id": "pdec_01…" }
  }
}
```

**Talking point:** The `policy_decision_id` is in the error envelope. Every rejection is recorded in the audit log. The decision is deterministic. No LLM involved.

**Step 5b. Approve with a lower amount.**  
Create a new intent for $5,000 against Stripe and execute. This one passes all 13 checks and returns `status: "executed"` with a `policy_decision_id`.

---

## Beat 6. Live audit anchor on Base Sepolia (2 min)

Trigger an on-chain anchor via the admin endpoint:

```bash
curl -s -X POST http://localhost:3000/v1/audit/anchor/publish \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Response:

```json
{
  "id": "anch_01…",
  "merkle_root": "0x…",
  "event_count": 47,
  "tx_hash": "0x…",
  "basescan_url": "https://sepolia.basescan.org/tx/0x…"
}
```

Open the `basescan_url` in a browser. The transaction confirms within ~5 seconds. The Merkle root covering every audit event from this session. Ledger reads, policy decisions, payment execution. Is now permanently on-chain.

**Talking point:** This is not a simulation. The contract at `0xb900add824064098342c869ff83efdeb05eb95ce` on Base Sepolia just anchored cryptographic proof of everything that happened in this demo. Any event can be independently verified against that root.

---

## Pre-flight checklist

Run these before each investor session:

- [ ] **Seed fresh:** `DATABASE_URL=… BRAIN_TENANT_ID=tnt_01GOLDEN00000000000000000 BRAIN_ACTOR=usr_01GOLDEN00000000000000000 pnpm run demo:reset`. Completes in <30s
- [ ] **Services up:** `pnpm run dev:up && BRAIN_DEMO_MODE=true pnpm -C services/api dev`. Wait for "listening on 3000"
- [ ] **Dev token works:** `pnpm -C tools/dev-token exec tsx src/index.ts --tenant tnt_01GOLDEN00000000000000000` returns a JWT
- [ ] **Anchor publisher healthy:** env `ANCHOR_PUBLISHER_PRIVATE_KEY` and `BASE_SEPOLIA_RPC_URL` set; `ENABLE_ANCHOR_PUBLISHER=true`
- [ ] **BaseScan reachable:** `curl -s https://sepolia.basescan.org` returns 200
- [ ] **SDK quickstart green:** Beat 2 command returns 3+ accounts

If anchor publisher key or RPC is missing, the `POST /v1/audit/anchor/publish` endpoint returns 404. Skip Beat 6 or use the pre-recorded tx hash.

---

## Reset between sessions

```bash
pnpm run demo:reset
```

This truncates all demo tenant data and re-seeds the golden-path dataset (Brain Inc. accounts, Stripe counterparty, invoices, obligations). Takes under 30 seconds.
