# External agent onboarding (MCP getting-started)

For third-party developers connecting an agent to the Brain MCP surface.
The internal-agent path (Brain-shipped agents under `services/internal-agents/`

- `services/agents/`) is documented separately in
  [agent-autonomy-v3.md](./agent-autonomy-v3.md).

## What Brain exposes to external agents

| Surface            | Mount                            | Shape                                                    |
| ------------------ | -------------------------------- | -------------------------------------------------------- |
| MCP server         | `POST /v1/agents/mcp`            | JSON-RPC 2.0, single-shot HTTP, no SSE, no session state |
| HTTP API           | `/v1/...`                        | OpenAPI 3.1, full spec at `Brain_API_Specification.yaml` |
| Audit verification | `POST /v1/audit/verify`          | Pure function, no auth, verifies a Merkle proof          |
| Proof view         | `GET /v1/proof/{action_id}/view` | Human-readable HTML for any executed action              |

12 tools, 7 resources, 5 prompts on the MCP surface today. The full inventory
lives in [mcp-architecture.md](./mcp-architecture.md).

## The trust boundary

Brain treats every external agent as adversarial by default. The §6
deterministic pre-execution gate evaluates every payment-altering action
the agent proposes, against:

- the policy your tenant has signed off-chain and registered on-chain
- the agent's `scope_hash` published in `BrainMCPAgentRegistry`
- the agent's behavior hash (the prompt/version your tenant attested to)
- a rolling per-agent micropayment cap that mirrors the on-chain session-key

**There is no `payment_intent.execute` MCP tool.** Execution is internal to
Brain. An agent proposes; the gate decides; Brain dispatches.

## End-to-end onboarding flow

Five steps. Steps 1-3 are one-time per agent; steps 4-5 are per request.

### 1. Agree the tenant on a scope vocabulary

Scopes are `{layer}:{verb}` strings from the sanctioned vocabulary
(`scripts/check-scope-vocab.mjs` enforces it). For an agent that should be
able to propose payments and read its own outcomes:

```
payment_intent:propose
payment_intent:read
ledger:read
```

The `scope_hash` is `keccak256(sorted_scopes_json)`. Compute it client-side
and pin it.

### 2. Register on-chain in `BrainMCPAgentRegistry`

The tenant signs an EIP-712 attestation; the agent (or a relayer) submits the
registration:

```solidity
BrainMCPAgentRegistry.registerAgent(
  bytes32 agentId,         // brain-allocated; see step 3
  address agentAddress,    // EOA the agent signs with
  bytes32 tenantId,        // your tenant id
  bytes32 scopeHash,       // from step 1
  bytes32 behaviorHash,    // keccak256 of the agent prompt/version
  bytes calldata tenantSignature  // EIP-712 over the digest
);
```

Contract addresses are in `SECURITY.md`. On Base Sepolia the registry is at
`0xcE7Ce9dd95c17E1F4E27D49249b6fdb015f3A7e0`.

The MCP scope-check reads this on every tool call (60-second in-process
cache; operators can flush a single agent's entry via
`McpAuthVerifier.clearCache(agentId)`).

### 3. Provision the off-chain row

The Brain side of the agent record lives in the `agents` Postgres table.
Brain-internal agents land there via `AgentService.confirmRegistration`;
external agents reach it through the SIWX onboarding flow:

```
POST /v1/auth/siwx/nonce
POST /v1/auth/siwx/verify     ← signs with agentAddress
```

The verify response returns a JWT with `principal_type=agent` and the agent's
scopes. The off-chain `agents.scope_hash` must equal the on-chain `scopeHash`
or every tool call hard-rejects with `agent_scope_hash_mismatch`.

### 4. Call a tool

Standard JSON-RPC 2.0. Authorization: bearer JWT from step 3.

```bash
# tools/list. Returns the 12-tool catalog
curl -X POST https://mcp.brain.fi \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# payment_intent.propose. Propose an x402 settlement
curl -X POST https://mcp.brain.fi \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "payment_intent.propose",
      "arguments": {
        "action_type": "x402_settle",
        "source_account_id": "acc_01...",
        "destination_counterparty_id": "cp_01...",
        "amount": "12.34",
        "currency": "USDC",
        "pay_to": "0xabc..."
      }
    }
  }'
```

### 5. Read your own proof

After the §6 gate passes and the rail dispatches, the proof is verifiable
via either the MCP resource or the HTTP route:

```
resources/read brain://proofs/{action_id}
GET /v1/proof/{action_id}/view
```

Both return the gate trace, policy decision, audit-before/after, Merkle
proof path, and the on-chain anchor tx hash. Inclusion is verifiable
independently against the Base block explorer.

## Error envelope mapping

Every failure returns a JSON-RPC error envelope with a stable `code`. The
inner `details` carry just enough context to act without leaking other tenants'
data. The most common codes during onboarding:

| Code                           | Means                                                               | Fix                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `auth_token_invalid`           | JWT signature / audience / expiry failed                            | Re-acquire from SIWX                                                                                    |
| `auth_scope_insufficient`      | Principal type is not `agent`                                       | Use the agent JWT, not a user JWT                                                                       |
| `agent_not_registered`         | Off-chain `agents` row missing or `state != 'active'`               | Finish SIWX, wait for `pending_onchain → active`                                                        |
| `agent_scope_hash_missing`     | Off-chain row has no `scope_hash`                                   | SIWX wasn't completed; redo step 3                                                                      |
| `agent_scope_hash_mismatch`    | On-chain hash differs from off-chain hash                           | Either the on-chain registration is stale or you've rotated scopes; re-register on-chain                |
| `auth_tenant_mismatch`         | JWT tenant != agent's tenant                                        | Look at the JWT claims; the SIWX flow set the wrong tenant                                              |
| `payment_intent_gate_failed`   | The §6 gate hard-rejected                                           | `details.failed_check` identifies the numbered check; read the policy decision via `policy_decision_id` |
| `payment_intent_invalid_state` | Tool requires `proposed`/`pending_approval` (cancel) or other state | Re-read the intent and only act when state matches                                                      |

## What an agent CAN do via MCP

- Propose a `PaymentIntent` with `action_type` in `ach_outbound`, `wire`, `onchain_transfer`, `card_payment`, `x402_settle`, `escrow_release`, `erp_writeback`, `other`
- Cancel its own intent while still `proposed` or `pending_approval`
- List its own intents (tenant-scoped, agent-scoped)
- Read Ledger accounts / transactions / obligations / payment-intents (tenant-scoped)
- Search and read Wiki pages
- Contribute Raw evidence (capped at `confidence: 0.5`)
- Read its own proofs

## What an agent CANNOT do via MCP

- Execute a payment. The gate is the only path; execution is Brain-internal.
- Cancel another agent's intent.
- Read another tenant's data. RLS at the storage layer enforces this even on
  bugs.
- Trigger a Ledger write directly. Every Ledger row comes from a Brain
  service.

## Local development

`BRAIN_MCP_DEV_AUTH_BYPASS=true` installs `FakeAuthVerifier` so any JWT can
call any tool. **Hard-disabled in `NODE_ENV=production`**
(`services/api/src/main.ts:784`). Use it for SDK / integration work; never
reachable in prod.

## Where to look next

- Tool + resource reference: [mcp-architecture.md](./mcp-architecture.md)
- Scope vocabulary: [scopes.md](./scopes.md)
- Audit verification: `POST /v1/audit/verify` is public + unauthenticated;
  any holder of a `(root, leaf, proof)` triple can verify inclusion without
  trusting Brain.
- Demo script driving the golden path: [demo-script.md](./demo-script.md)
