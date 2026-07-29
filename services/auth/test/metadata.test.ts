import { describe, expect, it } from "vitest";
import { AGENT_PERMITTED_SCOPES } from "@brain/shared";
import { buildAuthorizationServerMetadata, WELL_KNOWN_JWKS_PATH } from "../src/metadata.js";

const ISSUER = "https://auth.brain.fi";

describe("buildAuthorizationServerMetadata", () => {
  it("round-trips AUTH_ISSUER exactly as `issuer`", () => {
    const md = buildAuthorizationServerMetadata(ISSUER);
    expect(md.issuer).toBe(ISSUER);
  });

  it("contains every RFC 8414 field this AS advertises", () => {
    const md = buildAuthorizationServerMetadata(ISSUER);
    expect(md.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(md.token_endpoint).toBe(`${ISSUER}/token`);
    expect(md.jwks_uri).toBe(`${ISSUER}${WELL_KNOWN_JWKS_PATH}`);
    expect(md.response_types_supported).toEqual(["code"]);
    expect(md.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(md.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(md.revocation_endpoint).toBe(`${ISSUER}/revoke`);
    expect(md.revocation_endpoint_auth_methods_supported).toEqual(["none"]);
  });

  it("derives jwks_uri from AUTH_ISSUER, structurally never from AUTH_JWKS_URL", () => {
    // The function takes only `issuer`; there is no AUTH_JWKS_URL parameter
    // it could leak. Pin the shape against the in-network URL AUTH_JWKS_URL
    // actually holds in prod (docker-compose.prod.yml), so a future signature
    // change that reintroduces a second URL input is caught here.
    const authJwksUrl = "http://jwks:8085/.well-known/jwks.json";
    const md = buildAuthorizationServerMetadata(ISSUER);
    expect(md.jwks_uri).not.toBe(authJwksUrl);
    expect(md.jwks_uri).toBe(`${md.issuer}${WELL_KNOWN_JWKS_PATH}`);
  });

  it("supports S256 only, never plain", () => {
    const md = buildAuthorizationServerMetadata(ISSUER);
    expect(md.code_challenge_methods_supported).toContain("S256");
    expect(md.code_challenge_methods_supported).not.toContain("plain");
  });

  it("advertises exactly AGENT_PERMITTED_SCOPES, imported not re-listed", () => {
    const md = buildAuthorizationServerMetadata(ISSUER);
    expect(new Set(md.scopes_supported)).toEqual(new Set(AGENT_PERMITTED_SCOPES));
  });
});
