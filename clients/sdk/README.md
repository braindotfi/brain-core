# @brain/sdk

The typed HTTP client for the Brain API.

This package is the source-of-truth client that backs every code example on
[docs.brain.fi](https://docs.brain.fi). It exposes:

- A low-level typed client (`createBrainHttpClient`) generated from
  [`Brain_API_Specification.yaml`](../../Brain_API_Specification.yaml).
- (Future, Step 1B) A high-level `Brain` class with convenience methods
  (`brain.ask`, `brain.pay`, `brain.proof`, namespaced helpers) as documented
  on the homepage.

## Status

| Step | Surface                                                                                                      | Status                  |
| ---- | ------------------------------------------------------------------------------------------------------------ | ----------------------- |
| 1A   | `createBrainHttpClient` over the full 57-endpoint OpenAPI surface                                            | **shipping in this PR** |
| 1B   | `Brain` class with the flat + namespaced surface from docs.brain.fi                                          | not yet implemented     |
| 1C   | Doc-example smoke test (CI extracts every TypeScript block from `*.md` and type-checks against this package) | not yet implemented     |

## Usage (1A surface)

```typescript
import { createBrainHttpClient } from "@brain/sdk";

const http = createBrainHttpClient({
  apiKey: process.env.BRAIN_API_KEY!,
  baseUrl: "https://api.brain.fi/v1",
});

const { data, error } = await http.GET("/ledger/accounts", {
  params: { query: { status: "active" } },
});
```

The client is fully typed against the OpenAPI spec. Path, query, body, and
response shapes are inferred — there is no hand-written type surface to drift.

## Codegen

```bash
pnpm --filter @brain/sdk run codegen
```

Regenerates `src/generated/openapi.d.ts` from
[`Brain_API_Specification.yaml`](../../Brain_API_Specification.yaml). The
generated file is committed so downstream consumers don't need to run codegen
on `pnpm install`. CI runs `codegen:check` to catch drift.

## Publish target

`private: true` for now. Future intent: publish to GitHub Packages with
private access (organisation members and authorised consumers only). The
docs commit to `npm install @brain/sdk`; until a publish workflow lands, that
command does not yet resolve — see Step 1A in the SDK plan thread for
sequencing.

## Conventions

Follows the standard Brain TypeScript package layout: strict mode, ESM,
`tsc -b` build, `dist/` output, Vitest with 80% line / 75% branch coverage.
