# Audit Area: Integrations

**Scope:** Third-party service integrations. Plaid, Anthropic, OpenAI, S3/Azure Blob, viem/Base RPC. Determines which integrations are real, which are stubbed, and which have live-vs-test-mode gaps.

**Reports planned:**
- `external-integrations.md`. For each integration:
  - **Plaid** (`plaid@^42` in api, `plaid@^27` in raw. 15-major-version skew): `AchPlaidRail` implementation status, encrypted credential store (AES-256-GCM, new `shared/src/crypto/aes-gcm.ts`), Plaid sandbox round-trip status (CLAUDE.md: "integration verification remaining follow-up").
  - **Anthropic / OpenAI** (wiki LLM Q&A, Python agents): real call paths vs mock-only.
  - **S3 / Azure Blob** (artifact storage): `@aws-sdk/client-s3` + LocalStack local, Azure in prod. `BlobAdapter` abstraction, local dev parity.
  - **viem / Base RPC** (`OnchainBaseRail`, `BrainAuditAnchor` publisher): real implementations, live wiring status (CLAUDE.md: "integration verification remaining follow-up").
  - **OTLP / StatsD** (observability): wired at boot in main.ts, whether real telemetry flows in any environment.

**Relevant files:** `services/api/src/rails/`, `shared/src/crypto/aes-gcm.ts`, `shared/src/blob/`, `shared/src/llm/`, `services/api/src/anchorBroadcaster.ts`, `BLOCKERS.md`.
