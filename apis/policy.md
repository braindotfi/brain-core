# Policy

Create policies, register them on-chain, evaluate proposed actions, and query active policy state.

### Create a Policy

```http
POST /v1/policy
Authorization: Bearer <token>
Content-Type: application/json

{
  "tenantId": "acme",
  "text": "Allow invoice payments under $5,000 to approved vendors, require approval above $5,000, and block payments to new counterparties without review."
}
```

```json
{
  "data": {
    "policy_id":   "pol_8231",
    "version":     4,
    "policy_hash": "0xabc...",
    "compiled":    { "subject": {...}, "rules": [...] },
    "explanation": "This policy will...",
    "status":      "draft"
  }
}
```

{% hint style="warning" %}
The compiled JSON and a human-readable explanation are returned together. The tenant signs the **compiled hash**, not the prose. Verify the explanation matches your intent before signing.
{% endhint %}

### Sign and Register

After review, the tenant signs an EIP-712 `PolicyRegistration` and registers on-chain.

```http
POST /v1/policy/{policy_id}/register
Authorization: Bearer <token>
Content-Type: application/json

{
  "signature": "0x..."
}
```

```json
{
  "data": {
    "policy_id":   "pol_8231",
    "version":     4,
    "policy_hash": "0xabc...",
    "tx_hash":     "0xdef...",
    "block":       9583122,
    "status":      "active"
  }
}
```

### Get the Active Policy

```http
GET /v1/policy/active?tenantId=acme
Authorization: Bearer <token>
```

```json
{
  "data": {
    "version":     4,
    "policy_hash": "0xabc...",
    "compiled":    { ... },
    "active_since": "2025-09-01T12:00:00Z"
  }
}
```

### Evaluate a Hypothetical Action

Dry-run an action against the active policy without proposing it.

```http
POST /v1/policy/evaluate
Authorization: Bearer <token>
Content-Type: application/json

{
  "tenantId": "acme",
  "action":   {
    "type":       "pay_invoice",
    "amount":     7800,
    "currency":   "USD",
    "counterparty_id": "cp_vendor_x"
  }
}
```

```json
{
  "data": {
    "decision":      "ESCALATE",
    "approvers":     ["role:cfo"],
    "policy_version": 4,
    "matched_rule":  "amount >= 5000 && counterparty.known",
    "audit_event_id": "evt_..."
  }
}
```

### Three Possible Decisions

<table><thead><tr><th width="250">Decision</th><th>Meaning</th></tr></thead><tbody><tr><td><code>ALLOW</code></td><td>Action proceeds; signed policy verdict attached to the resulting UserOp or rail call</td></tr><tr><td><code>DENY</code></td><td>Action blocked; structured <code>reason</code> in the response</td></tr><tr><td><code>ESCALATE</code></td><td>Human approval required; <code>approvers</code> lists required signers</td></tr></tbody></table>

### Revoke a Policy Version

```http
POST /v1/policy/{policy_id}/revoke
Authorization: Bearer <token>
Content-Type: application/json

{
  "signature": "0x..."   // EIP-712 by tenant
}
```

The tenant must register a new active version before further policy-gated actions can run.

### List Policy History

```http
GET /v1/policy/history?tenantId=acme
Authorization: Bearer <token>
```

```json
{
  "data": [
    { "version": 4, "policy_hash": "0xabc...", "active_since": "2025-09-01T12:00:00Z" },
    { "version": 3, "policy_hash": "0x123...", "active_from": "2025-06-01", "revoked_at": "2025-09-01T12:00:00Z" }
  ]
}
```
