# Grafana dashboards

## `gate.json` — Brain §6 gate

Panels:

1. **Gate outcome rate** — `brain_gate_outcome_count{outcome ∈ ok|fail}` over time.
2. **Per-check outcomes** — `brain_gate_check_count{check, outcome ∈ pass|fail|not_applicable}`.
3. **Gate duration** — p50/p95/p99 derived from `brain_gate_duration_ms`.

The variable `dry_run` filters the live execution path (`false`) from dry-run policy previews (`true`).

### Metric naming — Datadog vs Prometheus

The gate emits via the shared `MetricsEmitter` (DogStatsD / `hot-shots`). Metric names use the Datadog dot convention:

| Datadog                     | Prometheus (via statsd_exporter / equivalent) |
| --------------------------- | --------------------------------------------- |
| `brain.gate.check.count`    | `brain_gate_check_count`                      |
| `brain.gate.outcome.count`  | `brain_gate_outcome_count`                    |
| `brain.gate.duration_ms`    | `brain_gate_duration_ms` (histogram)          |

The dashboard above is written against the Prometheus form (panel queries assume `statsd_exporter` or similar bridges dots to underscores). A Datadog-native dashboard would mirror these panels using the dot-form names.
