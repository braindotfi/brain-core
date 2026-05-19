# Sandbox Mode (`BRAIN_DEMO_MODE`)

Run the full PaymentIntent PoC flow — Raw ingest → Ledger derive → §6 gate → Audit — using Plaid Sandbox and OpenAI, with no live chain calls, no Wirex/Crossmint, and no Policy service.

## What BRAIN_DEMO_MODE changes

| Area                      | Production                                            | `BRAIN_DEMO_MODE=true`                               |
| ------------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| LLM adapter               | `OpenAICompletionAdapter` (requires `OPENAI_API_KEY`) | `RecordedLlmAdapter` (fixture responses, no network) |
| Embed adapter             | `OpenAIEmbeddingAdapter`                              | `DeterministicEmbeddingAdapter`                      |
| `evaluatePaymentIntent`   | Calls Policy service (not yet wired)                  | Returns `{outcome: "allow"}` for any intent          |
| `evaluatePolicy` (legacy) | Calls Policy service (not yet wired)                  | Returns `{outcome: "allow"}`                         |
| `resolvePrincipal`        | Maps JWT claims → `GatePrincipal`                     | Returns synthetic agent principal                    |
| `resolveAgent`            | Queries agents table                                  | Returns synthetic active agent                       |
| `resolveAccount`          | Queries `ledger_accounts` by id                       | Queries `ledger_accounts` by id (same)               |
| `resolveCounterparty`     | Queries `ledger_counterparties` by id                 | Queries `ledger_counterparties` by id (same)         |
| `resolveRole`             | Queries role table                                    | Always returns `"owner"`                             |
| Plaid webhook             | Rejects — key resolver not configured                 | Rejects with clear "use /raw/ingest" message         |
| MCP auth                  | `FakeAuthVerifier` (same in both modes for now)       | `FakeAuthVerifier`                                   |

Setting `OPENAI_API_KEY` overrides the demo LLM fallback regardless of `BRAIN_DEMO_MODE`.

## Five-command happy path

```bash
# 1. Start infrastructure
pnpm run dev:up

# 2. Apply all migrations
node tools/migrate/dist/cli.js up

# 3. Seed the demo dataset (2 banks, 1 card, 8 counterparties, 3 PaymentIntents)
DATABASE_URL=postgres://brain:brain@localhost:5432/brain \
BRAIN_TENANT_ID=tnt_01HQ7K3DEMOTENANT \
BRAIN_ACTOR=user_01HQ7K3OPERATOR \
  node tools/seed-golden-path/dist/cli.js

# 4. Boot the API in sandbox mode
BRAIN_DEMO_MODE=true \
OPENAI_API_KEY=sk-... \
DATABASE_URL=postgres://brain:brain@localhost:5432/brain \
REDIS_URL=redis://localhost:6379 \
AUTH_JWKS_URL=https://auth.brain.fi/.well-known/jwks.json \
  pnpm -C services/api run dev &

# 5. Pump Plaid Sandbox transactions into the Raw layer
PLAID_CLIENT_ID=your-plaid-client-id \
PLAID_SECRET=your-plaid-secret \
BRAIN_TOKEN=$(node tools/dev-token/dist/index.js) \
BRAIN_API_URL=http://localhost:3000 \
  pnpm run plaid:sandbox
```

## Verification curls

```bash
T=$(node tools/dev-token/dist/index.js)

# Health (no auth)
curl -s localhost:3000/health | jq .

# Wiki schema
curl -s localhost:3000/v1/wiki/schema \
  -H "Authorization: Bearer $T" | jq '.entity_kinds'

# Wiki Q&A (requires OPENAI_API_KEY)
curl -s localhost:3000/v1/wiki/question \
  -H "Authorization: Bearer $T" \
  -H "Content-Type: application/json" \
  -d '{"question":"What are my upcoming obligations?"}' | jq '.answer, .evidence'

# List PaymentIntents (seeded: proposed / pending_approval / rejected)
curl -s "localhost:3000/v1/payment-intents" \
  -H "Authorization: Bearer $T" | jq '.items[].status'

# Create a new PaymentIntent (uses seeded account + counterparty IDs)
ACCOUNT_ID=$(psql "$DATABASE_URL" -At -c "SELECT id FROM ledger_accounts LIMIT 1")
CP_ID=$(psql "$DATABASE_URL" -At -c "SELECT id FROM ledger_counterparties LIMIT 1")
curl -s localhost:3000/v1/payment-intents \
  -X POST \
  -H "Authorization: Bearer $T" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"amount\":\"50.00\",\"currency\":\"USD\",\"source_account_id\":\"$ACCOUNT_ID\",\"counterparty_id\":\"$CP_ID\",\"action_type\":\"payment\"}" \
  | jq '.status, .policy_decision_id'

# Audit trail
curl -s "localhost:3000/v1/audit/events?limit=10" \
  -H "Authorization: Bearer $T" | jq '.[].action'
```

## Stubs NOT replaced by BRAIN_DEMO_MODE

These are out of scope for this PR and still throw in sandbox mode:

- `signedUrl` / `listParsed` / `tombstone` on raw evidence service
- `wiki.annotate`
- NetSuite, Gmail, Stripe webhook handlers (return 501)
- Wirex provisioning adapter (lives in BrainMVB, not brain-core)
- Crossmint provisioning adapter (lives in BrainMVB)
- Audit anchor publisher cron (separate process — not started by boot binary)
- `plaid_tx_v1` parser worker (no `raw_parsed` rows written; Ledger only via seed)
- MCP on-chain auth (FakeAuthVerifier in both modes until stage-8)

## Route prefix note

All service routes are mounted under `/v1` as of this PR, matching `Brain_API_Specification.yaml`. `GET /health` stays at the root (no prefix) for liveness probes.
