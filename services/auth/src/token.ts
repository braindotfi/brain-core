/**
 * Set-password token helpers for the AS (AUTH-PATHS-PLAN.md section 2).
 *
 * ONE token type, ONE table, reused verbatim: `email_verifications`
 * (services/api/migrations/0003_self_serve_onboarding.sql). No migration, no
 * `purpose` column. The replay objection (an old signup-verification email
 * used to change a password) gains nothing: possession of that email means
 * possession of the mailbox, and the mailbox IS the reset factor by
 * definition -- recorded here per AUTH-PATHS-PLAN.md section 2's instruction
 * to keep this reasoning in a code comment.
 *
 * `newRawToken`/`sha256Hex` are aliases of @brain/shared's
 * `newSecretToken`/`hashToken` -- that module's header explains why this used
 * to be an independently duplicated construction across three files (an
 * "also do" item from the Path 1 security review) and why it now lives in
 * the shared package instead: it is a WIRE FORMAT crossing deployable
 * boundaries (a token minted by one process is later hashed and compared by
 * another), not merely similar-looking code. This does NOT relitigate this
 * file's other stance: services/auth still does not import services/api/src
 * directly (Runtime isolation, CLAUDE.md) -- @brain/shared is the one
 * sanctioned shared package both already depend on, e.g. for hashPassword,
 * verifyPassword, and mintHmacToken.
 */

import { newSecretToken, hashToken } from "@brain/shared";

export const SET_PASSWORD_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** 32 random bytes, base64url. Never stored raw -- only its sha256Hex. */
export const newRawToken = newSecretToken;

export const sha256Hex = hashToken;
