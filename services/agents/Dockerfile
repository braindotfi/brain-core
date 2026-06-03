FROM python:3.12-slim

WORKDIR /app

# curl backs the container healthcheck (docker-compose.*.yml probes /health with
# it). The slim base omits it, so the healthcheck would otherwise always fail and
# the service would never report healthy to dependents.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

# Install uv for deterministic dependency installs.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy dependency manifests first for layer caching.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --no-dev --frozen

# Copy source.
COPY brain_agents/ ./brain_agents/

ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8001

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=10 \
  CMD curl -fsS http://localhost:8001/health || exit 1

CMD ["uvicorn", "brain_agents.server:app", "--host", "0.0.0.0", "--port", "8001"]
