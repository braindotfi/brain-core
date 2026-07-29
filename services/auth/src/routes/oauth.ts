/**
 * The OAuth 2.1 core: GET/POST /authorize, POST /authorize/consent,
 * POST /token, POST /revoke (OAUTH-AS-PLAN.md section 3, Phase 2a increment 3
 * + Phase 2b). No DCR yet (Phase 3). Consent model (OAUTH-AS-PLAN.md
 * section 0):
 *
 *   granted_scopes = requested_scopes
 *                  ∩ registered_scopes(agent)     // scopesForAgentRole(agent.role)
 *                  ∩ AGENT_PERMITTED_SCOPES        // consent.ts
 *
 * Security posture (OAUTH-AS-PLAN.md section 5), the rules everything else
 * here defends: (1) an unknown client_id or a redirect_uri that does not
 * match a registered value renders an error page and NEVER redirects -- that
 * is the open-redirect boundary, checked first in both /authorize handlers
 * below, before any other input is trusted enough to drive a redirect; (2) a
 * code is single-use, proven by the one atomic UPDATE in oauth-codes.ts, and
 * any zero-row consume (a genuine replay OR the losing side of a race)
 * revokes the refresh-token family for that grant and is audited flagged;
 * (3) Phase 2b: a refresh token is rotate-on-use (oauth-refresh.ts), and
 * presenting an already-rotated one is reuse -- same "revoke the whole
 * family, audit flagged" treatment as (2); (4) POST /revoke always answers
 * 200 with an empty body regardless of whether the token existed or matched,
 * per RFC 7009 section 2.2 -- status and body are genuinely
 * indistinguishable, so a caller cannot tell "never existed" from "existed
 * and got revoked" from the response shape alone. That is NOT a claim of
 * full timing-side-channel freedom (a hit does a tenant-scoped round trip
 * plus an audit emit; a miss does one indexed SELECT) -- but the caller must
 * already hold the raw token to reach either branch, so a timing difference
 * only confirms "what I stole is live," nothing an attacker does not already
 * know; (5) only a client whose `oauth_clients.grant_types` includes
 * `refresh_token` ever gets one, on either the code-exchange or refresh
 * path (oauth-clients.ts).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  newTokenId,
  withTenantScope,
  type AuditEmitter,
  type JwtSigner,
  type TenantScopedClient,
} from "@brain/shared";
import { scopesForAgentRole } from "@brain/internal-agents";
import { assertScopeHashAcceptable, type OnchainScopeChecker } from "@brain/mcp";
import { resolveAuthority } from "../authority.js";
import { findActiveOauthClient } from "../oauth-clients.js";
import { matchesRedirectUri } from "../redirect-uri.js";
import { verifyPkce } from "../pkce.js";
import {
  computeConsentableScopes,
  intersectAgentPermitted,
  narrowByDeselection,
  narrowRefreshScopes,
  parseScopeParam,
} from "../consent.js";
import {
  issueAuthorizationCode,
  lookupAuthorizationCodeByHash,
  consumeAuthorizationCode,
  revokeRefreshTokenFamilyForGrant,
  type AuthorizationCodeLookup,
} from "../oauth-codes.js";
import {
  lookupRefreshTokenByHash,
  rotateRefreshToken,
  revokeRefreshFamily,
  loadConsentGrant,
  type RefreshSeed,
} from "../oauth-refresh.js";
import {
  mintPendingAuthorization,
  verifyPendingAuthorization,
  type PendingAuthorizationParams,
} from "../pending-authorization.js";
import {
  SESSION_COOKIE_NAME,
  deriveCsrfToken,
  parseCookies,
  verifyCsrfToken,
  verifySessionCookie,
  type SessionClaims,
} from "../session.js";
import { renderConsentPage, renderErrorPage, type ConsentAgentOption } from "../html.js";
import { newRawToken, sha256Hex } from "../token.js";

export interface OauthRouteDeps {
  readonly authPool: Pool;
  readonly resolverPool: Pool;
  readonly cookieSecret: string;
  readonly audit: AuditEmitter;
  readonly signer: JwtSigner;
  readonly onchain: OnchainScopeChecker;
  readonly authAudience: string;
  readonly mcpPublicResourceUrl: string;
  /** RFC 6749 section 5.1's ceiling is 1h; default matches it exactly. */
  readonly accessTokenTtlSeconds?: number;
}

// ---- small local helpers (mirrors routes/human-auth.ts's private helpers;
// not extracted to a shared file for two call sites) ----

function cspStyleNonce(reply: FastifyReply): string | undefined {
  return (reply as unknown as { cspNonce?: { style?: string } }).cspNonce?.style;
}

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
}

function html(reply: FastifyReply, body: string, status = 200): string {
  reply.status(status).header("content-type", "text/html; charset=utf-8");
  return body;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function arrayOfStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" ? [v] : [];
}

interface ReadSession {
  readonly claims: SessionClaims;
  readonly raw: string;
}

