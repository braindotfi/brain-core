# Overview

The Brain SDK is the official TypeScript client for Brain. It wraps the REST and JSON-RPC surfaces, handles SIWX authentication for agents, and exposes typed methods for every layer.

### Installation

```bash
npm install @brain/sdk
# or
yarn add @brain/sdk
# or
pnpm add @brain/sdk
```

### Initialising the Client

```typescript
import { Brain } from "@brain/sdk";

const brain = new Brain({
  apiKey: process.env.BRAIN_KEY,
  // Optional, defaults to "production"
  environment: "production", // | "sandbox"
});
```

For agents authenticating via SIWX:

```typescript
const brain = new Brain({
  agentSigner: yourSigner,        // ethers.js / viem signer
  environment: "sandbox",
});

await brain.auth.signInWithSIWX(); // session managed automatically
```

### Top-level Namespaces

| Namespace       | Purpose                                | Reference      |
| --------------- | -------------------------------------- | -------------- |
| `brain.auth`    | OAuth and SIWX authentication          | Authentication |
| `brain.sources` | Connect financial sources              | Sources        |
| `brain.ledger`  | Query structured records               | Ledger         |
| `brain.wiki`    | Ask questions, browse the entity graph | Wiki SDK       |
| `brain.policy`  | Create, update, evaluate policies      | Policy SDK     |
| `brain.agents`  | Register agents, propose actions       | Agents SDK     |
| `brain.actions` | Approve, execute, query actions        | Agents SDK     |
| `brain.audit`   | Pull audit events and Merkle proofs    | Audit SDK      |

### Configuration

```bash
# .env
BRAIN_KEY=brain_sk_...
BRAIN_ENV=production           # or sandbox
BRAIN_TENANT_ID=acme           # default tenant for calls
```

```typescript
const brain = new Brain({
  apiKey:     process.env.BRAIN_KEY,
  environment: process.env.BRAIN_ENV as "production" | "sandbox",
  defaultTenantId: process.env.BRAIN_TENANT_ID,
});
```

{% hint style="warning" %}
Never commit secret keys to source control. Use environment variables, a secrets manager, or a managed identity service in production.
{% endhint %}

### Provenance is Automatic

Every response from Wiki, Policy, and Agent methods carries provenance fields. The SDK exposes them as typed properties.

```typescript
const answer = await brain.wiki.question({
  tenantId: "acme",
  question: "What did we spend on AWS last quarter?",
});

answer.text;            // string
answer.citations;       // Array<{ type, id }>
answer.policy_version;  // string | null
answer.audit_event_id;  // string
```

[**→ Wiki SDK reference**](wiki.md)

### TypeScript-First

The SDK is written in TypeScript. All types are exported.

```typescript
import type {
  Tenant,
  Source,
  LedgerRecord,
  WikiAnswer,
  Policy,
  Agent,
  Action,
  ActionDecision,
  AuditEvent,
  MerkleProof,
} from "@brain/sdk";
```
