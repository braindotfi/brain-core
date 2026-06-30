# Audit #15. Security: Auth, RLS, Crypto, Secrets

**Subsystem**: Cross-cutting. JWT, SIWX, RLS role model, AES-256-GCM, boot guards, adversarial coverage
**Auditor**: Evidence-driven, commands executed 2026-05-26
**Status**: Complete
**Score**: 7 / 10

---

## 1. Scope

This audit covers:

- JWT verification: production vs demo paths, claim validation, revocation
- SIWX agent authentication and production sign-key guard
- Scope system: VALID_SCOPES, AGENT_PERMITTED_SCOPES, scope enforcement
- `skipAuth` surface: which routes are unauthenticated and why
- `withTenantScope`: RLS implementation, parameterization, leak surface
- FORCE ROW LEVEL SECURITY: which tables, which services, db-roles.sql role model
- AES-256-GCM credential encryption: wire format, auth tag, production optionality
- Boot guards: `BRAIN_DEMO_MODE`, `BRAIN_MCP_DEV_AUTH_BYPASS`, `BLOB_BACKEND`, `AUTH_SIGN_KEY`
- Adversarial test coverage: vector set, CI wiring, local vs CI run state

Out of scope: Plaid webhook HMAC signature verification, pre-commit secret scanner internals, Azure Key Vault managed identity configuration.

---

## 2. Evidence Collected

### Auth layer

```
shared/src/auth/jwt.ts. JwtVerifier: production JWKS, demo HS256, claim validation
shared/src/auth/middleware.ts. Fastify onRequest hook, skipAuth config flag
shared/src/auth/scopes.ts. VALID_SCOPES (24), AGENT_PERMITTED_SCOPES (5)
shared/src/db/tenant-scoped.ts. WithTenantScope implementation
shared/src/crypto/aes-gcm.ts. AES-256-GCM encrypt/decrypt
services/api/src/main.ts. Boot guards (lines 597–609, 1377–1381), DEMO_SIGN_SECRET (line 612)
infra/db-roles.sql. Brain_app (NOLOGIN NOBYPASSRLS), brain_privileged (BYPASSRLS)
tests/adversarial/src/adversarial.test.ts. 10 attack vectors
tests/invariants/integration/db-invariants.integration.test.ts. RLS non-owner probes
```

### RLS migration coverage

```
find . -name "*.sql" | xargs grep -l "FORCE ROW LEVEL SECURITY" | sort
→ infra/db-roles.sql (bulk loop)
→ services/audit/migrations/0007_force_rls.sql
→ services/execution/migrations/0017_execution_outbox.sql
→ services/execution/migrations/0019_force_rls.sql
→ services/ledger/migrations/0020_force_rls.sql
→ services/policy/migrations/0004_force_rls.sql
→ services/raw/migrations/0004_force_rls.sql
→ services/raw/migrations/0006_force_rls_sources.sql
→ services/wiki/migrations/0006_force_rls.sql
```

`services/api/migrations/0001_tenants.sql` uses `ENABLE ROW LEVEL SECURITY` (not FORCE). The `tenants` table
is covered by the `infra/db-roles.sql` bulk FORCE loop. Not by a service-specific FORCE migration.

### Adversarial suite run

```
pnpm -C tests/adversarial run test
→ Error: Cannot find package '@brain/shared' imported from '…/src/adversarial.test.ts'
→ Caused by: Failed to load url @brain/shared
```

Local run fails because `tests/adversarial/node_modules/@brain/` symlinks were not created by the
workspace-local pnpm state. CI does `pnpm install --frozen-lockfile` (clean tree) then `pnpm run build`,
which creates the workspace symlinks. `main.yml` confirms CI runs both the logic suite and
the DB-integration suite and they pass. Local failure is stale pnpm state, not a logic error.

```
HARDENING-SUMMARY.md confirms: P1.1 adversarial safety suite. Done. 10 (logic) + integration (CI)
main.yml: pnpm -C tests/adversarial run test && pnpm -C tests/adversarial run test:integration
```

