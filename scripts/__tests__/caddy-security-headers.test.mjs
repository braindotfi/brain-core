import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const caddyfile = readFileSync("Caddyfile", "utf8");

test("Caddy applies the common security headers to every public site", () => {
  assert.match(caddyfile, /Strict-Transport-Security "max-age=31536000; includeSubDomains"/);
  assert.match(caddyfile, /X-Content-Type-Options "nosniff"/);
  assert.match(caddyfile, /X-Frame-Options "DENY"/);
  assert.match(caddyfile, /Referrer-Policy "strict-origin-when-cross-origin"/);
  assert.match(caddyfile, /\n\s*-Server\n/);

  for (const site of ["api.brain.fi", "mcp.brain.fi", "auth.brain.fi"]) {
    const siteBlock = caddyfile.slice(caddyfile.indexOf(`${site} {`));
    assert.match(siteBlock, /import edge_security_headers/);
  }
});

test("Caddy applies the Scalar-compatible CSP only to API documentation", () => {
  assert.match(caddyfile, /@docs path \/v1\/docs \/v1\/docs\/\*/);
  assert.match(caddyfile, /header @docs \{/);
  assert.match(caddyfile, /script-src 'self'/);
  assert.match(caddyfile, /style-src 'self' 'unsafe-inline'/);
  assert.match(caddyfile, /connect-src 'self'/);
  assert.match(caddyfile, /frame-ancestors 'none'/);
  assert.match(
    caddyfile,
    /api.brain.fi \{\n\s*import edge_security_headers\n\s*import api_docs_csp/,
  );
});
