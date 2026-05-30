# Audit Area: Schedulers

**Scope:** Background jobs that run on timers or event triggers outside the request/response cycle. The anchor broadcaster, webhook dead-letter reconciler, and any cron-style workers.

**Reports planned:**

- `background-jobs.md`. `anchorBroadcaster` (viem write to `BrainAuditAnchor`, runs inside the API process. Confirm actual file path: `services/api/src/anchorBroadcaster.ts`, NOT `services/audit/src/`), `services/audit/src/reconciler.ts` (dead-letter replay), `services/audit/src/webhooks.ts` dispatcher. For each: trigger mechanism, failure handling, observability, retry policy.

**Note:** Prior audit incorrectly cited `services/audit/src/anchorBroadcaster.ts`. The file actually lives at `services/api/src/anchorBroadcaster.ts` and is imported by `services/api/src/main.ts`. Correct this finding in the report.

**Relevant files:** `services/api/src/anchorBroadcaster.ts`, `services/audit/src/reconciler.ts`, `services/audit/src/webhooks.ts`, `services/audit/src/publisher.ts`.