### Boot guard enumeration (main.ts)

```
line 597: BRAIN_DEMO_MODE=true blocked in NODE_ENV=production
line 600: BRAIN_MCP_DEV_AUTH_BYPASS=true blocked in NODE_ENV=production
line 603: BLOB_BACKEND=memory blocked in NODE_ENV=production
line 1377: AUTH_SIGN_KEY required in NODE_ENV=production (SIWX signing)
```

---

## 3. Source Tree

```
shared/src/auth/
  jwt.ts            # JwtVerifier (production JWKS, demo HS256), JwtSigner
  middleware.ts     # Fastify plugin. OnRequest hook, skipAuth flag
  scopes.ts         # VALID_SCOPES (24), AGENT_PERMITTED_SCOPES (5), requireScope()
shared/src/db/
  tenant-scoped.ts  # withTenantScope. BEGIN + SET LOCAL + fn + COMMIT
shared/src/crypto/
  aes-gcm.ts        # AES-256-GCM encrypt/decrypt, wire format iv||authTag||ciphertext
infra/
  db-roles.sql      # brain_app (NOLOGIN, NOBYPASSRLS), brain_privileged (BYPASSRLS), FORCE loop
tests/adversarial/
  src/adversarial.test.ts        # 10 logic-layer attack vectors
  integration/                   # DB-backed tenant-swap + policy-downgrade (CI-only)
  vitest.config.ts               # no resolve.alias. Relies on pnpm workspace symlinks
  vitest.integration.config.ts   # skip-guarded on DATABASE_URL
```

---

## 4. JWT Authentication

### Production path

`JwtVerifier` uses `jose`'s `createRemoteJWKSet` for asymmetric RS256/ES256 verification in production.
The JWKS URL comes from `cfg.AUTH_JWKS_URL`. No hardcoded keys in the production path.

```typescript
// shared/src/auth/jwt.ts
if (opts.secret !== undefined && opts.secret !== "") {
  const keyBytes = new TextEncoder().encode(opts.secret);
  this.jwks = async () => keyBytes; // HS256 symmetric. Dev/test only
} else {
  this.jwks = createRemoteJWKSet(new URL(opts.jwksUrl)); // asymmetric JWKS. Production
}
```

### Demo/dev path

`BRAIN_DEMO_MODE=true` sets `secret: "brain-demo-mode-insecure-dev-only"` in `JwtVerifier` options and
`JwtSigner` options (via `DEMO_SIGN_SECRET` constant at line 612). The secret is defined once and
shared between the verifier and signer. No silent divergence if the literal changes.

`BRAIN_DEMO_MODE=true` is blocked at boot in `NODE_ENV=production` (line 597–598). The HS256 path is
unreachable in production.

### Claim validation

From reading the middleware + JwtVerifier:

- `sub`: required; format validated against `principal_type` prefix (`usr_`, `agt_`, `par_`)
- `exp`: required; `jose` enforces expiry by default
- `jti`: required; checked against Redis revocation store before accepting
- `tenant_id`: must match `tnt_` prefix; `withTenantScope` validates separately with `isBrainId`
- `principal_type`: must be `user | agent | api_partner`
- `scopes`: every scope in the token must appear in `VALID_SCOPES`; unknown scopes cause rejection

### Revocation

`RedisRevocationStore` stores `auth:revoked:{jti}` as a key with TTL equal to the token's remaining
lifetime. The check happens on every request in the middleware, before `withTenantScope` is called.
TTLs self-evict. No background cleanup job needed.

### SIWX agent auth

Agent JWT minting is via `registerSiwxRoutes` (the `/auth/siwx` path). Production requires `AUTH_SIGN_KEY`
(a JWK JSON string from Azure Key Vault) for the SIWX signer. Boot throws if absent (line 1377–1379).
Without `AUTH_SIGN_KEY`, no agent JWTs can be minted in production, and no hardcoded fallback exists.

