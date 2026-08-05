import { createHash, randomBytes } from "node:crypto";

/**
 * Opaque bearer/reset-link token pair: mint a random raw token, store only
 * its SHA-256 hex digest, compare hashes on presentation (never the raw
 * token) -- the shape behind set-password links, refresh tokens, and invite
 * tokens.
 *
 * This exact construction (`randomBytes(32).toString("base64url")` +
 * `createHash("sha256").update(token, "utf8").digest("hex")`) was
 * implemented independently three times: services/auth/src/token.ts (the AS
 * set-password link), services/api/src/production-tenancy/routes.ts
 * (set-password links, refresh tokens, invite tokens), and
 * services/execution/src/members/routes.ts (invite tokens). It is a WIRE
 * FORMAT shared across deployables -- one process mints a token, a DIFFERENT
 * process (or a later request to the same one) later hashes the presented
 * token and compares -- so a drift between copies would silently break
 * whichever flow crosses that boundary. This is the one shared copy; new and
 * existing callers consolidate onto it rather than adding a fourth.
 */
export function newSecretToken(): string {
  return randomBytes(32).toString("base64url");
}

// This digest is for randomly generated opaque bearer tokens only. Never use
// it for user-chosen or otherwise low-entropy secrets, which require a password
// hashing function. TODO(security-review 2027-02-05): revalidate this invariant
// before that date, or earlier when adding a hashToken caller.
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
