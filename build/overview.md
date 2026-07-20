---
description: Task-shaped guides. The patterns most apps need in their first hour.
---

# Overview

Each guide on this page solves one task end-to-end. Pick the one that matches what you're trying to ship; come back for the rest as you grow.

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🚪 Sign Up and Onboard</strong></td><td>Self-provision a sandbox tenant; log in as a human or point an agent at it.</td><td><a href="sign-up-and-onboard.md">sign-up-and-onboard.md</a></td><td></td></tr><tr><td><strong>📊 Read a Financial Picture</strong></td><td>Pull balances, transactions, obligations, and counterparties for a tenant.</td><td><a href="read-a-financial-picture.md">read-a-financial-picture.md</a></td><td></td></tr><tr><td><strong>💸 Pay an Invoice Safely</strong></td><td>Propose a payment, route to approval if needed, execute, get a receipt.</td><td><a href="pay-an-invoice-safely.md">pay-an-invoice-safely.md</a></td><td></td></tr><tr><td><strong>🛡 Give an Agent a Spending Limit</strong></td><td>Define a policy in plain English. Brain enforces it on every proposed action.</td><td><a href="give-an-agent-a-spending-limit.md">give-an-agent-a-spending-limit.md</a></td><td></td></tr><tr><td><strong>📜 Audit Every Action</strong></td><td>Pull a verifiable trail of what your agent (or user) did.</td><td><a href="audit-every-action.md">audit-every-action.md</a></td><td></td></tr><tr><td><strong>🔌 Let an External Agent In</strong></td><td>Authorize an MCP-compatible agent to read and propose on a tenant's behalf.</td><td><a href="let-an-external-agent-in.md">let-an-external-agent-in.md</a></td><td></td></tr><tr><td><strong>🧩 Use Brain Agent Skills</strong></td><td>Install task-specific recipes for Brain's MCP proposal surface.</td><td><a href="use-brain-agent-skills.md">use-brain-agent-skills.md</a></td><td></td></tr></tbody></table>

### What Every Guide Assumes

| Assumption                    | How to satisfy                                            |
| ----------------------------- | --------------------------------------------------------- |
| You finished the Quickstart   | The SDK is installed, your API key works, a tenant exists |
| You're in sandbox             | Production works the same way; sandbox is just safer      |
| You're calling from a backend | Server keys never go in client-side code                  |

```typescript
import { Brain } from "@brainfinance/sdk";

export const brain = new Brain({ apiKey: process.env.BRAIN_API_KEY });
```

### What You'll Keep Coming Back To

| Pattern                          | Where                                                                      |
| -------------------------------- | -------------------------------------------------------------------------- |
| The SDK methods you already know | Each guide reuses `brain.ask`, `brain.pay`, `brain.approve`, `brain.proof` |
| Idempotency keys                 | Required on every mutating call; retries are free                          |
| Trace IDs                        | Returned on every response; paste into the Console for the full timeline   |
| Webhooks                         | Subscribe once, get notified on the events you care about                  |
