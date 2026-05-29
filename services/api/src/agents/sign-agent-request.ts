/**
 * X-Brain-Auth HMAC signer for outbound calls to the Python brain-agents
 * service. Matches the verifier in services/agents/brain_agents/auth.py:
 *
 *   X-Brain-Auth: sha256=hex(hmac_sha256(secret, body))
 *
 * The verifier compares the digest over the EXACT request body bytes — so
 * the api MUST send the same byte sequence it signed. Build a stable JSON
 * string once, sign it, then send that same string as the body. Do NOT
 * pass an object to fetch's `body` (the client may re-serialize with a
 * different key order).
 */

import { createHmac } from "node:crypto";

const PREFIX = "sha256=";

/** Returns the value to put in the X-Brain-Auth header. */
export function signAgentRequest(secret: string, body: string): string {
  return PREFIX + createHmac("sha256", secret).update(body).digest("hex");
}
