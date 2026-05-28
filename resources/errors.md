# Errors

Every error Brain returns uses a single envelope: a stable `snake_case` `code`, a human-readable `message`, optional structured `details`, a `request_id` for cross-system correlation, and a `docs_url`. Codes are stable forever once shipped (format: `{domain}_{condition}`). The full registry lives in `shared/src/errors.ts`.

{% hint style="warning" %}
Brain **never** returns HTTP 200 with an error in the body. A non-2xx status always carries this envelope.
{% endhint %}

### Shape

```json
{
  "error": {
    "code": "policy_denied",
    "message": "Counterparty not in the approved allowlist",
    "details": { "counterparty_id": "cp_x", "policy_version": 3 },
    "request_id": "req_8f3a92...",
    "docs_url": "https://docs.brain.fi/errors/policy_denied"
  }
}
```

In the SDK:

```typescript
try {
  await brain.pay("acme", { invoiceId: "inv_8231" });
} catch (err) {
  if (err instanceof BrainError) {
    console.log(err.code, err.message, err.requestId);
  }
}
```

### Auth (401) and Authorization (403)

| Code                       | Meaning                                                                                | Fix                                              |
| -------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `auth_token_missing`       | No bearer token on a protected route                                                   | Send `Authorization: Bearer <token>`             |
| `auth_token_invalid`       | Token malformed or signature failed                                                    | Re-issue the token                               |
| `auth_token_expired`       | Access token past its expiry                                                           | Log in / re-sign and retry                       |
| `auth_invalid_key`         | API key malformed, revoked, or for the wrong environment                               | Check `.env`; sandbox and production keys differ |
| `auth_invalid_credentials` | Email/password login failed (also returned for an unknown email — no user enumeration) | Check the credentials                            |
| `auth_email_unverified`    | The owner's email has not been verified                                                | Complete `POST /v1/auth/verify-email`            |
| `auth_siwx_invalid`        | SIWX signature did not verify                                                          | Re-sign with the registered key                  |
| `auth_scope_insufficient`  | Token lacks the required scope                                                         | Re-issue with the right scope                    |

### Self-serve onboarding

| Code                    | Meaning                                                         | Fix                                     |
| ----------------------- | --------------------------------------------------------------- | --------------------------------------- |
| `signup_email_taken`    | An account with this email already exists (409)                 | Log in instead, or use another email    |
| `signup_token_invalid`  | The email-verification token is invalid, expired, or used (400) | Request a new verification token        |
| `wallet_already_linked` | The wallet is already linked to an account (409)                | Use a different wallet, or unlink first |

### Tenant

| Code                   | Meaning                                           | Fix                                                |
| ---------------------- | ------------------------------------------------- | -------------------------------------------------- |
| `tenant_not_found`     | The `tenant_id` doesn't exist in this environment | Verify the id; sandbox and production are separate |
| `tenant_suspended`     | The tenant is suspended (403)                     | Contact support                                    |
| `tenant_access_denied` | Authenticated, but not for this tenant (403)      | Check the token's tenant                           |

### Source and Raw

| Code                            | Meaning                                         | Fix                               |
| ------------------------------- | ----------------------------------------------- | --------------------------------- |
| `source_not_found`              | Source id doesn't match a connected source      | List sources to find the right id |
| `source_credential_invalid`     | Upstream-source credentials were rejected (401) | Reconnect the source              |
| `raw_artifact_not_found`        | No raw artifact for that id (404)               | Check the id                      |
| `raw_webhook_signature_invalid` | A provider webhook's HMAC didn't verify (401)   | Check the signing secret          |

### Policy

Policy **decisions** are `allow` / `confirm` / `reject` (returned on the decision, not as errors). These codes are the error conditions:

| Code                       | Meaning                                                | Fix                                    |
| -------------------------- | ------------------------------------------------------ | -------------------------------------- |
| `policy_not_found`         | No policy for the tenant (404)                         | Create + activate a policy             |
| `policy_not_active`        | The tenant has no active policy version (409)          | Activate a policy version              |
| `policy_denied`            | The action violates the active policy (422)            | Read `details` for which rule fired    |
| `policy_quorum_not_met`    | Required approver quorum not reached (409)             | Collect the remaining approvals        |
| `policy_version_mismatch`  | The decision was for a superseded policy version (409) | Re-evaluate against the active version |
| `policy_signature_invalid` | The signed policy attestation didn't verify (401)      | Re-sign the policy                     |

### Agent and scope

