# Audit Area: Agents

**Scope:** Both agent layers. The TypeScript `services/internal-agents/` catalog (19 handler stubs) and the Python `services/agents/` container. Determines whether autonomy is real, simulated, or scaffolded.

**Reports planned:**

- `internal-agents.md`. The 19 TS internal-agent handlers: are they real agents (LLM, planning, memory, tools) or 16–39 LOC routing functions? Handler wiring, capability manifests, actual invocation paths from agent-router. Classification per handler: production-capable / functional-prototype / scaffolded / stubbed.
- `python-agents.md`. Container health (prior audit: UNHEALTHY, likely missing `OPENAI_API_KEY` / wrong `brain_api_base_url`), what `brain_agents/` actually implements (reconciliation agent vs stubs for Plaid extractor, payment agent, anomaly agent), FastAPI routes, real vs aspirational.

**Relevant files:** `services/internal-agents/src/`, `services/agents/`, `services/agents/brain_agents/`, prior audit note: `__init__.py:5` stubs.
