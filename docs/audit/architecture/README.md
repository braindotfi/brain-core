# Audit Area: Architecture

**Scope:** Does the six-layer architecture claimed in `Brain_MVP_Architecture.md` and `protocol/the-six-layer-stack.md` exist in practice, or only in documentation and folder names?

**Reports planned:**
- `six-layer-reality.md`. Layer-by-layer validation: responsibilities, runtime isolation, dependency rules, violations, coupling, enforcement quality. Determines whether each layer is meaningfully isolated, bypassed, duplicated, or purely structural.

**Out of scope here:** Per-service implementation correctness (see `services/`), SDK surface (see `sdk/`), security boundaries (see `security/`).

**Relevant workspaces:** All 11 TS workspaces + `scripts/check-*.mjs` invariant lints.
