# Readiness history

Per-tag snapshots of `pnpm run production-readiness --json` output, committed at each release tag. Lets diligence reviewers reconstruct the production-readiness trajectory over time without an external dashboard.

## How it works

* `scripts/readiness-snapshot.mjs` captures the current aggregator JSON to `docs/readiness-history/<tag>.json`.
* `scripts/readiness-trend.mjs` reads every snapshot in this directory and prints a trend table: open P0 count, open P1 count, red/yellow/green counts per snapshot, delta from prior snapshot.
* The CI workflow runs the snapshot script on release tag push so the history is durable in git.

## Why git-native

Storing the JSON in this directory (rather than pushing to an external dashboard) keeps the trend evidence inside the same audit substrate as the rest of the codebase. Diligence reviewers already have read access; they don't need a separate tool to read the readiness trajectory.

Per-snapshot file naming: `<tag>.json` (e.g. `v0.3.0-rc.1.json`). The tag is captured at snapshot time and stored in the JSON alongside the readiness data so the history is self-describing.

## Reading the trend

```bash
pnpm run readiness-trend
```

Prints the trend across every snapshot in this directory, oldest first. Use this in investor-update prep or release-readiness reviews.
