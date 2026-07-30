/**
 * GET/POST /login, /set-password, /forgot-password (AUTH-PATHS-PLAN.md
 * section 2, "Path 1"). Server-rendered HTML, no client framework, no
 * bundler, no PKCE/authorize/consent -- that is Phase 2a's OAuth core, not
 * this increment.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  hashPassword,
  verifyPassword,
  withTenantScope,
  isBrainId,
  ID_PREFIX,
  type AuditEmitter,
  type TenantScopedClient,
} from "@brain/shared";
import { newRawToken, sha256Hex, SET_PASSWORD_TOKEN_TTL_MS } from "../token.js";
import type { UserCredentialReader } from "../credentials.js";
import {
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  mintSessionCookie,
  mintCsrfCarrier,
  verifyCsrfCarrier,
  deriveCsrfToken,
  verifyCsrfToken,
  serializeHostCookie,
  clearHostCookie,
  parseCookies,
} from "../session.js";
import {
  renderLoginPage,
  renderSignedInPage,
  renderSetPasswordPage,
  renderSetPasswordInvalidPage,
  renderForgotPasswordPage,
} from "../html.js";
import { resumePendingAuthorization } from "./oauth.js";

/**
 * A non-secret scrypt hash used only to equalize verifyPassword timing when
 * the email is unknown or has no password yet. Identical construction to
 * services/api/src/onboarding/login.ts's DUMMY_HASH -- deliberately a
 * separate constant (see token.ts's header for why services/auth does not
 * import services/api src).
 */
const DUMMY_HASH = "scrypt$32768$8$1$ZHVtbXlfc2FsdF8xNg$ZHVtbXlfZGVyaXZlZF9rZXlfMzJfYnl0ZXNfX18";

/** onboarding/routes.ts:54's rule, reused verbatim: no composition rules, no new dependency. */
const passwordSchema = z.string().min(12).max(4096);
const emailSchema = z.string().email().max(320);

export interface HumanAuthDeps {
  readonly authPool: Pool;
  readonly credentialReader: UserCredentialReader;
  readonly cookieSecret: string;
  readonly audit: AuditEmitter;
  readonly deliverForgotPasswordEmail: (input: {
    tenantId: string;
    email: string;
    token: string;
    expiresAt: Date;
  }) => Promise<boolean>;
}

function cspStyleNonce(reply: FastifyReply): string | undefined {
  return (reply as unknown as { cspNonce?: { style?: string } }).cspNonce?.style;
}

function readCookies(request: FastifyRequest): Record<string, string> {
  return parseCookies(request.headers.cookie);
}

/**
 * Reuses an existing, still-valid carrier cookie instead of unconditionally
 * re-minting one (finding 10): re-minting on every GET and error render
 * overwrote the cookie, so opening /login in a second tab silently
 * invalidated the first tab's CSRF token on its next submit -- fails closed
 * (a 400, never a bypass), but cheap to avoid. Reusing the SAME cookie value
 * across tabs derives the SAME token (deriveCsrfToken only reads the
 * cookie's signature segment), so either tab keeps working as long as the
 * shared carrier is still live. An invalid, missing, or expired carrier
 * still mints a fresh one exactly as before -- this does not weaken the CSRF
 * property, it only avoids gratuitously rotating a cookie that was already
 * valid.
 */
function setCarrierCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  secret: string,
): { csrfToken: string } {
  const existing = readCookies(request)[CSRF_COOKIE_NAME];
  if (existing !== undefined && verifyCsrfCarrier(secret, existing).ok) {
    return { csrfToken: deriveCsrfToken(secret, existing) };
  }
  const carrier = mintCsrfCarrier(secret);
  reply.header(
    "set-cookie",
    serializeHostCookie(CSRF_COOKIE_NAME, carrier.cookieValue, { maxAgeSeconds: 600 }),
  );
  return { csrfToken: deriveCsrfToken(secret, carrier.cookieValue) };
}

/** Verifies the submitted CSRF field against the request's carrier cookie. Fails closed. */
function csrfOk(request: FastifyRequest, secret: string, submitted: unknown): boolean {
  if (typeof submitted !== "string" || submitted.length === 0) return false;
  const carrierValue = readCookies(request)[CSRF_COOKIE_NAME];
  if (carrierValue === undefined) return false;
  const carrier = verifyCsrfCarrier(secret, carrierValue);
  if (!carrier.ok) return false;
  return verifyCsrfToken(secret, carrierValue, submitted);
}

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
}

