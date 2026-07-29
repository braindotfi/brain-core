/**
 * RFC 7591 Dynamic Client Registration (DCR) request validation.
 *
 * Pure and DB-free by design: `POST /register` (routes/register.ts) is a thin
 * wrapper around `validateClientRegistration` below, so every rejection rule
 * here -- each one a security boundary, not a formality -- is unit-testable
 * without a database.
 *
 * Deliberately absent: RFC 7592 client configuration management
 * (`registration_access_token`, `registration_client_uri`, GET/PUT/DELETE on
 * a registered client). No MCP host needs it yet (OAUTH-AS-PLAN.md section
 * 3), and skipping it means v1 stores no registration credential at all.
 */

import { isRegistrableRedirectUri } from "./redirect-uri.js";

export const MAX_REDIRECT_URIS = 10;
export const MAX_REDIRECT_URI_LENGTH = 2048;
export const MAX_CLIENT_NAME_LENGTH = 200;
export const MAX_SOFTWARE_FIELD_LENGTH = 100;

/** This AS supports public clients only (OAUTH-AS-PLAN.md section 5.7). */
const ALLOWED_GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);

export interface ValidatedClientRegistration {
  readonly redirectUris: readonly string[];
  readonly grantTypes: readonly string[];
  readonly responseTypes: readonly string[];
  readonly tokenEndpointAuthMethod: "none";
  readonly clientName: string;
  readonly softwareId: string | undefined;
  readonly softwareVersion: string | undefined;
}

export type ClientRegistrationErrorCode = "invalid_redirect_uri" | "invalid_client_metadata";

export interface ClientRegistrationError {
  readonly error: ClientRegistrationErrorCode;
  readonly error_description: string;
}

export type ClientRegistrationResult =
  | { readonly ok: true; readonly value: ValidatedClientRegistration }
  | { readonly ok: false; readonly error: ClientRegistrationError };

function fail(
  error: ClientRegistrationErrorCode,
  error_description: string,
): ClientRegistrationResult {
  return { ok: false, error: { error, error_description } };
}

/** `undefined` = field omitted (caller keeps its own default); throws nothing, returns `null` on a validation failure so the caller can produce its own message. */
function capOptionalString(value: unknown, maxLength: number): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) return null;
  return value;
}

/**
 * RFC 7591 section 3.1. Unknown/extra body members are ignored per section
 * 3, simply by never being read below. `scope` is accepted and ignored too
 * (see the dedicated comment at its would-be read site) rather than silently
 * read and discarded elsewhere, so the omission reads as deliberate.
 */
