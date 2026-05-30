# Audit Area: Technical Debt

**Scope:** Systematic enumeration of incomplete implementations, fake abstractions, dead code, misleading naming, and deferred work items that pose future risk.

**Reports planned:**

- `findings.md`. Roll-up of technical debt surfaced across all subsystem audits. Categorized by: incomplete implementations (stubs, TODOs in critical paths), fake abstractions (interfaces with no implementations, plugin systems nobody uses), dead code (unconsumed exports, unused queue producers), misleading naming (directories that suggest services but are libraries, Dockerfiles that can't run standalone), and deferred architectural work (per-service deployment, real Plaid/on-chain rail live wiring, Python agent stubs, npm SDK publication). Each item rated: impact level, effort to resolve, whether it's a production blocker.

**Note:** This file is written last, synthesizing findings from all other areas. Do not populate until the per-subsystem audits are complete.

**Seed items (from prior audit + new findings):**

- `services/agent-router` and `services/internal-agents` have no standalone process but are presented as services.
- Per-service Dockerfiles have `CMD ["node", "services/audit/dist/main.js"]` pointing to a non-existent standalone entrypoint.
- Plaid `^27` / `^42` version skew between `services/raw` and `services/api`.
- Root `tsconfig.json` omits `services/agent-router` and `services/internal-agents` from the project reference graph.
- Outbound webhook retries: still fire-and-forget (no retry queue yet).
- `@brain/sdk` not published to npm.
- Python agents: Plaid extractor, payment agent, anomaly agent not implemented.
