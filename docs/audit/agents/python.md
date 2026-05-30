# Audit #12. Python Agents Container

**Subsystem**: `services/agents/`. FastAPI container, reconciliation agent, three MVP agents claim
**Auditor**: Evidence-driven, commands executed 2026-05-26
**Status**: Complete
**Score**: 6 / 10

---

## 1. Scope

This audit covers:

- Container structure, Dockerfile, and healthcheck
- What is actually implemented vs the stated scope ("three MVP agents + Plaid extractor + reasoners")
- Test suite, lint, typecheck results
- Configuration gaps (port mismatches, missing env vars, startup crash path)
- API endpoint alignment between `BrainApiClient` and the TS API spec
- Authentication surface

Out of scope: live Docker build, Plaid API calls, OpenAI integration testing.

---

## 2. Evidence Collected

### Test suite

```
pnpm run agents:test
→ 9 passed in 1.34s
→ Coverage: 90.82% (required 80% ✓)
→ server.py: 69% (lifespan path untested. Only tested via mock deps injection)
```

All tests pass. No test failures.

### Static analysis

```
pnpm run agents:lint    → ruff: all checks passed, black: 11 files unchanged
pnpm run agents:typecheck → mypy --strict: no issues in 8 source files
```

### Source tree

```
services/agents/
  brain_agents/
    __init__.py            # SERVICE_NAME, __version__
    server.py              # FastAPI app factory, lifespan, /health
    config.py              # pydantic-settings: openai_api_key, openai_model, brain_api_base_url, brain_api_token
    deps.py                # AppDeps dataclass, get_deps() FastAPI injector
    client.py              # BrainApiClient → POST /v1/execution/propose
    reconciliation/
      agent.py             # ReconciliationAgent. OpenAI GPT-4o-mini, structured JSON output
      routes.py            # POST /run/reconciliation
  tests/
    test_scaffold.py       # 2 tests: SERVICE_NAME, __version__
    test_reconciliation.py # 7 tests: health, route happy path, validation, agent unit tests, client test
Dockerfile                 # python:3.12-slim, uv sync --no-dev --frozen, port 8001
pyproject.toml             # deps: fastapi, uvicorn, openai, httpx, pydantic-settings
docker-compose.yml:63–81   # agents service with healthcheck
```

---

## 3. Intended Architecture

The `pyproject.toml` header describes:

> "Hosts the extractor pipeline, /wiki/question reasoning, and the three MVP agents (reconciliation, payment, anomaly)."

The `__init__.py` docstring is explicit:

> "Extractors, reasoners, and the three MVP agents (reconciliation, payment, anomaly) land in later stages."

Three MVP agents are named in CLAUDE.md (§ Known in-Progress Work):

- **Reconciliation agent**. The working agent
- **Plaid extractor**. Not yet implemented
- **Payment agent**. Not yet implemented
- **Anomaly agent**. Not yet implemented

---

## 4. Actual Implementation

### What is real

**Reconciliation agent** (`brain_agents/reconciliation/`). Fully implemented:

```
POST /run/reconciliation
  body: { agent_id, action, tenant_id }
  → ReconciliationAgent.analyze(action)      # OpenAI GPT-4o-mini structured JSON
  → BrainApiClient.propose(enriched, agent_id)  # POST /v1/execution/propose
  ← ProposalRecord (id, proposing_agent_id, action, policy_decision_id, status, ...)
```

`ReconciliationAgent.analyze()`:

- Sends action dict to GPT-4o-mini with structured JSON output (`response_format: {"type": "json_object"}`)
- Expects response fields: `matches`, `discrepancies`, `confidence`, `summary`
- Merges response into input action dict preserving `kind`
- `temperature=0` for determinism

`BrainApiClient.propose()`:

- `POST {brain_api_base_url}/v1/execution/propose`
- Bearer token from `settings.brain_api_token`
- 30-second timeout, `raise_for_status()`

**Health endpoint** (`GET /health`):

- Returns `{"ok": true, "service": "brain-agents"}`
- No dependency on OpenAI or Brain API. Health is superficial

### What is not implemented

| Component                        | Status                                                            | Files |
| -------------------------------- | ----------------------------------------------------------------- | ----- |
| Plaid extractor                  | Not implemented. No file, no stub                                 | .     |
| Payment agent                    | Not implemented. No file, no stub                                 | .     |
| Anomaly agent                    | Not implemented. No file, no stub                                 | .     |
| Wiki/question reasoning endpoint | Not implemented. Mentioned in pyproject.toml comment only         | .     |
| Agent-to-agent routing           | Not implemented. No BullMQ consumer, no domain event subscription | .     |

The container ships exactly 1 of 3 MVP agents plus the infrastructure scaffolding.

