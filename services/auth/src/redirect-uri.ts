/**
 * Redirect-URI validation (OAUTH-AS-PLAN.md section 5.1-5.2).
 *
 * Exact byte-for-byte string equality against a registered `redirect_uris`
 * entry. No prefix, no wildcard, no subdomain, no trailing-slash
 * normalization, no query-parameter merging -- the plain string comparison
 * below IS that rule; nothing here rewrites either side. The single
 * exception is loopback port variance (RFC 8252 section 7.3): scheme, host,
 * and path must match exactly, only the port may differ.
 *
 * Unknown client_id or a non-matching redirect_uri must render an error page
 * and MUST NOT redirect (section 5.2) -- that branch lives in routes/oauth.ts,
 * not here; this module only answers yes/no.
 */

/**
 * `URL.hostname` for an IPv6 literal keeps its brackets (verified:
 * `new URL("http://[::1]:1/").hostname === "[::1]"`, not `"::1"`) -- both
 * forms are checked here since callers may also compare a bracket-free
 * value from elsewhere.
 */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

/** Registration-time rule: https:// or a loopback http:// literal, never a fragment. */
export function isRegistrableRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash !== "") return false;
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && isLoopbackHost(parsed.hostname);
}

/**
 * True iff `candidate` is one of `registered` verbatim, or a loopback
 * redirect_uri that matches a registered loopback entry in everything but
 * port.
 */
export function matchesRedirectUri(registered: readonly string[], candidate: string): boolean {
  if (registered.includes(candidate)) return true;

  let candidateUrl: URL;
  try {
    candidateUrl = new URL(candidate);
  } catch {
    return false;
  }
  if (candidateUrl.protocol !== "http:" || !isLoopbackHost(candidateUrl.hostname)) return false;
  if (candidateUrl.hash !== "") return false;

  return registered.some((entry) => {
    let entryUrl: URL;
    try {
      entryUrl = new URL(entry);
    } catch {
      return false;
    }
    return (
      entryUrl.protocol === candidateUrl.protocol &&
      entryUrl.hostname === candidateUrl.hostname &&
      entryUrl.pathname === candidateUrl.pathname &&
      entryUrl.search === candidateUrl.search &&
      entryUrl.hash === ""
    );
  });
}