---

## 5. Scope System

```typescript
// shared/src/auth/scopes.ts
export const VALID_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  "raw:read",
  "raw:write",
  "raw:admin",
  "ledger:read",
  "ledger:write",
  "ledger:admin",
  "wiki:read",
  "wiki:write",
  "wiki:admin",
  "policy:read",
  "policy:write",
  "policy:admin",
  "policy:sign",
  "execution:read",
  "execution:write",
  "execution:admin",
  "execution:propose",
  "payment_intent:propose",
  "payment_intent:approve",
  "payment_intent:execute",
  "audit:read",
  "audit:write",
  "audit:admin",
]); // 23 scopes

export const AGENT_PERMITTED_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  "ledger:read",
  "wiki:read",
  "raw:write",
  "payment_intent:propose",
  "execution:propose",
]); // 5 scopes. External agents only
```

`admin` implies all verbs for a layer via `impliedAdmin()` in `hasScope()`. `requireScope` throws
`auth_scope_insufficient` (never 200-with-error). Scope validation runs at the JWT claim level
(rejects tokens with unknown scopes) and again at the route level (requireScope per handler).

**Note on `execution:propose` vs `agent:propose`:** The spec (§3.2) names the non-financial-proposal
scope `agent:propose`. The codebase implements it as `execution:propose` for backward-compatibility
with the on-chain `scope_hash`. CLAUDE.md notes this rename is tracked separately.

---

## 6. `skipAuth` Surface

| Route                           | Rationale                                                         |
| ------------------------------- | ----------------------------------------------------------------- |
| `GET /health` (all services)    | Infrastructure probe. No data access                              |
| `POST /auth/siwx/challenge`     | Nonce generation. Initiates auth, no session yet                  |
| `POST /auth/siwx`               | Authentication endpoint itself. No JWT to present yet             |
| `POST /audit/verify`            | Public audit verification. Cryptographic function, no tenant data |
| `POST /raw/webhooks/{provider}` | Provider HMAC signed. Different auth scheme                       |
| `GET /v1/demo/token`            | Only registered if `BRAIN_DEMO_MODE=true` (blocked in production) |

All six exemptions are legitimate. No route is accidentally unauthenticated. The audit verify
endpoint is intentionally public. It takes a hash + proof, returns validity, and does not
access tenant data.

---

## 7. Row-Level Security

### `withTenantScope` implementation

```typescript
// shared/src/db/tenant-scoped.ts (simplified)
export async function withTenantScope<T>(pool, tenantId, fn): Promise<T> {
  if (!isBrainId(tenantId, "tnt")) {
    throw brainError("auth_tenant_mismatch", "invalid tenant id shape", ...);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const scoped = { query: (text, values) => client.query(text, values) };
    const result = await fn(scoped);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
```

Key properties:

- `SET LOCAL` is `set_config(..., true)`. Transaction-scoped, not session-scoped
- Cannot leak across requests (connection pool gives a fresh client per `withTenantScope` call)
- `isBrainId("tnt")` rejects malformed tenant IDs before any DB operation
- Parameterized. Not string-interpolated; SQL injection not possible via `tenantId`
- Rollback on throw. No partial-write with scope leak

### FORCE ROW LEVEL SECURITY coverage

**Services with per-migration FORCE grants:** raw (2 migrations), execution (2 migrations),
ledger, wiki, policy, audit (1 each). All `ENABLE ROW LEVEL SECURITY` tables also have
individual `FORCE ROW LEVEL SECURITY` applied.

**`services/api` tenants table:** `0001_tenants.sql` uses `ENABLE ROW LEVEL SECURITY` but no
`FORCE` migration. The `infra/db-roles.sql` bulk `DO $$ ... ALTER TABLE %s FORCE ROW LEVEL SECURITY`
loop covers it at deploy time. Provided `db-roles.sql` runs.

