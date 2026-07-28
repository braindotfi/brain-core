export { buildAuthApp, type BuildAuthAppOptions, type HumanAuthOptions } from "./server.js";
export {
  buildAuthorizationServerMetadata,
  WELL_KNOWN_AS_PATH,
  WELL_KNOWN_JWKS_PATH,
  type AuthorizationServerMetadata,
} from "./metadata.js";
export { buildJwks, type JwksDocument } from "./jwks.js";
export {
  buildAuthDbPools,
  resolveRoleUrl,
  type AuthDbPools,
  type AuthDbPoolsInput,
  type AuthRoleUrlName,
} from "./db.js";
export { resolveAuthority, type AuthorityResult, type AuthorityGrant } from "./authority.js";
export {
  ResolverUserCredentialReader,
  type AuthUserCredential,
  type UserCredentialReader,
} from "./credentials.js";
export { newRawToken, sha256Hex, SET_PASSWORD_TOKEN_TTL_MS } from "./token.js";
export {
  buildForgotPasswordEmailDelivery,
  type ForgotPasswordEmailDelivery,
  type ForgotPasswordEmailConfig,
} from "./email.js";
export { registerAuthSecurityHeaders } from "./security-headers.js";
export { registerHumanAuthRoutes } from "./routes/human-auth.js";
export {
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  mintSessionCookie,
  verifySessionCookie,
  mintCsrfCarrier,
  verifyCsrfCarrier,
  deriveCsrfToken,
  verifyCsrfToken,
  serializeHostCookie,
  clearHostCookie,
  parseCookies,
  type SessionClaims,
} from "./session.js";
export * from "./html.js";

// Phase 2a increment 3: the OAuth core.
export { isValidCodeVerifier, deriveCodeChallenge, verifyPkce } from "./pkce.js";
export { isRegistrableRedirectUri, matchesRedirectUri } from "./redirect-uri.js";
export { findActiveOauthClient, insertOauthClient, type OauthClient } from "./oauth-clients.js";
export { parseScopeParam, computeConsentableScopes, narrowByDeselection } from "./consent.js";
export {
  AUTHORIZATION_CODE_TTL_SECONDS,
  issueAuthorizationCode,
  lookupAuthorizationCodeByHash,
  consumeAuthorizationCode,
  revokeRefreshTokenFamilyForGrant,
  type AuthorizationCodeLookup,
  type IssueCodeInput,
} from "./oauth-codes.js";
export {
  mintPendingAuthorization,
  verifyPendingAuthorization,
  pendingAuthorizationToQueryString,
  type PendingAuthorizationParams,
} from "./pending-authorization.js";
export {
  createAuthOnchainScopeChecker,
  type ViemScopeCheckerOptions,
} from "./onchain-scope-checker.js";
export {
  registerOauthRoutes,
  resumePendingAuthorization,
  type OauthRouteDeps,
} from "./routes/oauth.js";