function readSession(request: FastifyRequest, secret: string): ReadSession | null {
  const raw = parseCookies(request.headers.cookie)[SESSION_COOKIE_NAME];
  if (raw === undefined) return null;
  const result = verifySessionCookie(secret, raw);
  if (!result.ok) return null;
  return { claims: result.payload, raw };
}

function scopeHashHex(scopeHash: Buffer | null): string | null {
  return scopeHash === null ? null : `0x${scopeHash.toString("hex")}`;
}

/**
 * RFC 8707 section 2.2: the access token's audience is derived per-request
 * from the `resource` param, shared by both grant paths (authorization_code
 * and refresh_token) so they cannot drift apart. An unrecognized `resource`
 * does NOT widen the audience -- it silently falls through to
 * `deps.authAudience` alone, matching this function's own behavior for a
 * missing `resource` too; no separate rejection branch.
 */
export function resolveAudience(
  deps: Pick<OauthRouteDeps, "authAudience" | "mcpPublicResourceUrl">,
  resource: string | undefined,
): string | string[] {
  return resource !== undefined && resource === deps.mcpPublicResourceUrl
    ? [deps.authAudience, deps.mcpPublicResourceUrl]
    : deps.authAudience;
}

/** Appends `error` (and `state`, if present) to an already-VALIDATED redirect_uri. Never call before matchesRedirectUri passed. */
function redirectWithError(
  reply: FastifyReply,
  redirectUri: string,
  state: string,
  error: string,
): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (state !== "") url.searchParams.set("state", state);
  reply.status(302).header("location", url.toString());
  return "";
}

// ---- agents table reads (defense-in-depth: RLS scopes the connection,
// tenant_id is also filtered explicitly, matching authority.ts's pattern) ----

interface EligibleAgentRow {
  readonly id: string;
  readonly display_name: string;
  readonly role: string;
  readonly scope_hash: Buffer | null;
}

async function listEligibleAgents(pool: Pool, tenantId: string): Promise<EligibleAgentRow[]> {
  return withTenantScope(pool, tenantId, async (client: TenantScopedClient) => {
    const { rows } = await client.query<EligibleAgentRow>(
      `SELECT id, display_name, role, scope_hash FROM agents
        WHERE tenant_id = $1 AND state = 'active' AND scope_hash IS NOT NULL
        ORDER BY display_name`,
      [tenantId],
    );
    return rows;
  });
}

async function loadActiveAgent(
  pool: Pool,
  tenantId: string,
  agentId: string,
): Promise<EligibleAgentRow | null> {
  return withTenantScope(pool, tenantId, async (client: TenantScopedClient) => {
    const { rows } = await client.query<EligibleAgentRow>(
      `SELECT id, display_name, role, scope_hash FROM agents
        WHERE tenant_id = $1 AND id = $2 AND state = 'active' LIMIT 1`,
      [tenantId, agentId],
    );
    return rows[0] ?? null;
  });
}

// ---- request-shape helpers shared by GET /authorize and POST /authorize/consent ----

interface ParsedAuthorizeRequest {
  readonly responseType: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly resource: string;
}

/**
 * Validates client_id + redirect_uri FIRST (the open-redirect boundary).
 * Returns `{ ok: false }` with an already-rendered error-page body when
 * either fails -- the caller must return that body directly and must NOT
 * attempt a redirect. Once `ok: true`, `redirectUri` is trusted enough to
 * carry further errors as `?error=...&state=...`.
 */
async function resolveClientAndRedirect(
  deps: OauthRouteDeps,
  reply: FastifyReply,
  input: { clientId: string | undefined; redirectUri: string | undefined },
): Promise<
  | { ok: true; clientId: string; clientName: string; redirectUri: string }
  | { ok: false; body: string }
> {
  const client =
    input.clientId !== undefined
      ? await findActiveOauthClient(deps.authPool, input.clientId)
      : null;
  if (client === null) {
    return {
      ok: false,
      body: html(
        reply,
        renderErrorPage("Unknown or disabled OAuth client.", cspStyleNonce(reply)),
        400,
      ),
    };
  }
  if (
    input.redirectUri === undefined ||
    !matchesRedirectUri(client.redirectUris, input.redirectUri)
  ) {
    return {
      ok: false,
      body: html(
        reply,
        renderErrorPage(
          "redirect_uri does not exactly match a value registered for this client.",
          cspStyleNonce(reply),
        ),
        400,
      ),
    };
  }
  return {
    ok: true,
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUri: input.redirectUri,
  };
}