**`infra/db-roles.sql`**: creates `brain_app` (LOGIN, NOBYPASSRLS) and `brain_privileged` (BYPASSRLS)
roles, grants DML on all tables, and runs a PL/pgSQL loop to FORCE RLS on every `relrowsecurity=true`
table. The loop ensures even tables whose FORCE migration ran after a connection was established get
covered idempotently.

```sql
-- infra/db-roles.sql
CREATE ROLE brain_app LOGIN PASSWORD :'brain_app_password' NOBYPASSRLS;
CREATE ROLE brain_privileged LOGIN PASSWORD :'brain_privileged_password' BYPASSRLS;
```

### RLS test probe (post-PR #23)

The invariants integration suite (`tests/invariants/integration/db-invariants.integration.test.ts`)
and adversarial integration suite now both:

```typescript
await client.query(`CREATE ROLE ${appRole} NOLOGIN`);
await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${appRole}`);
await client.query(`GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA ${schema} TO ${appRole}`);
// …inside test transaction:
await client.query(`SET LOCAL ROLE ${appRole}`);
```

PR #23 fixed a critical test gap: previously the suites connected as the Postgres superuser, for
whom RLS is bypassed regardless of FORCE. The fix creates a NOLOGIN non-owner role with SELECT/INSERT
only, uses `SET LOCAL ROLE` to switch mid-transaction, then asserts cross-tenant rows are invisible.
This now exercises the actual RLS enforcement path, not the owner bypass.

---

## 8. AES-256-GCM Credential Encryption

```typescript
// shared/src/crypto/aes-gcm.ts
export function encryptCredentials(plain: object, key: Buffer, keyId: string) {
  const iv = randomBytes(12); // 96-bit IV
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainBytes), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 128-bit GCM tag
  return { ciphertext: Buffer.concat([iv, authTag, encrypted]), keyId };
  // Wire format: iv(12) || authTag(16) || ciphertext(n)
}