function html(reply: FastifyReply, body: string, status = 200): string {
  reply.status(status).header("content-type", "text/html; charset=utf-8");
  return body;
}

interface LoginBody {
  email?: unknown;
  password?: unknown;
  csrf?: unknown;
  /** pending-authorization.ts's blob, resubmitted from GET /login's hidden field. */
  continue?: unknown;
}
interface SetPasswordBody {
  tid?: unknown;
  t?: unknown;
  password?: unknown;
  csrf?: unknown;
}
interface ForgotPasswordBody {
  email?: unknown;
  csrf?: unknown;
}

export async function registerHumanAuthRoutes(
  app: FastifyInstance,
  deps: HumanAuthDeps,
): Promise<void> {
  // ---- /login ----

  app.get(
    "/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      noStore(reply);
      const { csrfToken } = setCarrierCookie(request, reply, deps.cookieSecret);
      const query = request.query as { notice?: string; continue?: string } | undefined;
      const notice = query?.notice === "password_set" ? "Password set. Sign in below." : undefined;
      return html(
        reply,
        renderLoginPage({
          csrfToken,
          notice,
          continueToken: query?.continue,
          styleNonce: cspStyleNonce(reply),
        }),
      );
    },
  );

  app.post(
    "/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request: FastifyRequest<{ Body: LoginBody }>, reply) => {
      noStore(reply);
      const body = request.body ?? {};
      // Resubmitted on every re-render below so a failed attempt (bad CSRF,
      // wrong password, unverified email) does not lose an in-progress
      // GET /authorize -> /login handoff (pending-authorization.ts).
      const continueToken = typeof body.continue === "string" ? body.continue : undefined;

      if (!csrfOk(request, deps.cookieSecret, body.csrf)) {
        const { csrfToken } = setCarrierCookie(request, reply, deps.cookieSecret);
        return html(
          reply,
          renderLoginPage({
            csrfToken,
            continueToken,
            error: "Your session expired. Please try again.",
            styleNonce: cspStyleNonce(reply),
          }),
          400,
        );
      }

      const emailParsed = emailSchema.safeParse(body.email);
      const passwordRaw = typeof body.password === "string" ? body.password : "";
      const invalidCredentials = (): string => {
        const { csrfToken } = setCarrierCookie(request, reply, deps.cookieSecret);
        return html(
          reply,
          renderLoginPage({
            csrfToken,
            continueToken,
            error: "Invalid email or password.",
            styleNonce: cspStyleNonce(reply),
          }),
          401,
        );
      };

      if (!emailParsed.success) {
        // Still equalize timing against DUMMY_HASH even on a malformed email,
        // so a client cannot distinguish "bad email shape" from "unknown
        // email" by response latency.
        await verifyPassword(passwordRaw.length > 0 ? passwordRaw : "x", DUMMY_HASH);
        return invalidCredentials();
      }
      const email = emailParsed.data.toLowerCase();
      const cred = await deps.credentialReader.resolveByEmail(email);

      // Anti-enumeration: always run a verify (against DUMMY_HASH when the
      // email or password is absent) so timing cannot reveal which failed.
      const hashToCheck = cred?.passwordHash ?? DUMMY_HASH;
      const passwordOk = await verifyPassword(passwordRaw, hashToCheck);
      if (cred === null || cred.passwordHash === null || !passwordOk) {
        return invalidCredentials();
      }

      // AUTH-PATHS-PLAN.md section 2 security requirement 4: status='active'
      // AND email_verified_at NOT NULL before the AS considers the human
      // authenticated.
      if (cred.status !== "active" || cred.emailVerifiedAt === null) {
        const { csrfToken } = setCarrierCookie(request, reply, deps.cookieSecret);
        return html(
          reply,
          renderLoginPage({
            csrfToken,
            continueToken,
            error: "Verify your email before signing in.",
            styleNonce: cspStyleNonce(reply),
          }),
          403,
        );
      }

      // AUTHENTICATION succeeds here. AUTHORITY (an active admin members row)
      // is a SEPARATE question -- see authority.ts's header -- resolved only
      // when something downstream (/authorize) needs it, not gated on here.
      // No `memberId` claim (finding 8, session.ts's header): the session
      // carries only tenant_id/user_id, and /authorize resolves authority
      // fresh at that time rather than trusting a stale, unvalidated claim
      // minted here.
      const session = mintSessionCookie(deps.cookieSecret, {
        tenantId: cred.tenantId,
        userId: cred.userId,
        amr: ["pwd"],
      });
      reply.header("set-cookie", [
        serializeHostCookie(SESSION_COOKIE_NAME, session.cookieValue, {
          maxAgeSeconds: SESSION_TTL_SECONDS,
        }),
        clearHostCookie(CSRF_COOKIE_NAME),
      ]);

      await deps.audit.emit({
        tenantId: cred.tenantId,
        layer: "identity",
        actor: cred.userId,
        action: "auth.login",
        inputs: { method: "password" },
        outputs: { user_id: cred.userId },
      });

      // Resume a pending GET /authorize request if one is carried, instead of
      // the plain "signed in" page (pending-authorization.ts).
      const resumeTo =
        continueToken !== undefined
          ? resumePendingAuthorization(deps.cookieSecret, continueToken)
          : null;
      if (resumeTo !== null) {
        reply.status(303).header("location", resumeTo);
        return "";
      }

      return html(reply, renderSignedInPage({ email, styleNonce: cspStyleNonce(reply) }));
    },
  );

  // ---- /set-password ----

  app.get(
    "/set-password",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      noStore(reply);
      const query = request.query as { tid?: unknown; t?: unknown } | undefined;
      const tid = typeof query?.tid === "string" ? query.tid : "";
      const rawToken = typeof query?.t === "string" ? query.t : "";
      const { csrfToken } = setCarrierCookie(request, reply, deps.cookieSecret);

      if (!isBrainId(tid, ID_PREFIX.tenant) || rawToken.length === 0) {
        return html(reply, renderSetPasswordInvalidPage(cspStyleNonce(reply)), 404);
      }
      const valid = await isSetPasswordTokenLiveLogged(request, deps.authPool, tid, rawToken);
      if (!valid) {
        return html(reply, renderSetPasswordInvalidPage(cspStyleNonce(reply)), 404);
      }
      return html(
        reply,
        renderSetPasswordPage({
          csrfToken,
          tid,
          token: rawToken,
          styleNonce: cspStyleNonce(reply),
        }),
      );
    },
  );

  app.post(
    "/set-password",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request: FastifyRequest<{ Body: SetPasswordBody }>, reply) => {
      noStore(reply);
      const body = request.body ?? {};
      const tid = typeof body.tid === "string" ? body.tid : "";
      const rawToken = typeof body.t === "string" ? body.t : "";

      if (!csrfOk(request, deps.cookieSecret, body.csrf)) {
        const { csrfToken } = setCarrierCookie(request, reply, deps.cookieSecret);
        return html(
          reply,
          renderSetPasswordPage({
            csrfToken,
            tid,
            token: rawToken,
            error: "Your session expired. Please try again.",
            styleNonce: cspStyleNonce(reply),
          }),
          400,
        );
      }
      if (!isBrainId(tid, ID_PREFIX.tenant) || rawToken.length === 0) {
        return html(reply, renderSetPasswordInvalidPage(cspStyleNonce(reply)), 404);
      }

      const passwordParsed = passwordSchema.safeParse(body.password);
      if (!passwordParsed.success) {
        const { csrfToken } = setCarrierCookie(request, reply, deps.cookieSecret);
        return html(
          reply,
          renderSetPasswordPage({
            csrfToken,
            tid,
            token: rawToken,
            error: "Password must be at least 12 characters.",
            styleNonce: cspStyleNonce(reply),
          }),
          400,
        );
      }

      const passwordHash = await hashPassword(passwordParsed.data);
      const consumed = await consumeSetPasswordTokenLogged(
        request,
        deps.authPool,
        tid,
        rawToken,
        passwordHash,
      );
      if (consumed === null) {
        return html(reply, renderSetPasswordInvalidPage(cspStyleNonce(reply)), 404);
      }

      await deps.audit.emit({
        tenantId: tid,
        layer: "identity",
        actor: consumed.userId,
        action: "auth.password_set",
        inputs: {},
        outputs: { user_id: consumed.userId, status: "active" },
      });

      // Security requirement: setting a password does NOT create a session.
      // Redirect to /login -- a set-password link that logs you in is a
      // one-click takeover from a leaked Referer.
      reply.header("set-cookie", clearHostCookie(CSRF_COOKIE_NAME));
      reply.status(303).header("location", "/login?notice=password_set");
      return "";
    },
  );

  // ---- /forgot-password ----

  app.get(
    "/forgot-password",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      noStore(reply);
      const { csrfToken } = setCarrierCookie(request, reply, deps.cookieSecret);
      return html(reply, renderForgotPasswordPage({ csrfToken, styleNonce: cspStyleNonce(reply) }));
    },
  );

  app.post(
    "/forgot-password",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request: FastifyRequest<{ Body: ForgotPasswordBody }>, reply) => {
      noStore(reply);
      const body = request.body ?? {};
      if (!csrfOk(request, deps.cookieSecret, body.csrf)) {
        const { csrfToken } = setCarrierCookie(request, reply, deps.cookieSecret);
        return html(
          reply,
          renderForgotPasswordPage({
            csrfToken,
            styleNonce: cspStyleNonce(reply),
          }),
          400,
        );
      }

      const emailParsed = emailSchema.safeParse(body.email);
      const email = emailParsed.success ? emailParsed.data.toLowerCase() : null;
      const cred = email === null ? null : await deps.credentialReader.resolveAnyByEmail(email);

      // Constant response + equalized timing regardless of whether the email
      // resolves (onboarding/login.ts's DUMMY_HASH pattern) -- this is the
      // anti-enumeration non-negotiable, never branch the HTTP response on
      // whether `cred` is null.
      await verifyPassword("equalize-timing-only", DUMMY_HASH);

      if (cred !== null && email !== null) {
        const rawToken = newRawToken();
        const expiresAt = new Date(Date.now() + SET_PASSWORD_TOKEN_TTL_MS);
        const tenantId = cred.tenantId;
        const userId = cred.userId;
        // Dispatched, NOT awaited: the token insert (a transaction), the
        // outbound ESP HTTP call, and the audit emit are all hit-path-only
        // work that a miss never does. Awaiting them here reintroduces the
        // exact timing oracle DUMMY_HASH equalizes away above (finding 3) --
        // ~200-600ms hit vs ~30ms miss, a network round trip no scrypt
        // equalization can flatten. The response below fires before any of
        // this runs. Every failure is logged via request.log.error (finding
        // 7) rather than swallowed -- this is fire-and-forget, not
        // fire-and-ignore.
        void (async () => {
          try {
            await withTenantScope(deps.authPool, tenantId, async (client: TenantScopedClient) => {
              await client.query(
                `INSERT INTO email_verifications (token_hash, user_id, tenant_id, expires_at)
                   VALUES ($1, $2, $3, $4)`,
                [sha256Hex(rawToken), userId, tenantId, expiresAt],
              );
            });
            const sent = await deps.deliverForgotPasswordEmail({
              tenantId,
              email,
              token: rawToken,
              expiresAt,
            });
            if (!sent) {
              request.log.warn("forgot-password email provider returned a non-success status");
            }
          } catch (err) {
            request.log.error(
              { err },
              "forgot-password: failed to mint token, insert, or send email",
            );
            return;
          }
          try {
            await deps.audit.emit({
              tenantId,
              layer: "identity",
              actor: userId,
              action: "auth.password_reset_requested",
              inputs: {},
              outputs: { user_id: userId },
            });
          } catch (err) {
            request.log.error({ err }, "forgot-password: audit emit failed");
          }
        })();
      }

      const { csrfToken } = setCarrierCookie(request, reply, deps.cookieSecret);
      return html(
        reply,
        renderForgotPasswordPage({ csrfToken, submitted: true, styleNonce: cspStyleNonce(reply) }),
        202,
      );
    },
  );
}