export async function registerOauthRoutes(
  app: FastifyInstance,
  deps: OauthRouteDeps,
): Promise<void> {
  const accessTokenTtlSeconds = deps.accessTokenTtlSeconds ?? 3600;

  // ---- GET /authorize ----

  app.get(
    "/authorize",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      noStore(reply);
      const q = request.query as Record<string, unknown>;

      const resolved = await resolveClientAndRedirect(deps, reply, {
        clientId: str(q["client_id"]),
        redirectUri: str(q["redirect_uri"]),
      });
      if (!resolved.ok) return resolved.body;
      const { clientId, clientName, redirectUri } = resolved;

      const state = str(q["state"]) ?? "";
      const errRedirect = (error: string): string =>
        redirectWithError(reply, redirectUri, state, error);

      const responseType = str(q["response_type"]);
      const codeChallenge = str(q["code_challenge"]);
      const codeChallengeMethod = str(q["code_challenge_method"]);
      const resource = str(q["resource"]);
      const scope = str(q["scope"]) ?? "";

      if (responseType !== "code") return errRedirect("unsupported_response_type");
      if (codeChallenge === undefined) return errRedirect("invalid_request");
      if (codeChallengeMethod !== "S256") return errRedirect("invalid_request");
      if (resource !== undefined && resource !== deps.mcpPublicResourceUrl)
        return errRedirect("invalid_target");

      const pending: ParsedAuthorizeRequest = {
        responseType,
        clientId,
        redirectUri,
        scope,
        state,
        codeChallenge,
        codeChallengeMethod,
        resource: resource ?? "",
      };

      const session = readSession(request, deps.cookieSecret);
      if (session === null) {
        const blob = mintPendingAuthorization(deps.cookieSecret, toPendingParams(pending));
        reply.status(302).header("location", `/login?continue=${encodeURIComponent(blob)}`);
        return "";
      }

      const authority = await resolveAuthorityFor(deps, session.claims);
      if (!authority.ok) {
        await deps.audit.emit({
          tenantId: session.claims.tenant_id,
          layer: "identity",
          actor: session.claims.user_id,
          action: "oauth.authorize.denied",
          inputs: { client_id: clientId, reason: authority.reason },
          outputs: {},
        });
        return errRedirect("access_denied");
      }

      const requestedScopes = parseScopeParam(scope);
      const rows = await listEligibleAgents(deps.authPool, authority.tenantId);
      const agents: ConsentAgentOption[] = [];
      for (const row of rows) {
        // Display-time only: the authoritative on-chain/canonical scope-hash
        // check runs once, at POST /authorize/consent, against the ONE agent
        // actually selected -- not here, which would mean an on-chain read
        // per eligible agent on every page render.
        const registered = scopesForAgentRole(row.role);
        const consentable = computeConsentableScopes(requestedScopes, registered);
        if (consentable.length === 0) continue;
        agents.push({
          agentId: row.id,
          displayName: row.display_name,
          role: row.role,
          consentableScopes: consentable,
        });
      }

      const csrfToken = deriveCsrfToken(deps.cookieSecret, session.raw);
      return html(
        reply,
        renderConsentPage({
          csrfToken,
          clientName,
          tenantId: authority.tenantId,
          pending: {
            client_id: pending.clientId,
            redirect_uri: pending.redirectUri,
            response_type: pending.responseType,
            scope: pending.scope,
            state: pending.state,
            code_challenge: pending.codeChallenge,
            code_challenge_method: pending.codeChallengeMethod,
            resource: pending.resource,
          },
          agents,
          styleNonce: cspStyleNonce(reply),
        }),
      );
    },
  );

  // ---- POST /authorize/consent ----

  app.post(
    "/authorize/consent",
    async (request: FastifyRequest<{ Body: Record<string, unknown> }>, reply) => {
      noStore(reply);
      const body = request.body ?? {};

      const resolved = await resolveClientAndRedirect(deps, reply, {
        clientId: str(body["client_id"]),
        redirectUri: str(body["redirect_uri"]),
      });
      if (!resolved.ok) return resolved.body;
      const { clientId, redirectUri } = resolved;

      const state = str(body["state"]) ?? "";
      const errRedirect = (error: string): string =>
        redirectWithError(reply, redirectUri, state, error);

      const session = readSession(request, deps.cookieSecret);
      if (session === null) {
        return html(
          reply,
          renderErrorPage("Your session expired. Please sign in again.", cspStyleNonce(reply)),
          401,
        );
      }
      if (!verifyCsrfToken(deps.cookieSecret, session.raw, str(body["csrf"]) ?? "")) {
        return html(
          reply,
          renderErrorPage("Your session expired. Please try again.", cspStyleNonce(reply)),
          400,
        );
      }

      const authority = await resolveAuthorityFor(deps, session.claims);
      if (!authority.ok) {
        await deps.audit.emit({
          tenantId: session.claims.tenant_id,
          layer: "identity",
          actor: session.claims.user_id,
          action: "oauth.authorize.denied",
          inputs: { client_id: clientId, reason: authority.reason },
          outputs: {},
        });
        return errRedirect("access_denied");
      }

      if (str(body["decision"]) !== "allow") {
        await deps.audit.emit({
          tenantId: authority.tenantId,
          layer: "identity",
          actor: authority.memberId,
          action: "oauth.authorize.denied",
          inputs: { client_id: clientId, reason: "user_denied" },
          outputs: {},
        });
        return errRedirect("access_denied");
      }

      const responseType = str(body["response_type"]);
      const codeChallenge = str(body["code_challenge"]);
      const codeChallengeMethod = str(body["code_challenge_method"]);
      const resource = str(body["resource"]);
      if (
        responseType !== "code" ||
        codeChallenge === undefined ||
        codeChallengeMethod !== "S256"
      ) {
        return errRedirect("invalid_request");
      }
      if (resource !== undefined && resource !== deps.mcpPublicResourceUrl) {
        return errRedirect("invalid_target");
      }

      const agentId = str(body["agent_id"]);
      if (agentId === undefined) return errRedirect("invalid_request");

      // Cross-tenant (or missing/inactive) agent selection: fails closed as a
      // hard error, not a redirect -- an admin submitting a tampered agent_id
      // is a security violation attempt, not a normal user-denial flow.
      const agent = await loadActiveAgent(deps.authPool, authority.tenantId, agentId);
      if (agent === null) {
        return html(reply, renderErrorPage("Agent not found.", cspStyleNonce(reply)), 404);
      }

      const registeredScopes = scopesForAgentRole(agent.role);
      try {
        await assertScopeHashAcceptable({
          agentId: agent.id,
          scopeHash: agent.scope_hash,
          expectedScopes: registeredScopes,
          onchain: deps.onchain,
        });
      } catch {
        await deps.audit.emit({
          tenantId: authority.tenantId,
          layer: "identity",
          actor: authority.memberId,
          eventType: "flagged",
          action: "oauth.scope_hash.mismatch",
          inputs: { client_id: clientId, agent_id: agent.id },
          outputs: {},
        });
        return html(
          reply,
          renderErrorPage(
            "This agent's scope attestation could not be verified.",
            cspStyleNonce(reply),
          ),
          409,
        );
      }

      const requestedScopes = parseScopeParam(str(body["scope"]));
      const consentable = computeConsentableScopes(requestedScopes, registeredScopes);
      const selected = arrayOfStrings(body["scope_selected"]);
      const granted = narrowByDeselection(consentable, selected);

      const code = newRawToken();
      const codeHash = sha256Hex(code);
      // agent.scope_hash is non-null: assertScopeHashAcceptable above throws
      // agent_scope_hash_missing (caught above) when it is.
      const { grantId } = await issueAuthorizationCode(deps.authPool, {
        tenantId: authority.tenantId,
        clientId,
        agentId: agent.id,
        memberId: authority.memberId,
        scopes: granted,
        scopeHashAtGrant: agent.scope_hash as Buffer,
        redirectUri,
        codeChallenge,
        resource: resource ?? null,
        codeHash,
      });

      await deps.audit.emit({
        tenantId: authority.tenantId,
        layer: "identity",
        actor: authority.memberId,
        action: "oauth.consent.granted",
        inputs: { client_id: clientId, agent_id: agent.id, requested_scopes: requestedScopes },
        outputs: {
          granted_scopes: granted,
          grant_id: grantId,
          scope_hash: scopeHashHex(agent.scope_hash),
        },
      });

      const url = new URL(redirectUri);
      url.searchParams.set("code", code);
      if (state !== "") url.searchParams.set("state", state);
      reply.status(302).header("location", url.toString());
      return "";
    },
  );

  // ---- POST /token ----

  /**
   * `grant_type=authorization_code` exchange, extracted to its own function
   * (Phase 2b) purely so the dispatcher below stays readable -- unchanged
   * behavior from Phase 2a increment 3 except it now also mints a refresh
   * token atomically with consuming the code (oauth-codes.ts's
   * consumeAuthorizationCode).
   */
  async function handleAuthorizationCodeGrant(
    request: FastifyRequest,
    reply: FastifyReply,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const code = str(body["code"]);
    const redirectUri = str(body["redirect_uri"]);
    const clientId = str(body["client_id"]);
    if (code === undefined || redirectUri === undefined || clientId === undefined) {
      reply.code(400);
      return { error: "invalid_request" };
    }

    const client = await findActiveOauthClient(deps.authPool, clientId);
    if (client === null) {
      reply.code(401);
      return { error: "invalid_client" };
    }

    const codeHash = sha256Hex(code);
    const lookup = await lookupAuthorizationCodeByHash(deps.resolverPool, codeHash);
    if (lookup === null) {
      // ponytail: structured pino warn as the "own counter" for failed code
      // exchange (section 5.10) -- this service has no StatsD client wired
      // yet; promote to a real metric if/when one is added.
      request.log.warn({
        event: "oauth.token.code_exchange_failed",
        reason: "not_found",
        clientId,
      });
      reply.code(400);
      return { error: "invalid_grant" };
    }
    if (lookup.consumedAt !== null) {
      await handleCodeReplay(deps, lookup, request);
      reply.code(400);
      return { error: "invalid_grant" };
    }
    if (lookup.expiresAt.getTime() <= Date.now()) {
      request.log.warn({
        event: "oauth.token.code_exchange_failed",
        reason: "expired",
        clientId,
      });
      reply.code(400);
      return { error: "invalid_grant" };
    }
    if (lookup.clientId !== clientId || lookup.redirectUri !== redirectUri) {
      request.log.warn({
        event: "oauth.token.code_exchange_failed",
        reason: "binding_mismatch",
        clientId,
      });
      reply.code(400);
      return { error: "invalid_grant" };
    }
    if (!verifyPkce(body["code_verifier"], lookup.codeChallenge)) {
      request.log.warn({ event: "oauth.token.pkce_failed", clientId });
      reply.code(400);
      return { error: "invalid_grant" };
    }

    // Only a client registered for refresh_token ever gets one -- see
    // oauth-clients.ts. `client` was already looked up above.
    const mayIssueRefreshToken = client.grantTypes.includes("refresh_token");
    const refreshToken = mayIssueRefreshToken ? newRawToken() : null;
    const consumed = await consumeAuthorizationCode(
      deps.authPool,
      lookup.tenantId,
      codeHash,
      refreshToken === null
        ? null
        : { tokenHash: sha256Hex(refreshToken), tokenId: newTokenId(), familyId: newTokenId() },
    );
    if (consumed === null) {
      // Zero rows: either a genuine replay racing this request, or the
      // losing side of two concurrent exchanges. Both are handled
      // identically per OAUTH-AS-PLAN.md section 5.4 -- see file header.
      await handleCodeReplay(deps, lookup, request);
      reply.code(400);
      return { error: "invalid_grant" };
    }

    const audience = resolveAudience(deps, consumed.resource ?? undefined);
    // Defensive re-intersection, symmetric with the refresh path
    // (narrowRefreshScopes already applies this). Not reachable today --
    // computeConsentableScopes already applied AGENT_PERMITTED_SCOPES at
    // consent time -- but the two /token paths should not silently diverge
    // on this ceiling (Opus review, Phase 2b).
    const grantedScopes = intersectAgentPermitted(consumed.scopes);

    const tokenId = newTokenId();
    const expiresAt = Math.floor(Date.now() / 1000) + accessTokenTtlSeconds;
    const accessToken = await deps.signer.sign(
      {
        id: consumed.agentId,
        type: "agent",
        tenantId: consumed.tenantId,
        scopes: grantedScopes,
        tokenId,
        expiresAt,
      },
      audience,
    );

    await deps.audit.emit({
      tenantId: consumed.tenantId,
      layer: "identity",
      actor: consumed.agentId,
      action: "oauth.token.minted",
      inputs: { client_id: consumed.clientId, grant_id: consumed.grantId },
      outputs: { token_id: tokenId, scopes: grantedScopes, agent_id: consumed.agentId },
    });

    reply.code(200);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: accessTokenTtlSeconds,
      ...(refreshToken !== null ? { refresh_token: refreshToken } : {}),
      scope: grantedScopes.join(" "),
    };
  }

  /**
   * `grant_type=refresh_token` (Phase 2b, OAUTH-AS-PLAN.md section 3):
   * rotate-on-use with reuse detection, RFC 6749 section 6 scope
   * narrow-never-widen, a re-check of the durable consent grant (revocation
   * and on-chain scope-hash drift), and an agent-state check that doubles as
   * the quarantine check (see the loadActiveAgent call below).
   */
  async function handleRefreshTokenGrant(
    request: FastifyRequest,
    reply: FastifyReply,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const refreshToken = str(body["refresh_token"]);
    const clientId = str(body["client_id"]);
    if (refreshToken === undefined || clientId === undefined) {
      reply.code(400);
      return { error: "invalid_request" };
    }

    // ponytail: structured pino warn as the "own counter", same posture as
    // handleAuthorizationCodeGrant's code_exchange_failed warns above -- this
    // service has no StatsD client wired yet; promote to a real metric if/
    // when one is added.
    const warnRefresh = (reason: string): void => {
      request.log.warn({ event: "oauth.token.refresh_failed", reason, clientId });
    };

    const client = await findActiveOauthClient(deps.authPool, clientId);
    if (client === null) {
      reply.code(401);
      return { error: "invalid_client" };
    }
    // RFC 6749 section 5.2: `unauthorized_client` is the correct error for a
    // client authenticated fine but not authorized for THIS grant type --
    // enforced now that oauth_clients.grant_types is actually read
    // (oauth-clients.ts; Opus review, Phase 2b: previously decorative).
    if (!client.grantTypes.includes("refresh_token")) {
      warnRefresh("unauthorized_client");
      reply.code(400);
      return { error: "unauthorized_client" };
    }

    const tokenHash = sha256Hex(refreshToken);
    const lookup = await lookupRefreshTokenByHash(deps.resolverPool, tokenHash);
    if (lookup === null) {
      warnRefresh("not_found");
      reply.code(400);
      return { error: "invalid_grant" };
    }
    if (lookup.revokedAt !== null) {
      warnRefresh("revoked");
      reply.code(400);
      return { error: "invalid_grant" };
    }
    if (lookup.rotatedAt !== null) {
      // Reuse of an already-rotated refresh token (RFC 6749 section 10.4) is
      // checked BEFORE expiry: a rotated token is compromise evidence
      // regardless of age. Checking expiry first would let a stolen token
      // replayed after its 30-day TTL return a bare "expired" and never
      // revoke the family (Opus review, Phase 2b P1) -- the exact scenario
      // this branch exists to catch.
      await revokeRefreshFamily(deps.authPool, lookup.tenantId, lookup.grantId, lookup.familyId);
      await deps.audit.emit({
        tenantId: lookup.tenantId,
        layer: "identity",
        actor: lookup.agentId,
        eventType: "flagged",
        action: "oauth.refresh_token.reused",
        inputs: { client_id: lookup.clientId, grant_id: lookup.grantId },
        outputs: {},
      });
      warnRefresh("reused");
      reply.code(400);
      return { error: "invalid_grant" };
    }
    if (lookup.expiresAt.getTime() <= Date.now()) {
      warnRefresh("expired");
      reply.code(400);
      return { error: "invalid_grant" };
    }
    if (lookup.clientId !== clientId) {
      warnRefresh("client_mismatch");
      reply.code(400);
      return { error: "invalid_grant" };
    }

    const grant = await loadConsentGrant(deps.authPool, lookup.tenantId, lookup.grantId);
    if (grant === null || grant.revokedAt !== null) {
      // A revoked (or vanished) consent grant must kill every outstanding
      // refresh token in the family within this one exchange.
      await revokeRefreshFamily(deps.authPool, lookup.tenantId, lookup.grantId, lookup.familyId);
      await deps.audit.emit({
        tenantId: lookup.tenantId,
        layer: "identity",
        actor: lookup.agentId,
        eventType: "flagged",
        action: "oauth.refresh_token.grant_revoked",
        inputs: { client_id: lookup.clientId, grant_id: lookup.grantId },
        outputs: {},
      });
      warnRefresh("grant_revoked");
      reply.code(400);
      return { error: "invalid_grant" };
    }

    // POST /v1/agents/{id}/halt moves an agent to state 'quarantined', and
    // loadActiveAgent filters state = 'active' -- this null IS the
    // quarantine check, no separate query needed.
    const agent = await loadActiveAgent(deps.authPool, lookup.tenantId, lookup.agentId);
    if (agent === null) {
      // Normal (not flagged) audit trace: unlike the branches above, an
      // inactive/quarantined agent is not itself evidence of compromise, but
      // CLAUDE.md's "every write that matters is audited" still applies --
      // this was the one Phase 2b DoD condition with no audit trace before
      // (Opus review).
      await deps.audit.emit({
        tenantId: lookup.tenantId,
        layer: "identity",
        actor: lookup.agentId,
        action: "oauth.refresh_token.agent_inactive",
        inputs: { client_id: lookup.clientId, grant_id: lookup.grantId, agent_id: lookup.agentId },
        outputs: {},
      });
      warnRefresh("agent_inactive");
      reply.code(400);
      return { error: "invalid_grant" };
    }

    // Anti-silent-widening: oauth_consent_grants' table comment (migration
    // 0001) describes exactly this -- if the tenant rotated this agent's
    // on-chain scope set since consent, agents.scope_hash no longer matches
    // scope_hash_at_grant, and refresh must fail rather than silently carry
    // the stale grant forward. A null scope_hash counts as drift too.
    if (agent.scope_hash === null || !agent.scope_hash.equals(grant.scopeHashAtGrant)) {
      await revokeRefreshFamily(deps.authPool, lookup.tenantId, lookup.grantId, lookup.familyId);
      await deps.audit.emit({
        tenantId: lookup.tenantId,
        layer: "identity",
        actor: lookup.agentId,
        eventType: "flagged",
        action: "oauth.refresh.scope_hash_drift",
        inputs: { client_id: lookup.clientId, grant_id: lookup.grantId, agent_id: lookup.agentId },
        outputs: {},
      });
      warnRefresh("scope_hash_drift");
      reply.code(400);
      return { error: "invalid_grant" };
    }

    // The durable consent grant is the authority on scope (migration 0001's
    // table comment on oauth_consent_grants): intersect the refresh row's own
    // scopes down to what the grant still lists, THEN apply the requested
    // narrowing. Without this, grant.scopes is read but never actually
    // enforced (Opus review, Phase 2b).
    const grantScopeSet = new Set(grant.scopes);
    const authorizedScopes = lookup.scopes.filter((s) => grantScopeSet.has(s));
    const narrowed = narrowRefreshScopes(authorizedScopes, str(body["scope"]));
    if (!narrowed.ok) {
      reply.code(400);
      return { error: "invalid_scope" };
    }

    const newRefreshToken = newRawToken();
    const newSeed: RefreshSeed = {
      tenantId: lookup.tenantId,
      agentId: lookup.agentId,
      clientId: lookup.clientId,
      grantId: lookup.grantId,
      familyId: lookup.familyId,
      tokenId: newTokenId(),
      tokenHash: sha256Hex(newRefreshToken),
      scopes: narrowed.scopes,
    };
    const rotated = await rotateRefreshToken(deps.authPool, lookup.tenantId, tokenHash, newSeed);
    if (!rotated) {
      // Zero rows: the losing side of a concurrent rotation race -- treated
      // identically to reuse (same family-kill, same flagged audit -- this
      // branch IS the concurrency half of reuse detection, the one a racing
      // attacker lands on).
      await revokeRefreshFamily(deps.authPool, lookup.tenantId, lookup.grantId, lookup.familyId);
      await deps.audit.emit({
        tenantId: lookup.tenantId,
        layer: "identity",
        actor: lookup.agentId,
        eventType: "flagged",
        action: "oauth.refresh_token.rotation_race",
        inputs: { client_id: lookup.clientId, grant_id: lookup.grantId },
        outputs: {},
      });
      warnRefresh("rotation_race");
      reply.code(400);
      return { error: "invalid_grant" };
    }

    // ponytail: deliberately NOT calling assertScopeHashAcceptable's on-chain
    // check here -- an RPC round trip (and an RPC-flake fail-closed) on the
    // hot refresh path for no gain, since the DB-vs-grant scope_hash
    // comparison above already catches drift from the same on-chain-derived
    // value. Upgrade path: add the on-chain read too if the mirrored DB value
    // is ever found to lag it.

    // RFC 8707 section 2.2 permits `resource` on a refresh_token request too.
    // The audience is derived per-request from it (resolveAudience, shared
    // with the code path) rather than persisted on the refresh row, so a
    // grant's audience can never be silently widened by a stale stored value
    // -- there is no column to migrate because there is nothing to store.
    const audience = resolveAudience(deps, str(body["resource"]));

    const tokenId = newTokenId();
    const expiresAt = Math.floor(Date.now() / 1000) + accessTokenTtlSeconds;
    const accessToken = await deps.signer.sign(
      {
        id: lookup.agentId,
        type: "agent",
        tenantId: lookup.tenantId,
        scopes: narrowed.scopes,
        tokenId,
        expiresAt,
      },
      audience,
    );

    await deps.audit.emit({
      tenantId: lookup.tenantId,
      layer: "identity",
      actor: lookup.agentId,
      action: "oauth.token.minted",
      inputs: { client_id: lookup.clientId, grant_id: lookup.grantId, grant_type: "refresh_token" },
      outputs: { token_id: tokenId, scopes: narrowed.scopes, agent_id: lookup.agentId },
    });

    reply.code(200);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: accessTokenTtlSeconds,
      refresh_token: newRefreshToken,
      scope: narrowed.scopes.join(" "),
    };
  }

  const tokenRateLimitConfig = {
    rateLimit: {
      max: 60,
      timeWindow: "1 minute",
      hook: "preHandler" as const, // needs request.body -> parsed after onRequest
      keyGenerator: (req: FastifyRequest) => {
        const body = req.body as Record<string, unknown> | undefined;
        const clientId = typeof body?.["client_id"] === "string" ? body["client_id"] : undefined;
        return clientId ?? req.ip;
      },
    },
  };

  app.post(
    "/token",
    { config: tokenRateLimitConfig },
    async (request: FastifyRequest<{ Body: Record<string, unknown> }>, reply) => {
      // RFC 6749 section 5.1 requires no-store on token-endpoint responses.
      reply.header("cache-control", "no-store");
      const body = request.body ?? {};
      const grantType = str(body["grant_type"]);

      if (grantType === "authorization_code") {
        return handleAuthorizationCodeGrant(request, reply, body);
      }
      if (grantType === "refresh_token") {
        return handleRefreshTokenGrant(request, reply, body);
      }
      reply.code(400);
      return { error: "unsupported_grant_type" };
    },
  );

  // ---- POST /revoke (RFC 7009) ----

  const revokeRateLimitConfig = {
    rateLimit: {
      max: 60,
      timeWindow: "1 minute",
      hook: "preHandler" as const,
      // Keyed on client_id + ip, NOT client_id alone (Opus review, Phase 2b):
      // client_id is caller-controlled and unauthenticated at this endpoint
      // (public clients, no secret), so keying on it alone lets anyone send
      // 60 junk requests/minute carrying a real public client's id and rate-
      // limit every legitimate holder of that client's tokens out of
      // revocation -- a targeted DoS on the one endpoint meant for incident
      // remediation. /token's tokenRateLimitConfig is left as client_id-only:
      // that key only ever gates a caller who ALSO holds a valid code or
      // refresh token bound to that client, so the same forgery has no
      // matching payload to pair with it there.
      keyGenerator: (req: FastifyRequest) => {
        const body = req.body as Record<string, unknown> | undefined;
        const clientId = typeof body?.["client_id"] === "string" ? body["client_id"] : "anon";
        return `${clientId}:${req.ip}`;
      },
    },
  };

  app.post(
    "/revoke",
    { config: revokeRateLimitConfig },
    async (request: FastifyRequest<{ Body: Record<string, unknown> }>, reply) => {
      reply.header("cache-control", "no-store");
      const body = request.body ?? {};
      const token = str(body["token"]);
      const clientId = str(body["client_id"]);

      // RFC 7009 section 2.2: the endpoint MUST answer 200 with an empty
      // body whether the token existed, was already revoked, or belonged to
      // a different client -- response status and body are indistinguishable
      // across every branch below (see the file header for the honest
      // caveat: that is not a claim of full timing-side-channel freedom).
      if (token !== undefined) {
        const tokenHash = sha256Hex(token);
        const lookup = await lookupRefreshTokenByHash(deps.resolverPool, tokenHash);
        // ponytail: access tokens are stateless JWTs verified against JWKS,
        // not rows in this table -- this endpoint has no way to revoke one.
        // Returning `unsupported_token_type` for one would itself be a
        // distinguishable (oracle) response, so an access token (or any
        // token this table has never heard of) is accepted and silently
        // ignored instead, same as an already-revoked or client-mismatched one.
        if (lookup !== null && lookup.revokedAt === null) {
          // RFC 7009 section 2.1: client authentication at this endpoint is
          // only required for confidential clients. Every client registered
          // here is public (token_endpoint_auth_method 'none', no secret to
          // check), so a missing client_id is not itself suspicious -- only
          // an explicit mismatch (a client_id present but naming a DIFFERENT
          // client than the one that holds this token) refuses the revoke.
          if (clientId === undefined || lookup.clientId === clientId) {
            await revokeRefreshFamily(
              deps.authPool,
              lookup.tenantId,
              lookup.grantId,
              lookup.familyId,
            );
            await deps.audit.emit({
              tenantId: lookup.tenantId,
              layer: "identity",
              actor: lookup.agentId,
              action: "oauth.refresh_token.revoked",
              inputs: { client_id: lookup.clientId, grant_id: lookup.grantId },
              outputs: {},
            });
          }
        }
      }

      reply.code(200);
      return "";
    },
  );
}

