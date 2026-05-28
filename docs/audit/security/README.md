# Audit Area: Security

**Scope:** Auth enforcement, RLS role model, secret handling, crypto implementations, and adversarial test reality.

**Reports planned:**
- `auth-rls-crypto-secrets.md` — JWT Bearer chain (15-min access + rotating refresh), SIWX (Sign-In With X), MCP auth (JWT → agent active → on-chain scope-hash), RLS role model (`brain_app` NOBYPASSRLS vs `brain_privileged` BYPASSRLS — only applied when `infra/db-roles.sql` is run in the actual DB), AES-256-GCM credential encryption (`shared/src/crypto/aes-gcm.ts`, env vars `BRAIN_SOURCE_CREDENTIAL_KEY` + `BRAIN_SOURCE_CREDENTIAL_KEY_ID`), CSP + security headers (P1.4), `SECURITY.md` review, adversarial safety suite (`tests/adversarial/` — 10 logic tests + integration CI-only), `tests/adversarial/src/adversarial.test.ts` coverage of attack vectors.

**Relevant files:** `SECURITY.md`, `shared/src/auth/`, `shared/src/crypto/`, `infra/db-roles.sql`, `services/api/src/security-headers.ts`, `tests/adversarial/`.
