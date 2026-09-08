# Brain-Agents

Python 3.12 workspace hosting the extractor pipeline, `/wiki/question` reasoner,
and the three MVP agents (reconciliation, payment, anomaly).

See `Brain_MVP_Architecture.md` §3 Layer 4 for the agent inventory and
`Brain_Engineering_Standards.md` §7.2 for the recorded-scenario test harness.

## Local Development

This workspace is managed with [`uv`](https://docs.astral.sh/uv/). Tooling is
configured in `pyproject.toml` (black, ruff, mypy --strict, pytest with 80%
coverage gate).

## Outbound Brain API authentication

Production accepts one outbound credential mode at a time. The current Phase 2
deployment remains on `BRAIN_API_TOKEN`. The staged replacement uses:

```text
BRAIN_AGENT_API_KEY=brain_ak_test_...
BRAIN_AUTH_TOKEN_URL=https://auth.example/token
BRAIN_API_RESOURCE_URL=https://api.example/
```

Agent-key mode performs RFC 8693 exchange before startup completes, keeps the
five-minute access token in memory, refreshes it 60 seconds early, coalesces
concurrent refreshes, and retries one request after a 401. It never sends the
durable agent key to a Brain API resource route. Do not configure both the agent
key and `BRAIN_API_TOKEN`.

```bash
# From this directory:
uv sync --extra dev            # install into .venv
uv run ruff check .            # lint
uv run black --check .         # format check
uv run mypy --strict brain_agents  # type-check
uv run pytest                  # unit tests with coverage
```

## Document OCR

`document_extractor` keeps deterministic text extraction first for CSV, plain
text, XLSX, and text-layer PDFs. Image uploads and PDFs with no text layer fall
back to the OpenAI vision model configured by `OPENAI_OCR_MODEL` (default
`gpt-4o`). OCR output is model-generated text, so the route caps the resulting
Raw parsed confidence at `0.5` and still routes through the same advisory
projection path.
