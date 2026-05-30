# Audit Area: Orchestration

**Scope:** The agent routing pipeline (`services/agent-router/`), durable execution (sagas, outbox), and the internal-agent dispatch chain. Are these real orchestration systems or routing skeletons?

**Reports planned:**

- `agent-router-and-routing-pipeline.md`. `services/agent-router/src/`: BullMQ routing worker, `registerAgentRouterRoutes`, decision-recording in execution tables, capability-manifest matching. Determines if this is real orchestration or a routing proxy.
- `sagas-and-outbox.md`. `services/execution/src/sagas.ts` (saga executor with compensation), `services/execution/src/outbox/worker.ts` (durable outbox rail dispatcher), invoiceShortcut resolver (`invoice-shortcut.ts`). Validates persistence, replay, and failure recovery.

**Note:** `services/agent-router` and `services/internal-agents` have no standalone process or Dockerfile. They are libraries composed into the single API process via `createAgentRouteWorker` in `services/api/src/main.ts`.

**Relevant files:** `services/agent-router/src/`, `services/execution/src/sagas.ts`, `services/execution/src/outbox/`, `services/execution/src/payment-intents/invoice-shortcut.ts`.