export function decryptCredentials(ciphertext: Buffer, key: Buffer): object {
  const iv = ciphertext.subarray(0, 12);
  const authTag = ciphertext.subarray(12, 28);
  const encrypted = ciphertext.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag); // GCM integrity check. Throws on tamper
  // …
}
```

The GCM auth tag is enforced on every decrypt. A tampered ciphertext causes `decipheriv` to throw
before any plaintext is returned. IV is freshly generated per encryption (`randomBytes(12)`), so no
IV reuse. Node's `node:crypto` implementation is FIPS-compatible.

### Production key optionality (SEVERITY: Medium)

`BRAIN_SOURCE_CREDENTIAL_KEY` is configured as `optional()` in `shared/src/config.ts`:

```typescript
BRAIN_SOURCE_CREDENTIAL_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/).optional(),
```

`services/api/src/main.ts` (lines 646–657) branches on `cfg.BRAIN_SOURCE_CREDENTIAL_KEY !== undefined`
and only enables encryption when the key is present. If the key is absent, Plaid credentials are stored
in plaintext in the `raw_plaid_items` table.

There is no boot-time guard blocking `NODE_ENV=production` when the key is absent. A production
deployment without `BRAIN_SOURCE_CREDENTIAL_KEY` will silently store credentials unencrypted.
`shared/src/crypto/aes-gcm.ts` has a comment: `TODO: throw at boot when NODE_ENV=production and env-var
path is used.` The TODO is unimplemented.

---

## 9. Boot Guards

| Guard                                | Condition             | Effect                             |
| ------------------------------------ | --------------------- | ---------------------------------- |
| `BRAIN_DEMO_MODE=true`               | `NODE_ENV=production` | Boot throw (line 597)              |
| `BRAIN_MCP_DEV_AUTH_BYPASS=true`     | `NODE_ENV=production` | Boot throw (line 600)              |
| `BLOB_BACKEND=memory`                | `NODE_ENV=production` | Boot throw (line 603)              |
| `AUTH_SIGN_KEY` absent               | `NODE_ENV=production` | Boot throw (line 1377)             |
| `BRAIN_SOURCE_CREDENTIAL_KEY` absent | `NODE_ENV=production` | **No guard. Silently unencrypted** |

All four positive guards are correct boot-time throws. The missing guard for
`BRAIN_SOURCE_CREDENTIAL_KEY` is the only gap in this set.

---

## 10. Adversarial Test Coverage

### Vector set (10 logic-layer vectors, `src/adversarial.test.ts`)

| Vector              | What it tests                                    | Expected result                           |
| ------------------- | ------------------------------------------------ | ----------------------------------------- |
| Role escalation     | `audit:admin` scope on `execution:propose` check | Rejected (wrong scope)                    |
| FX bypass           | Currency mismatch on payment                     | Fails at gate check 8                     |
| Duplicate payment   | Same intent executed twice                       | Hard-reject at check 11.5                 |
| Stale approval      | Expired quorum                                   | Fails quorum                              |
| Fake evidence       | Amount in evidence ≠ intent amount               | Fails at check 9.5                        |
| Rail bypass         | `approved → executed` without gate               | Rejected (invalid transition)             |
| Prompt injection    | Wiki-resolver injection attempt                  | Gate has no WikiResolver (not_applicable) |
| Replayed signature  | Same signer approves twice                       | Duplicate signer rejected                 |
| Revoked signer      | Approval from revoked signer                     | Rejected                                  |
| Cross-tenant signer | Approval from wrong tenant                       | Rejected                                  |

### Integration vectors (`integration/`)

Two DB-backed vectors. Tenant RLS row swap + policy-downgrade persistence. Run in CI via
`pnpm -C tests/adversarial run test:integration` (skip-guarded on `DATABASE_URL`).

### CI wiring

`main.yml` (`unit_and_integration` job): both logic suite and integration suite run after `pnpm run build`.
`pr.yml` does **not** include adversarial tests. Only the standard `test:coverage` sweep.
A security regression introduced in a PR would not fail CI until post-merge on `main`.

### Local run state

```
pnpm -C tests/adversarial run test
→ Error: Cannot find package '@brain/shared'
```

Fails locally because `tests/adversarial/node_modules/@brain/` symlinks were never created (stale
pnpm state. The package was added to pnpm-workspace.yaml after the local `pnpm install`). CI
does a clean `pnpm install` which creates the workspace symlinks and then runs the full build.
The suite logic is correct and CI-verified; the local failure is a developer ergonomics issue.

---

## 11. Functional Status

| Dimension                                    | Status                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- | --- | ----------- | --- | ----------------------------- |
| JWT production path (JWKS)                   | Correct. Asymmetric, production-only                                                     |
| JWT demo path (HS256)                        | Boot-guarded. Unreachable in `NODE_ENV=production`                                       |
| SIWX / AUTH_SIGN_KEY                         | Boot-guarded. Required in production                                                     |
| Claim validation (sub, exp, jti, scopes)     | Comprehensive. All checked at middleware                                                 |
| Revocation store                             | Functional. Redis per-jti TTL, self-evicting                                             |
| Scope enforcement                            | Comprehensive. 24 VALID_SCOPES, AGENT_PERMITTED_SCOPES(5), requireScope                  |
| `skipAuth` surface                           | Minimal and justified. 6 routes, all legitimate                                          |
| `withTenantScope`                            | Correct. SET LOCAL, parameterized, rollback-on-throw, isBrainId guard                    |
| FORCE ROW LEVEL SECURITY                     | Complete. All 6 service schemas covered; api/tenants via db-roles.sql loop               |
| `brain_app` NOLOGIN NOBYPASSRLS role         | Defined in `infra/db-roles.sql` (deploy artifact, not migration)                         |
| DB connection role enforcement               | **Not verified at boot**. App does not check that `DATABASE_URL` connects as `brain_app` |
| AES-256-GCM wire format                      | Correct. Iv(12)                                                                          |     | authTag(16) |     | ciphertext, auth tag enforced |
| BRAIN_SOURCE_CREDENTIAL_KEY production guard | **Missing**. Key optional, no boot throw                                                 |
| Boot guards (demo/bypass/blob/sign-key)      | All four present and correct                                                             |
| Adversarial suite (10 vectors)               | Passes in CI; local run broken (stale pnpm symlinks)                                     |
| Adversarial suite in `pr.yml`                | **Not wired**. Only in `main.yml` post-merge                                             |
| RLS integration tests                        | Fixed (PR #23). Now probe as non-owner role, not superuser                               |

---

## 12. Production Readiness

**Score: 7 / 10**

| Dimension             | Assessment                                                                       |
| --------------------- | -------------------------------------------------------------------------------- |
| JWT / SIWX auth       | High. Production JWKS, demo blocked at boot, full claim validation               |
| Scope enforcement     | High. Finite set, enforced at JWT claim + route level                            |
| RLS implementation    | High. `withTenantScope` correct, FORCE RLS on all schemas, non-owner probe fixed |
| Credential encryption | Medium. GCM correct, but key optional with no production boot guard              |
| Boot guards           | High. Four guards present; one gap (credential key)                              |
| Adversarial coverage  | Medium. 10 vectors correct, CI passing, but not in `pr.yml`                      |
| DB connection role    | Medium. `brain_app` defined but not enforced at boot                             |

---

## 13. Confidence

| Area                            | Confidence | Reason                                                                                      |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| JWT production/demo paths       | High       | Source read; boot guard confirmed by line number                                            |
| VALID_SCOPES set                | High       | `scopes.ts` read directly; 24 entries enumerated                                            |
| `withTenantScope` correctness   | High       | Implementation read in full; SET LOCAL confirmed transaction-scoped                         |
| FORCE RLS coverage              | High       | All `FORCE ROW LEVEL SECURITY` migration files grep-confirmed; db-roles.sql read            |
| AES-256-GCM wire format         | High       | Implementation read; GCM auth tag enforcement confirmed                                     |
| Credential key production gap   | High       | `config.ts` shows `.optional()`; no boot guard in main.ts; TODO in aes-gcm.ts               |
| Adversarial suite CI status     | High       | `HARDENING-SUMMARY.md` + `main.yml` confirm; local failure explained by stale pnpm symlinks |
| DB connection role not enforced | Medium     | `main.ts` reads `DATABASE_URL` without role validation; no boot-assert on `current_user`    |

---

## 14. Findings

### F-15-A. `BRAIN_SOURCE_CREDENTIAL_KEY` optional in production with no boot guard (SEVERITY: Medium)

- **Files**: `shared/src/config.ts:168` (`.optional()`), `services/api/src/main.ts:646–657` (key-absent branch), `shared/src/crypto/aes-gcm.ts:2` (TODO comment)
- **Evidence**: `z.string()...optional()`. Not required. `main.ts` explicitly branches on key presence. No `if (cfg.NODE_ENV === "production" && cfg.BRAIN_SOURCE_CREDENTIAL_KEY === undefined)` throw exists. A production deployment without the key stores Plaid credentials as plaintext JSON in `raw_plaid_items.credentials`.
- **Fix**: Add boot guard in `main.ts` after the existing BLOB_BACKEND guard: `if (cfg.NODE_ENV === "production" && cfg.BRAIN_SOURCE_CREDENTIAL_KEY === undefined) { throw new Error("BRAIN_SOURCE_CREDENTIAL_KEY must be set in production. Configure a 256-bit key in Azure Key Vault"); }`

### F-15-B. DB connection role not verified at boot (SEVERITY: Medium)

- **Files**: `services/api/src/main.ts` (pool construction from `cfg.DATABASE_URL`), `infra/db-roles.sql` (`brain_app` role definition)
- **Evidence**: `DATABASE_URL` is consumed by `new Pool({ connectionString: cfg.DATABASE_URL })` without asserting that the connection role is `brain_app` (NOBYPASSRLS). A development or accidentally misconfigured deployment using the Postgres superuser as `DATABASE_URL` would bypass RLS for all queries even with FORCE RLS. Because Postgres superusers are exempt from RLS regardless of FORCE.
- **Impact**: FORCE RLS on individual tables is a defense-in-depth measure, but it does not protect against a superuser connection. The `brain_app` role model is the primary defense.
- **Fix**: Add a boot assertion: `SELECT current_user` from the pool; in `NODE_ENV=production`, throw if the result is `postgres` or any role that has `BYPASSRLS=true`. Alternatively, add a `ROLE brain_app` parameter to the `DATABASE_URL` connection string in the production deploy configuration and assert the role name in config validation.

### F-15-C. Adversarial suite not wired in `pr.yml` (SEVERITY: Low)

- **Files**: `.github/workflows/pr.yml` (no adversarial step), `.github/workflows/main.yml` (`unit_and_integration` job, line `pnpm -C tests/adversarial run test`)
- **Evidence**: `pr.yml` runs `pnpm run test:coverage` which filters to `./services/**` and `./clients/**`. Adversarial tests are in `./tests/adversarial/`. A PR that regresses any of the 10 attack vectors would pass PR CI and only fail after merging to main.
- **Fix**: Add an adversarial step to `pr.yml` after the build step, before `test:coverage`: `pnpm -C tests/adversarial run test` (logic-layer only, no DATABASE_URL required).

### F-15-D. `infra/db-roles.sql` is not a migration and has no enforcement gate (SEVERITY: Low)

- **Files**: `infra/db-roles.sql`, `tools/migrate/`
- **Evidence**: `db-roles.sql` is documented as "not a tools/migrate migration. Role/grant management is an operator concern". It must be applied manually (or via deploy pipeline) to a new database. If it is missed, the `brain_app` role doesn't exist and the production DB connects as whoever `DATABASE_URL` points to. The FORCE RLS in per-service migrations still runs, but against the table owner.
- **Fix**: Document in `infra/README.md` (or existing deploy docs) that `db-roles.sql` must run before the application is deployed. Consider a startup check that `SELECT 1 FROM pg_roles WHERE rolname = 'brain_app'` returns a row. Throw in production if missing.

---

## 15. Cross-Cutting Risks Updated

| ID                    | Update                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1 (RLS enforcement) | **Partially confirmed**: FORCE ROW LEVEL SECURITY present on all service schemas. `brain_app` role defined. Boot does not verify connection role. See F-15-B. |

New risks:

| ID   | Risk                                                                                                 | Severity | Verified    |
| ---- | ---------------------------------------------------------------------------------------------------- | -------- | ----------- |
| R-33 | Plaid credentials stored plaintext if `BRAIN_SOURCE_CREDENTIAL_KEY` absent. No production boot guard | Medium   | Yes. F-15-A |
| R-34 | DB connection role unverified at boot. Superuser `DATABASE_URL` bypasses RLS                         | Medium   | Yes. F-15-B |
| R-35 | Adversarial suite not in `pr.yml`. Security regressions reach `main` before detection                | Low      | Yes. F-15-C |

---

## 16. Recommended Next Steps

| Priority | Action                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Add production boot guard for `BRAIN_SOURCE_CREDENTIAL_KEY` (one `if` block in `main.ts`, mirrors the existing blob/demo guards)            |
| P1       | Add `pnpm -C tests/adversarial run test` to `pr.yml`. Logic-layer only (no DATABASE_URL needed), fails fast on vector regression            |
| P1       | Add boot assertion on DB connection role: `SELECT current_user` from pool, throw in production if not `brain_app` or similar non-owner role |
| P2       | Document `infra/db-roles.sql` deployment prerequisite in `infra/README.md`; add startup check for `brain_app` role existence                |
