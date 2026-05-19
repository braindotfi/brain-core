# Brain-Agents

Python 3.12 workspace hosting the extractor pipeline, `/wiki/question` reasoner,
and the three MVP agents (reconciliation, payment, anomaly).

See `Brain_MVP_Architecture.md` §3 Layer 4 for the agent inventory and
`Brain_Engineering_Standards.md` §7.2 for the recorded-scenario test harness.

## Local Development

This workspace is managed with [`uv`](https://docs.astral.sh/uv/). Tooling is
configured in `pyproject.toml` (black, ruff, mypy --strict, pytest with 80%
coverage gate).

```bash
# From this directory:
uv sync --extra dev            # install into .venv
uv run ruff check .            # lint
uv run black --check .         # format check
uv run mypy --strict brain_agents  # type-check
uv run pytest                  # unit tests with coverage
```