async function isSetPasswordTokenLive(pool: Pool, tid: string, rawToken: string): Promise<boolean> {
  return withTenantScope(pool, tid, async (client: TenantScopedClient) => {
    const { rows } = await client.query<{ user_id: string }>(
      `SELECT user_id FROM email_verifications
        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
      [sha256Hex(rawToken)],
    );
    return rows[0] !== undefined;
  });
}

/**
 * Wraps isSetPasswordTokenLive so a DB failure is never silently identical
 * to a genuinely dead token (finding 7): a missing GRANT, statement timeout,
 * pool exhaustion, or RLS misconfiguration now logs a real operator-facing
 * error via request.log before falling back to the same safe "invalid" page
 * the user sees either way.
 */
async function isSetPasswordTokenLiveLogged(
  request: FastifyRequest,
  pool: Pool,
  tid: string,
  rawToken: string,
): Promise<boolean> {
  try {
    return await isSetPasswordTokenLive(pool, tid, rawToken);
  } catch (err) {
    request.log.error({ err }, "set-password: token lookup failed");
    return false;
  }
}

async function consumeSetPasswordToken(
  pool: Pool,
  tid: string,
  rawToken: string,
  passwordHash: string,
): Promise<{ userId: string } | null> {
  return withTenantScope(pool, tid, async (client: TenantScopedClient) => {
    // Atomic single-use claim (RFC 6749 section 10.5's "one-time code"
    // pattern, same shape OAUTH-AS-PLAN.md section 5.4 requires for
    // authorization codes): a zero-row result is a hard reject, and two
    // concurrent presentations of the same token cannot both win.
    const { rows } = await client.query<{ user_id: string }>(
      `UPDATE email_verifications
          SET consumed_at = now()
        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING user_id`,
      [sha256Hex(rawToken)],
    );
    const row = rows[0];
    if (row === undefined) return null;

    // A disabled user (0023_members.sql's users.status='disabled' offboarding
    // signal) must not be able to reset their way back into 'active' (finding
    // 5): the account's former holder can still receive mail at that address
    // after being offboarded. The token claimed above is burned either way
    // (single-use, never replayable) -- returning null here renders the
    // IDENTICAL "invalid, expired, or already used" page as any other dead
    // token, so this refusal creates no new oracle.
    const { rows: userRows } = await client.query<{ status: string }>(
      `SELECT status FROM users WHERE id = $1`,
      [row.user_id],
    );
    if (userRows[0]?.status === "disabled") return null;

    // Family invalidation, same transaction (AUTH-PATHS-PLAN.md section 2):
    // kill every OTHER outstanding token for this user. Idempotent if this
    // was the only one.
    await client.query(
      `UPDATE email_verifications SET consumed_at = now()
        WHERE user_id = $1 AND consumed_at IS NULL`,
      [row.user_id],
    );

    // Consuming sets both status='active' and email_verified_at -- same as
    // onboarding/routes.ts's verify-email consumption. Receiving and
    // clicking the emailed link IS proof of mailbox ownership.
    await client.query(
      `UPDATE users
          SET password_hash = $1,
              status = 'active',
              email_verified_at = COALESCE(email_verified_at, now())
        WHERE id = $2`,
      [passwordHash, row.user_id],
    );
    return { userId: row.user_id };
  });
}

/**
 * Wraps consumeSetPasswordToken so a DB failure is never silently identical
 * to a genuinely dead token (finding 7), and specifically distinguishes
 * finding 6's cross-tenant `23505` (unique_violation on the GLOBAL
 * `users_login_email_unique` index, `UNIQUE (lower(email)) WHERE
 * password_hash IS NOT NULL`) from every other failure mode in the log: this
 * case still renders the same generic "invalid link" page to the user (never
 * a new oracle), but is a real, currently-PERMANENT product limitation --
 * see this file's header comment for the escalation note -- that an operator
 * needs to be able to find, not a transient error indistinguishable from one.
 */
async function consumeSetPasswordTokenLogged(
  request: FastifyRequest,
  pool: Pool,
  tid: string,
  rawToken: string,
  passwordHash: string,
): Promise<{ userId: string } | null> {
  try {
    return await consumeSetPasswordToken(pool, tid, rawToken, passwordHash);
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "23505") {
      request.log.error(
        { err, tid },
        "set-password: cross-tenant unique violation on users_login_email_unique -- " +
          "this email already has a password set under a different tenant, so this " +
          "reset is permanently blocked (product limitation, finding 6)",
      );
    } else {
      request.log.error({ err }, "set-password: token consume failed");
    }
    return null;
  }
}
