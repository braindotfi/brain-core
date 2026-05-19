# Errors

Every error Brain returns includes a structured `code`, a human-readable `message`, and a `traceId` for cross-system correlation. When opening a support ticket, include the trace ID and Brain can resolve the exact request.

### Shape

```json
{
  "error": {
    "code":     "POLICY_DENIED",
    "message":  "Counterparty not in approved allowlist",
    "traceId":  "trc_8f3a92..."
  }
}
```

In the SDK:

```typescript
try {
  await brain.pay("acme", { invoiceId: "inv_8231" });
} catch (err) {
  if (err instanceof BrainError) {
    console.log(err.code, err.message, err.traceId);
  }
}
```

### Auth Errors

| Code                 | Meaning                                                     | Fix                                                                                      |
| -------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `AUTH_INVALID_KEY`   | API key is malformed, revoked, or for the wrong environment | Check `.env`; sandbox keys start with `brain_sk_test_`, production with `brain_sk_live_` |
| `AUTH_EXPIRED`       | OAuth or JWT token expired                                  | Refresh and retry                                                                        |
| `AUTH_SIWX_INVALID`  | SIWX signature did not verify                               | Re-sign with the registered key                                                          |
| `SCOPE_INSUFFICIENT` | Key or token lacks the required scope                       | Re-issue with the right scope, or use a different key                                    |

### Tenant Errors

| Code                   | Meaning                                          | Fix                                                  |
| ---------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| `TENANT_NOT_FOUND`     | The `tenantId` doesn't exist in this environment | Verify spelling; sandbox and production are separate |
| `TENANT_SUSPENDED`     | The tenant is suspended                          | Contact support                                      |
| `TENANT_ACCESS_DENIED` | The caller is authorized but not for this tenant | Check key scope                                      |

### Source Errors

| Code                        | Meaning                                           | Fix                                   |
| --------------------------- | ------------------------------------------------- | ------------------------------------- |
| `SOURCE_NOT_FOUND`          | Source ID doesn't match a connected source        | List sources to find the right ID     |
| `SOURCE_RATE_LIMIT`         | Upstream source returned 429                      | Wait and retry; check upstream status |
| `SOURCE_CREDENTIAL_INVALID` | Credentials for the upstream source were rejected | Reconnect the source                  |

### Policy and Decision Errors

| Code                | Meaning                                       | Fix                                 |
| ------------------- | --------------------------------------------- | ----------------------------------- |
| `POLICY_NOT_ACTIVE` | The tenant has no active policy               | Create and activate a policy        |
| `POLICY_DENIED`     | Action violates the active policy             | Read `details` for which rule fired |
| `POLICY_ESCALATE`   | Action requires human approval before execute | Route to your approval UI           |

### Agent and Scope Errors

| Code                  | Meaning                                      | Fix                                            |
| --------------------- | -------------------------------------------- | ---------------------------------------------- |
| `AGENT_NOT_FOUND`     | Agent ID doesn't match a registered agent    | List agents in the Console                     |
| `AGENT_INACTIVE`      | Agent record is not active                   | Reactivate or re-register                      |
| `SCOPE_HASH_MISMATCH` | JWT `scope_hash` doesn't match on-chain hash | Re-sign with current scope; could mean revoked |
| `SCOPE_EXPIRED`       | Scope grant's `notAfter` window has passed   | Renew the grant                                |

### Action Errors

| Code                      | Meaning                                                        | Fix                                |
| ------------------------- | -------------------------------------------------------------- | ---------------------------------- |
| `ACTION_NOT_FOUND`        | Action ID doesn't exist                                        | Check for typos; was it cancelled? |
| `ACTION_ALREADY_EXECUTED` | Action already settled                                         | Read state; retry not needed       |
| `INSUFFICIENT_BALANCE`    | Source account balance < amount                                | Top up or pick a different account |
| `LIMITS_EXCEEDED`         | Account-level per-tx or per-day limit exceeded                 | Adjust limits in the Console       |
| `IDEMPOTENCY_KEY_REUSED`  | The same idempotency key was used for a different request body | Generate a new key                 |

### Pre-Execution Gate Failures

| Code                           | Meaning                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| `GATE_NO_POLICY_DECISION`      | No PolicyDecision linked to this action                           |
| `GATE_POLICY_VERSION_STALE`    | Active policy superseded the one Policy evaluated                 |
| `GATE_COUNTERPARTY_UNVERIFIED` | Counterparty's `verified_status` doesn't match policy requirement |
| `GATE_COUNTERPARTY_SANCTIONED` | Counterparty is sanctioned per latest screening                   |
| `GATE_BALANCE_INSUFFICIENT`    | Source account balance < amount at gate time                      |
| `GATE_APPROVAL_INCOMPLETE`     | Required approver signatures missing or invalid                   |
| `GATE_SESSION_KEY_INVALID`     | On-chain session key is expired or out-of-scope                   |
| `GATE_AUDIT_CHAIN_STALE`       | Audit anchor too stale for the configured threshold               |

[**→ The pre-execution gate**](../protocol/the-pre-execution-gate.md)

### Rate Limiting

| Code           | Detail                                          |
| -------------- | ----------------------------------------------- |
| `RATE_LIMITED` | You hit the per-minute limit for your plan tier |

The response includes a `Retry-After` header (seconds). Sandbox limits are 60 rpm, developer 600 rpm, production 6,000 rpm, enterprise custom.

### Validation Errors

| Code                     | Meaning                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| `VALIDATION_FAILED`      | Request body failed schema validation; `details` lists each field error |
| `MISSING_REQUIRED_FIELD` | A required field is absent                                              |
| `INVALID_CURSOR`         | The pagination cursor is malformed or expired                           |

### Server Errors

| Code               | Meaning                           | Fix                                                       |
| ------------------ | --------------------------------- | --------------------------------------------------------- |
| `INTERNAL_ERROR`   | Brain hit an unexpected error     | Retry; if persistent, include `traceId` in support ticket |
| `UPSTREAM_TIMEOUT` | A downstream source timed out     | Retry with backoff                                        |
| `MAINTENANCE_MODE` | Brain is in scheduled maintenance | Check [status.brain.fi](https://status.brain.fi)          |

### MCP-Specific JSON-RPC Codes

| Code     | Meaning                                   |
| -------- | ----------------------------------------- |
| `-32001` | JWT invalid or expired                    |
| `-32002` | Agent record not active                   |
| `-32003` | `scope_hash` does not match on-chain hash |
| `-32004` | Per-call scope insufficient               |
| `-32005` | Tenant mismatch                           |
| `-32600` | Invalid request (standard JSON-RPC)       |
| `-32601` | Method not found                          |
| `-32602` | Invalid params                            |
| `-32603` | Internal error                            |

### Getting Help

| Channel                                        | Best for                                       |
| ---------------------------------------------- | ---------------------------------------------- |
| **Trace ID + email**                           | Specific failed requests; include the trace ID |
| [**status.brain.fi**](https://status.brain.fi) | Is Brain having an outage?                     |