export function validateClientRegistration(body: unknown): ClientRegistrationResult {
  const b: Record<string, unknown> =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

  // ---- redirect_uris: REQUIRED ----
  const rawRedirectUris = b["redirect_uris"];
  if (!Array.isArray(rawRedirectUris) || rawRedirectUris.length === 0) {
    return fail(
      "invalid_redirect_uri",
      "redirect_uris is required and must be a non-empty array of strings.",
    );
  }
  if (rawRedirectUris.length > MAX_REDIRECT_URIS) {
    return fail(
      "invalid_redirect_uri",
      `redirect_uris must not exceed ${MAX_REDIRECT_URIS} entries.`,
    );
  }
  const redirectUris: string[] = [];
  for (const uri of rawRedirectUris) {
    if (
      typeof uri !== "string" ||
      uri.length > MAX_REDIRECT_URI_LENGTH ||
      !isRegistrableRedirectUri(uri)
    ) {
      return fail(
        "invalid_redirect_uri",
        `each redirect_uri must be https:// or a loopback http:// literal, contain no fragment, ` +
          `and be at most ${MAX_REDIRECT_URI_LENGTH} characters.`,
      );
    }
    redirectUris.push(uri);
  }

  // ---- token_endpoint_auth_method ----
  // RFC 7591 section 2's default when omitted is "client_secret_basic". This
  // AS supports public clients only (OAUTH-AS-PLAN.md section 5.7), so an
  // omitted value is treated as "none" instead: the metadata document
  // (metadata.ts) already advertises token_endpoint_auth_methods_supported =
  // ["none"], so a client that read it before registering already knows, and
  // defaulting to a method this AS cannot honor would register a client that
  // can never authenticate. An EXPLICIT value other than "none" is rejected
  // rather than silently downgraded, so a confidential-client host finds out
  // at registration time, not at its first failed token exchange.
  const rawAuthMethod = b["token_endpoint_auth_method"];
  if (rawAuthMethod !== undefined && rawAuthMethod !== "none") {
    return fail(
      "invalid_client_metadata",
      'token_endpoint_auth_method must be "none" -- this authorization server supports public clients only.',
    );
  }
  const tokenEndpointAuthMethod = "none" as const;

  // ---- grant_types ----
  // RFC 7591 section 2's default when omitted is ["authorization_code"], and
  // that default is now load-bearing: Phase 2b enforces oauth_clients.grant_types
  // at /token (routes/oauth.ts), so a client registered with no grant_types
  // gets exactly authorization_code and is refused unauthorized_client on a
  // later refresh attempt, not silently granted one it never asked for.
  const rawGrantTypes = b["grant_types"];
  let grantTypes: string[];
  if (rawGrantTypes === undefined) {
    grantTypes = ["authorization_code"];
  } else {
    if (!Array.isArray(rawGrantTypes) || rawGrantTypes.length === 0) {
      return fail("invalid_client_metadata", "grant_types must be a non-empty array of strings.");
    }
    if (rawGrantTypes.some((g) => typeof g !== "string" || !ALLOWED_GRANT_TYPES.has(g))) {
      return fail(
        "invalid_client_metadata",
        'grant_types must be a subset of ["authorization_code", "refresh_token"].',
      );
    }
    const requested = rawGrantTypes as string[];
    if (requested.includes("refresh_token") && !requested.includes("authorization_code")) {
      return fail(
        "invalid_client_metadata",
        "grant_types cannot contain refresh_token without authorization_code -- " +
          "there is no other way for this client to obtain its first refresh token.",
      );
    }
    grantTypes = [...new Set(requested)];
  }

  // ---- response_types ----
  const rawResponseTypes = b["response_types"];
  if (
    rawResponseTypes !== undefined &&
    (!Array.isArray(rawResponseTypes) ||
      rawResponseTypes.length !== 1 ||
      rawResponseTypes[0] !== "code")
  ) {
    return fail("invalid_client_metadata", 'response_types must be exactly ["code"].');
  }
  const responseTypes = ["code"];

  // ---- client_name ----
  // Rendered on the consent page (html.ts's renderConsentPage, `esc(input.clientName)`).
  // Deliberately NOT sanitized or stripped here -- escaping at render is the
  // correct layer, and this value is stored and echoed verbatim (including a
  // literal "<script>") so nobody "optimizes away" html.ts's esc() call
  // later believing registration already made it safe.
  const rawClientName = b["client_name"];
  let clientName = "Unnamed client";
  if (rawClientName !== undefined) {
    const capped = capOptionalString(rawClientName, MAX_CLIENT_NAME_LENGTH);
    if (capped === null) {
      return fail(
        "invalid_client_metadata",
        `client_name must be a string of at most ${MAX_CLIENT_NAME_LENGTH} characters.`,
      );
    }
    if (capped !== undefined) clientName = capped;
  }

  // ---- software_id / software_version ----
  const softwareId = capOptionalString(b["software_id"], MAX_SOFTWARE_FIELD_LENGTH);
  if (softwareId === null) {
    return fail(
      "invalid_client_metadata",
      `software_id must be a string of at most ${MAX_SOFTWARE_FIELD_LENGTH} characters.`,
    );
  }
  const softwareVersion = capOptionalString(b["software_version"], MAX_SOFTWARE_FIELD_LENGTH);
  if (softwareVersion === null) {
    return fail(
      "invalid_client_metadata",
      `software_version must be a string of at most ${MAX_SOFTWARE_FIELD_LENGTH} characters.`,
    );
  }

  // ---- scope: accepted, deliberately ignored ----
  // Scope is decided at consent (consent.ts's computeConsentableScopes),
  // intersecting the admin's choice against the agent's registered scopes
  // and AGENT_PERMITTED_SCOPES -- a client cannot pre-negotiate scope at
  // registration. `b["scope"]` is never read, on purpose.

  return {
    ok: true,
    value: {
      redirectUris,
      grantTypes,
      responseTypes,
      tokenEndpointAuthMethod,
      clientName,
      softwareId: softwareId ?? undefined,
      softwareVersion: softwareVersion ?? undefined,
    },
  };
}