| Code                        | Meaning                                                | Fix                                          |
| --------------------------- | ------------------------------------------------------ | -------------------------------------------- |
| `agent_not_found`           | Agent id doesn't match a registered agent (404)        | List agents                                  |
| `agent_not_registered`      | Agent has no on-chain registration (401)               | Register in `BrainMCPAgentRegistry`          |
| `agent_inactive`            | Agent record is not `active` (409)                     | Reactivate / re-register                     |
| `agent_scope_hash_mismatch` | JWT `scope_hash` ≠ the on-chain hash (401)             | Re-sign with current scope (or it's revoked) |
| `scope_expired`             | The scope grant's window has passed (403)              | Renew the grant                              |
| `agent_proposal_duplicate`  | This run already produced an equivalent proposal (409) | Reuse the existing proposal                  |

### PaymentIntent / Action

| Code                           | Meaning                                               | Fix                                 |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------- |
| `payment_intent_not_found`     | No PaymentIntent for that id (404)                    | Check the id                        |
| `payment_intent_invalid_state` | The intent isn't in a state that allows this op (409) | Read its current `status`           |
| `payment_intent_gate_failed`   | The §6 pre-execution gate rejected the intent (409)   | Read `details` for the failed check |
| `action_already_executed`      | Already settled (409)                                 | No retry needed                     |
| `idempotency_key_reused`       | Same idempotency key, different request body (409)    | Generate a new key                  |

### Pre-execution gate failures

When the §6 gate rejects an intent it surfaces as `payment_intent_gate_failed`, with `details` naming the failed check (e.g. behavior-hash pinned 1.5, balance, counterparty, approval, escrow-state binding 6.6). Standalone gate codes:

| Code                           | Meaning                                                |
| ------------------------------ | ------------------------------------------------------ |
| `gate_no_policy_decision`      | No PolicyDecision linked to the intent                 |
| `gate_policy_version_stale`    | The active policy superseded the one Policy evaluated  |
| `gate_counterparty_unverified` | Counterparty `verified_status` doesn't meet the policy |
| `gate_counterparty_sanctioned` | Counterparty is sanctioned per latest screening        |
| `gate_balance_insufficient`    | Source balance < amount at gate time                   |
| `gate_approval_incomplete`     | Required approver signatures missing or invalid        |
| `gate_session_key_invalid`     | On-chain session key expired or out-of-scope           |
| `gate_audit_chain_stale`       | Audit anchor too stale for the configured threshold    |

[**→ The pre-execution gate**](../protocol/the-pre-execution-gate.md)

### Validation (400)

| Code                     | Meaning                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `request_body_invalid`   | Request body failed validation; `details` lists the issues |
| `request_params_invalid` | Path/query params failed validation                        |
| `validation_failed`      | Generic schema validation failure                          |
| `missing_required_field` | A required field is absent                                 |
| `invalid_cursor`         | The pagination cursor is malformed or expired              |

### Rate limiting and server

| Code               | Status | Meaning                                                          |
| ------------------ | ------ | ---------------------------------------------------------------- |
| `rate_limited`     | 429    | Per-minute limit for your tier; honour the `Retry-After` header  |
| `internal_error`   | 500    | Unexpected error; retry, and include the `request_id` in support |
| `upstream_timeout` | 504    | A downstream source timed out; retry with backoff                |
| `maintenance_mode` | 503    | Scheduled maintenance                                            |

### MCP-Specific JSON-RPC Codes

The MCP surface (`POST /v1/agents/mcp`) returns JSON-RPC error codes:

| Code     | Meaning                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------- |
| `-32001` | Auth token missing, invalid, or expired (covers `auth_token_missing/invalid/expired`)                 |
| `-32002` | Scope insufficient — also tenant mismatch (covers `auth_scope_insufficient` / `auth_tenant_mismatch`) |
| `-32003` | Agent not registered or inactive (`agent_not_registered`)                                             |
| `-32004` | Pre-execution gate failed — covers every `gate_*` sub-code (`payment_intent_gate_failed`)             |
| `-32005` | Agent `scope_hash` does not match on-chain registration (`agent_scope_hash_mismatch`)                 |
| `-32600` | Invalid request (standard JSON-RPC)                                                                   |
| `-32601` | Method not found                                                                                      |
| `-32602` | Invalid params                                                                                        |
| `-32603` | Internal error                                                                                        |

### Getting Help

Include the `request_id` from the error envelope when contacting support — Brain can resolve the exact request from it.
