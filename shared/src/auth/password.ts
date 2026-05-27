/**
 * Password hashing for human (owner/operator) principals — RFC 0002 Phase B.
 *
 * Brain's machine principals authenticate with wallets (SIWX) + on-chain scope
 * attestations; only the *human* account created at self-serve signup needs a
 * password. This module is that primitive and nothing more.
 *
 * Implementation: Node's built-in `crypto.scrypt` (a memory-hard KDF), chosen
 * deliberately over argon2/bcrypt so Brain adds **no native-binding dependency**
 * (matches the repo's dependency-minimal posture and keeps CI builds portable).
 * Each hash carries its own random 16-byte salt and the cost parameters, so the
 * parameters can be raised later without invalidating existing hashes.
 *
 * Serialized format (single self-describing string stored in `users.password_hash`):
 *   `scrypt$<N>$<r>$<p>$<saltB64url>$<dkB64url>`
 *
 * Security notes:
 *  - `verifyPassword` is constant-time over the derived key (`timingSafeEqual`)
 *    and never throws on a malformed/foreign stored value — it returns `false`,
 *    so a corrupt row cannot crash the auth path or leak via an exception.
 *  - The plaintext is never logged and is bounded (`MAX_PASSWORD_BYTES`) so an
 *    enormous input cannot be used as a CPU-exhaustion vector.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

/** scrypt cost parameters. `N` is the CPU/memory cost (must be a power of two). */
const SCRYPT_N = 1 << 15; // 32768
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32; // derived-key length in bytes
const SALT_LEN = 16; // random salt length in bytes
/** scrypt needs ~128*N*r bytes; raise maxmem above the 32 MiB default for N=2^15. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
/** Reject absurdly long inputs (defense-in-depth; scrypt cost is N/r/p-bound). */
const MAX_PASSWORD_BYTES = 4096;

const PREFIX = "scrypt";

/** Promisified scrypt that resolves to the derived key. */
function scryptAsync(password: Buffer, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(
      password,
      salt,
      keylen,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (err, dk) => {
        if (err !== null) {
          reject(err);
          return;
        }
        resolve(dk);
      },
    );
  });
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Thrown only for caller misuse (non-string / over-length input), never for a bad password. */
export class PasswordInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PasswordInputError";
  }
}

function toBoundedBuffer(plain: string): Buffer {
  if (typeof plain !== "string") {
    throw new PasswordInputError("password must be a string");
  }
  const buf = Buffer.from(plain, "utf8");
  if (buf.length === 0) {
    throw new PasswordInputError("password must not be empty");
  }
  if (buf.length > MAX_PASSWORD_BYTES) {
    throw new PasswordInputError(`password exceeds ${MAX_PASSWORD_BYTES} bytes`);
  }
  return buf;
}

/**
 * Hash a plaintext password into the self-describing serialized format above.
 * Generates a fresh random salt per call, so hashing the same password twice
 * yields different strings.
 */
export async function hashPassword(plain: string): Promise<string> {
  const password = toBoundedBuffer(plain);
  const salt = randomBytes(SALT_LEN);
  const dk = await scryptAsync(password, salt, KEY_LEN);
  return `${PREFIX}$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${b64url(salt)}$${b64url(dk)}`;
}

interface ParsedHash {
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly dk: Buffer;
}

/** Parse a serialized hash; returns null for any malformed/foreign value. */
function parse(stored: string): ParsedHash | null {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (n <= 1 || (n & (n - 1)) !== 0 || r <= 0 || p <= 0) return null;
  let salt: Buffer;
  let dk: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? "", "base64url");
    dk = Buffer.from(parts[5] ?? "", "base64url");
  } catch {
    return null;
  }
  if (salt.length === 0 || dk.length === 0) return null;
  return { n, r, p, salt, dk };
}

/**
 * Verify a plaintext password against a stored serialized hash. Constant-time
 * over the derived key. Returns `false` (never throws) for a wrong password or a
 * malformed/foreign stored value; throws only on caller misuse of `plain`
 * (non-string / over-length), matching {@link hashPassword}.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const password = toBoundedBuffer(plain);
  const parsed = parse(stored);
  if (parsed === null) return false;
  const candidate = await new Promise<Buffer | null>((resolve) => {
    scryptCb(
      password,
      parsed.salt,
      parsed.dk.length,
      { N: parsed.n, r: parsed.r, p: parsed.p, maxmem: SCRYPT_MAXMEM },
      (err, dk) => resolve(err !== null ? null : dk),
    );
  });
  if (candidate === null || candidate.length !== parsed.dk.length) return false;
  return timingSafeEqual(candidate, parsed.dk);
}
