# `@brain/sdk`

The official TypeScript SDK for the Brain Finance API.

Source of truth: <https://docs.brain.fi>. This SDK is the runtime
implementation of the public contract published on the docs site. Where
the docs and this SDK disagree, the docs win and the SDK is patched.

## Install

```bash
npm install @brain/sdk
# or
pnpm add @brain/sdk
# or
yarn add @brain/sdk
```

## Quickstart

```ts
import { Brain } from "@brain/sdk";

const brain = new Brain({ apiKey: process.env.BRAIN_API_KEY! });

// Natural-language query against the tenant's financial brain.
const answer = await brain.ask("acme", "What did we spend on AWS last month?");
console.log(answer.text);

// Propose a payment. Policy gates execution.
const action = await brain.pay("acme", { invoiceId: "inv_8231" });

// Get a verifiable receipt with an on-chain Merkle anchor.
const proof = await brain.proof(action.id);
```

## Configuration

| Option            | Type                              | Default                          | Notes                                                                                              |
| ----------------- | --------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `apiKey`          | `string` (required)               | —                                | Server key issued by the Brain Console. Sandbox keys start with `brain_sk_test_`, production with `brain_sk_live_`. |
| `environment`     | `"sandbox" \| "production"`       | `"production"`                   | Selects the default base URL. Override with `baseUrl` if needed.                                   |
| `baseUrl`         | `string`                          | resolved from `environment`      | Production: `https://api.brain.fi/v1`. Sandbox: `https://api.brain.dev/v1`.                        |
| `fetch`           | `typeof globalThis.fetch`         | `globalThis.fetch`               | Provide your own `fetch` implementation for runtimes that don't have a global one (older Node, etc.). |
| `agentSigner`     | `AgentSigner` (TBD)               | `undefined`                      | Optional SIWX signer for external-agent flows (`brain.auth.signInWithSIWX()`).                     |
| `defaultTenantId` | `string`                          | `undefined`                      | If set, methods that take `tenantId` will fall back to this value when called without one.         |

## Runtime support

The SDK is runtime-agnostic. It works in:

- Node 18+ (uses the built-in `fetch`)
- Bun
- Deno
- Edge runtimes (Cloudflare Workers, Vercel Edge)
- Modern browsers (do **not** ship server keys to the browser; this is for read-only use cases like dashboards backed by a JIT-issued public token)

Pass a custom `fetch` if your runtime needs one.

## Idempotency

Every mutating call (`brain.pay`, `brain.actions.execute`, etc.) sends
an `Idempotency-Key` header. The SDK generates a ULID per request
unless you supply your own via `idempotencyKey` on the call options.
Retries with the same key are guaranteed not to double-execute.

## Errors

The SDK throws typed `BrainError` subclasses. Every code maps 1:1 to
the canonical registry at <https://docs.brain.fi/resources/errors>.

```ts
import { Brain, PolicyDeniedError } from "@brain/sdk";

try {
  await brain.pay("acme", { invoiceId: "inv_8231" });
} catch (err) {
  if (err instanceof PolicyDeniedError) {
    console.log("policy said no:", err.details);
  }
  throw err;
}
```

## Status

`0.1.0` — scaffold. Method surface is published; implementations land
incrementally. Track progress in `docs/sdk-audit.md` and the PR queue.
