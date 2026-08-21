FROM python:3.12-slim

WORKDIR /app

# Apply Debian security updates that may land after the base image was built.
RUN apt-get update \
  && apt-get upgrade -y \
  && rm -rf /var/lib/apt/lists/*

# Install uv for deterministic dependency installs. Pinned to the same
# 0.4.x release CI uses (.github/workflows/main.yml python_agents job,
# astral-sh/setup-uv version: "0.4.x"), by digest so the tag cannot move
# under us.
COPY --from=ghcr.io/astral-sh/uv:0.4.30@sha256:341e448d2ca38f11d8e2768db5464b4c95a4d87f539b8cb7511db86b02fef97e /uv /usr/local/bin/uv

# Copy dependency manifests first for layer caching.
COPY pyproject.toml uv.lock README.md ./
# ponytail: drop uv from the final layer contents once it has done its job,
# so it cannot be invoked at runtime. This is a single-stage image, so the
# COPY layer bytes above still live in image history; a multi-stage build
# would be needed to shrink the image itself.
RUN uv sync --no-dev --frozen && rm -f /usr/local/bin/uv

# Copy source.
COPY brain_agents/ ./brain_agents/

ENV PATH="/app/.venv/bin:$PATH"

# Non-root runtime user, matching the core image (Dockerfile: USER node).
RUN groupadd -r brain && useradd -r -g brain brain
USER brain

EXPOSE 8001

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=10 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8001/health', timeout=5)" || exit 1

CMD ["uvicorn", "brain_agents.server:app", "--host", "0.0.0.0", "--port", "8001"]
