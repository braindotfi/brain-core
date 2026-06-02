FROM python:3.12-slim

WORKDIR /app

# Install uv for deterministic dependency installs.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy dependency manifests first for layer caching.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --no-dev --frozen

# Copy source.
COPY brain_agents/ ./brain_agents/

ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8001
CMD ["uvicorn", "brain_agents.server:app", "--host", "0.0.0.0", "--port", "8001"]