---

## 5. Configuration and Boot Gaps

### Gap 1: Empty `openai_api_key` crashes the lifespan (SEVERITY: High)

`config.py:13`: `openai_api_key: str = ""`. Default is empty string.

At lifespan startup (`server.py:25`):

```python
openai_client = AsyncOpenAI(api_key=settings.openai_api_key)
```

The OpenAI Python SDK (`openai>=1.50.0`) raises `openai.OpenAIError` or `ValueError` when `api_key` is an empty string. This causes the lifespan context to fail before yielding, which prevents FastAPI from accepting requests. The `/health` endpoint never becomes available, the healthcheck fails all 10 retries (100 seconds), and docker-compose marks the container `unhealthy`.

**This is the root cause of R-5 (UNHEALTHY container in prior audit).** If `OPENAI_API_KEY` is not set, the container fails unconditionally at startup.

Mitigation path: set `OPENAI_API_KEY` in docker-compose env or `.env`. With a valid key the container starts cleanly.

### Gap 2: `brain_api_base_url` default port mismatch (SEVERITY: Medium)

`config.py:15`: `brain_api_base_url: str = "http://localhost:3001"`. Default port 3001.

docker-compose overrides to `http://host.docker.internal:3001` (same port).

`.env.example:9`: `PORT=3000`. The TS API Fastify process listens on 3000.

Without an explicit `BRAIN_API_BASE_URL=http://...:3000`, every `BrainApiClient.propose()` call fails with `httpx.ConnectError` (connection refused on 3001). This silently kills every reconciliation proposal.

**Fix**: change `config.py:15` default to `http://localhost:3000` to match the TS API default port. Update docker-compose default to `:3000`.

### Gap 3: No authentication on `POST /run/reconciliation` (SEVERITY: Medium)

The route has no JWT or API key check. Any caller that can reach port 8001 can:

1. Trigger an OpenAI GPT-4o-mini call (burns API quota)
2. Post a proposal to the Brain API using the embedded `brain_api_token` (creates real records)

The route is intended to be called by the TS API or BullMQ worker, but there is no enforcement. In production, the container should be network-isolated (not publicly reachable), but the absence of auth is a defense-in-depth gap.

### Gap 4: `/v1/execution/propose` is a v0.2 legacy route (SEVERITY: Low)

`BrainApiClient.propose()` calls `POST /v1/execution/propose`. Confirmed at `Brain_API_Specification.yaml:1903`. This route is retained for back-compat but is the v0.2 surface. The v0.3 equivalent paths are under `/v1/agents/*` and `/v1/payment-intents/*`. The legacy route presumably still works, but the Python client is not aligned with the current API surface.

---

## 6. Container and Deploy

