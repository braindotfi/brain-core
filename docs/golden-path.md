# Golden Path. End-to-end demo runbook

`pnpm demo:golden-path` drives the **entire** Brain protocol against a running
local stack and prints a summary table. It is the strongest single artifact for
showing the pipeline works front to back:

```
seed → ingest → normalize → wiki → reconcile → invoice-shortcut propose →
policy → approve → execute (rail) → anchor → fetch + verify proof
```

## Prerequisites

- Docker Compose v2, Node 22, pnpm ≥9, `jq`, `curl`.
- Build once: `pnpm install && pnpm run build`.

## Run it

```bash
# 1. Infra: pg+pgvector :5432, redis :6379, localstack :4566
pnpm run dev:up

# 2. Apply migrations
node tools/migrate/dist/cli.js up

# 3. Boot the API (demo mode wires permissive sandbox resolvers)
BRAIN_DEMO_MODE=true pnpm -C services/api start    # serves http://localhost:3000

# 4. Drive the whole pipeline
pnpm demo:golden-path
```

Pick the settlement rail with `BRAIN_DEMO_RAIL`:

| Value                     | Rail                           | Notes                          |
| ------------------------- | ------------------------------ | ------------------------------ |
| `plaid_sandbox` (default) | `bank_ach` via Plaid sandbox   | No real money; sandbox tokens. |
| `onchain_base_sepolia`    | `onchain_base` on Base Sepolia | Testnet; needs an RPC + key.   |

## Expected output (summary table)

```
══ Summary ══
STEP         STATUS  DURATION   OUTPUT
----         ------  --------   ------
seed         ok      820ms
token        ok      40ms
ingest       ok      110ms      raw_01J…
normalize    ok      230ms      inv_01J…
wiki         ok      180ms      ent_01J…
reconcile    ok      150ms      run_01J…
propose      ok      210ms      pi_01J…       (policy: allow|confirm)
approve      ok      90ms       pi_01J…
execute      ok      640ms      pi_01J…       (status: dispatching|executed)
anchor       warn    70ms                     (async worker; may anchor later)
verify       ok      130ms      true

✓ Human-readable proof: http://localhost:3000/v1/proof/pi_01J…/view
```

The run ends by printing the **proof view URL**. Open it in a browser for the
compliance-/investor-facing screen (see `services/api/src/proof/view.ts`).

## Sandbox vs mock providers

- **Plaid**: sandbox (no real money). `onchain_base`: Base Sepolia testnet.
- **Audit anchoring**: the on-chain anchor publisher is a background worker, so
  the `anchor` step may report `warn` if the batch anchors asynchronously. The
  proof is still recorded and verifiable off-chain immediately.
- **LLM / embeddings**: deterministic mock adapters in demo mode.

## Troubleshooting

| Symptom                              | Fix                                                           |
| ------------------------------------ | ------------------------------------------------------------- |
| `seed failed`                        | See `/tmp/gp_seed.log`; ensure migrations ran (`migrate up`). |
| `no normalized invoice`              | The normalize worker isn't running; start it or re-run seed.  |
| `propose failed`                     | Confirm `BRAIN_DEMO_MODE=true` and the API is on `:3000`.     |
| `anchor` shows `warn`                | Expected. Anchoring is async. Re-fetch the proof shortly.     |
| endpoint shape mismatch (warn steps) | Some calls are best-effort; align paths on first live run.    |

> **Note (CI parity):** `docker-compose.smoke.yml` runs this exact script against
> a fresh stack and exits non-zero on any required-step failure; the `golden_path_smoke`
> CI job runs it after the integration tests. This runbook and the script were
> authored without a live stack in the dev environment (see `BLOCKERS.md` B-1), so
> the `warn`-tolerant steps may need endpoint-path alignment on the first live run.
