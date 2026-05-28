# Audit Area: Queues

**Scope:** BullMQ queue producers, consumers, and the new domain event bus (`shared/src/events/`). Validates which queues are actually produced, which are consumed, and which are declared but orphaned.

**Reports planned:**
- `bullmq-queues.md`. Enumerate all BullMQ queue names, their producers (where enqueued), and their consumers (worker that dequeues). Cross-check with `startNormalizeWorker`, `startOutboxWorker`, `createAgentRouteWorker`. Identify any queue with a producer but no consumer, or vice versa.
- `domain-events.md`. `shared/src/events/` domain event bus: what events are emitted, who subscribes, whether this is fire-and-forget or guaranteed delivery. Determine if this is a real event-driven system or an in-process observer.

**Relevant files:** `shared/src/queue/`, `shared/src/events/`, `services/ledger/src/workers/normalizeWorker.ts`, `services/execution/src/outbox/worker.ts`, `services/agent-router/src/worker.ts`.
