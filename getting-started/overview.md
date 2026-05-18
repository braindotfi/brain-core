# Overview

This section takes you from zero to a running, policy-gated agent action in roughly fifteen minutes. You will set up an account, generate API keys, make a first request, connect a financial source, and execute an action that flows through every layer of the stack.

{% hint style="info" %}
Everything in this section runs in the **Sandbox** environment. Sandbox uses Base Sepolia for on-chain anchoring and accepts test credentials for sources like Plaid. No real money moves.
{% endhint %}

### Path Map

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>1. Account Setup</strong></td><td>Create a Brain account, your first tenant, and invite teammates.</td><td></td><td></td></tr><tr><td><strong>2. API Keys</strong></td><td>Generate keys for sandbox and production, set environment variables.</td><td></td><td></td></tr><tr><td><strong>3. Your First Request</strong></td><td>Install the SDK, hit a read endpoint, inspect a trace.</td><td></td><td></td></tr><tr><td><strong>4. Connect Your First Source</strong></td><td>Plug in a Plaid sandbox account and watch the Ledger populate.</td><td></td><td></td></tr><tr><td><strong>5. Your First Policy-Gated Action</strong></td><td>Write policy, register an agent, propose, approve, execute.</td><td></td><td></td></tr></tbody></table>

### What You'll Need

| Requirement                 | Detail                                               |
| --------------------------- | ---------------------------------------------------- |
| **Node.js**                 | Version 18 or higher (for the TypeScript SDK)        |
| **An email address**        | For console signup                                   |
| **A code editor**           | VS Code, Cursor, or anything that handles TypeScript |
| **Five to fifteen minutes** | Depending on how thoroughly you read                 |

### What You Do Not Need

| Not Required                   | Why                                                   |
| ------------------------------ | ----------------------------------------------------- |
| **Real bank credentials**      | Sandbox uses Plaid test data                          |
| **Crypto wallet**              | Sandbox supplies a test smart account on Base Sepolia |
| **EVM development experience** | The SDK abstracts contract interactions               |
| **Funded balances**            | Sandbox uses test tokens                              |

### What You Will End With

By the time you finish this section, you will have:

| Artifact                       | Where                                   |
| ------------------------------ | --------------------------------------- |
| **An active Brain account**    | `console.brain.dev`                     |
| **API keys**                   | Stored as environment variables locally |
| **A connected sandbox source** | Visible in the Console under Sources    |
| **An active policy**           | Anchored on Base Sepolia                |
| **A registered agent**         | Visible in the Agent Manager            |
| **A completed action**         | With a verifiable audit proof           |

### Where to Go After

When you finish Getting Started, you have two natural next steps.

<table data-view="cards"><thead><tr><th></th><th></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🏗️ Learn the Architecture</strong></td><td>Understand the six-layer stack from the inside.</td><td></td></tr><tr><td><strong>🛠️ Build with the SDK</strong></td><td>Dig into the TypeScript SDK reference.</td><td></td></tr></tbody></table>

### Already Familiar?

If you have read the whitepaper and want to skip straight to code, jump to the SDK Quickstart. It assumes you've already generated keys and walks through the same five-minute flow with less context.

### Let's Go

[**→ Step 1: Setup Your Account**](setup-your-account.md)