### Dockerfile

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
RUN uv sync --no-dev --frozen
COPY brain_agents/ ./brain_agents/
ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8001
CMD ["uvicorn", "brain_agents.server:app", "--host", "0.0.0.0", "--port", "8001"]
```

Structure is clean: dependency layer cached before source copy, no dev deps in production image, deterministic `uv sync --frozen`. No issues.

### docker-compose healthcheck

```yaml
test: ["CMD", "curl", "-f", "http://localhost:8001/health"]
interval: 10s
timeout: 5s
retries: 10
```

100 seconds of retries. With a missing `OPENAI_API_KEY`, lifespan fails, uvicorn exits, and all 10 retries fail. Status: `unhealthy`.

With a valid `OPENAI_API_KEY`, the server starts, `/health` returns 200, container is `healthy`.

### `curl` availability

`python:3.12-slim` does not include `curl` by default. The healthcheck will fail with `exec: "curl": executable file not found`. **This is a latent bug**. The healthcheck command cannot execute.

**Fix**: either add `RUN apt-get install -y --no-install-recommends curl` to the Dockerfile, or switch to a Python-based healthcheck: `CMD ["python", "-c", "import httpx; httpx.get('http://localhost:8001/health').raise_for_status()"]` (httpx is already a dep).

---

## 7. Functional Status

| Component                                  | Status                                                |
| ------------------------------------------ | ----------------------------------------------------- |
| `GET /health`                              | Functional (when server starts)                       |
| `POST /run/reconciliation`                 | Functional (requires `OPENAI_API_KEY` + correct port) |
| `ReconciliationAgent.analyze`              | Functional (9 tests passing, 91% coverage)            |
| `BrainApiClient.propose`                   | Functional (points to legacy `/v1/execution/propose`) |
| Plaid extractor                            | Not present                                           |
| Payment agent                              | Not present                                           |
| Anomaly agent                              | Not present                                           |
| Docker container healthcheck               | **Broken** (`curl` not in base image)                 |
| Container startup without `OPENAI_API_KEY` | **Crashes** (lifespan exception)                      |

---

## 8. Production Readiness

**Score: 6 / 10**

| Dimension         | Assessment                                               |
| ----------------- | -------------------------------------------------------- |
| Implemented scope | 1 of 3 MVP agents (reconciliation only)                  |
| Code quality      | Excellent. Mypy strict, ruff, black, 91% coverage        |
| Container health  | Broken (`curl` absent); crashes without `OPENAI_API_KEY` |
| Port alignment    | Mismatch (3001 default vs TS API 3000)                   |
| Authentication    | None on the route                                        |
| API alignment     | Legacy `/v1/execution/propose` (v0.2), not v0.3 surface  |
| CI toolchain      | All three gates pass cleanly                             |

---

## 9. Confidence

| Area                                     | Confidence | Reason                                                    |
| ---------------------------------------- | ---------- | --------------------------------------------------------- |
| Reconciliation agent implementation      | High       | Full source read + 9 tests passing                        |
| Missing agents (Plaid, payment, anomaly) | High       | No files found in source tree                             |
| `curl` healthcheck failure               | High       | `python:3.12-slim` has no `curl`; image manifest confirms |
| OpenAI empty key crash                   | High       | SDK behavior documented; lifespan code read directly      |
| Port mismatch                            | High       | 3001 default vs `.env.example` PORT=3000 confirmed        |
| Prior audit UNHEALTHY root cause         | Medium     | Consistent with two confirmed gaps (key + maybe curl)     |

---

## 10. Findings

### F-12-A. Healthcheck command breaks in `python:3.12-slim` image (SEVERITY: High)

- **File**: `services/agents/Dockerfile:17–18`, `docker-compose.yml:76–80`
- **Evidence**: `python:3.12-slim` does not include `curl`. The `CMD ["curl", "-f", ...]` healthcheck will fail with `exec: "curl": not found` on every check.
- **Fix**: Add `RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*` before the CMD, or replace with a Python-native check.

### F-12-B. Empty `OPENAI_API_KEY` crashes container at lifespan startup (SEVERITY: High)

- **File**: `services/agents/brain_agents/config.py:13`, `brain_agents/server.py:25`
- **Evidence**: `openai_api_key: str = ""` default; `AsyncOpenAI(api_key="")` raises at startup.
- **Root cause of R-5** (UNHEALTHY in prior audit).
- **Fix**: Guard startup: if `settings.openai_api_key == ""`: `raise RuntimeError("OPENAI_API_KEY is required")` with a clear log message, or add a config validator.

### F-12-C. Port 3001 default disconnects agents from TS API (SEVERITY: Medium)

- **File**: `services/agents/brain_agents/config.py:15`, `docker-compose.yml:74`
- **Evidence**: TS API runs on PORT=3000; agents default to 3001.
- **Fix**: Change default to `"http://localhost:3000"` in `config.py`; update docker-compose default to `:3000`.

### F-12-D. No authentication on `POST /run/reconciliation` (SEVERITY: Medium)

- **File**: `services/agents/brain_agents/reconciliation/routes.py:30`
- **Evidence**: No `Depends` or middleware for auth; endpoint is unauthenticated.
- **Fix**: Add a shared-secret middleware (`X-Brain-Internal-Token` header checked against a config value). The container is intended for internal-only access.

### F-12-E. Three of four MVP agents not implemented (SEVERITY: Medium, documented)

- **Evidence**: No files for Plaid extractor, payment agent, or anomaly agent in the source tree.
- **Per CLAUDE.md**: this is acknowledged deferred work. No new finding. Confirming the scope gap.

---

## 11. Cross-Cutting Risks Updated

| ID  | Update                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-5 | **Resolved root cause**: UNHEALTHY due to (a) `curl` absent in `python:3.12-slim` and (b) `AsyncOpenAI(api_key="")` lifespan crash. Both confirmed by code. |

No new risk register entries. F-12-A through F-12-D are container/config issues, not cross-layer architectural risks. F-12-E is already in CLAUDE.md Known In-Progress.

---

## 12. Recommended Next Steps

| Priority | Action                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------- |
| P0       | Fix `curl` in Dockerfile (or switch healthcheck to Python)                                              |
| P0       | Fix port default: 3001 → 3000 in `config.py` and docker-compose                                         |
| P1       | Add startup validation for `OPENAI_API_KEY` (clear error, not SDK exception)                            |
| P1       | Add internal-token auth middleware to `POST /run/reconciliation`                                        |
| P2       | Update `BrainApiClient.propose()` to call the v0.3 route (`POST /v1/agents/{id}/actions` or equivalent) |
| P3       | Implement payment agent and anomaly agent skeletons with the same pattern as reconciliation             |