async function handleCodeReplay(
  deps: OauthRouteDeps,
  lookup: AuthorizationCodeLookup,
  request: FastifyRequest,
): Promise<void> {
  request.log.warn({
    event: "oauth.token.code_exchange_failed",
    reason: "replayed",
    clientId: lookup.clientId,
  });
  await revokeRefreshTokenFamilyForGrant(deps.authPool, lookup.tenantId, lookup.grantId);
  await deps.audit.emit({
    tenantId: lookup.tenantId,
    layer: "identity",
    actor: lookup.agentId,
    eventType: "flagged",
    action: "oauth.code.replayed",
    inputs: { client_id: lookup.clientId, grant_id: lookup.grantId },
    outputs: {},
  });
}

type AuthorityFor =
  | { ok: true; tenantId: string; memberId: string }
  | { ok: false; reason: "member_missing" | "member_inactive" | "not_admin" };

async function resolveAuthorityFor(
  deps: OauthRouteDeps,
  claims: SessionClaims,
): Promise<AuthorityFor> {
  const result = await resolveAuthority(deps.authPool, {
    tenantId: claims.tenant_id,
    userId: claims.user_id,
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, tenantId: result.grant.tenantId, memberId: result.grant.memberId };
}

function toPendingParams(pending: ParsedAuthorizeRequest): PendingAuthorizationParams {
  return {
    response_type: pending.responseType,
    client_id: pending.clientId,
    redirect_uri: pending.redirectUri,
    scope: pending.scope,
    state: pending.state,
    code_challenge: pending.codeChallenge,
    code_challenge_method: pending.codeChallengeMethod,
    resource: pending.resource,
  };
}

/**
 * Decodes a `continue` blob submitted from /login's hidden field back into
 * an `/authorize?...` query string, for a successful login to resume the
 * OAuth flow. Exported for routes/human-auth.ts's POST /login handler.
 * Returns null for a missing, expired, or tampered blob -- the caller falls
 * back to its normal (non-OAuth) post-login behavior in that case.
 */
export function resumePendingAuthorization(
  cookieSecret: string,
  continueToken: string,
): string | null {
  const result = verifyPendingAuthorization(cookieSecret, continueToken);
  if (!result.ok) return null;
  return `/authorize?${new URLSearchParams({ ...result.payload }).toString()}`;
}
