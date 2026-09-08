import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { newAgentApiKeyId } from "../ids.js";
import { BFF_SERVICE_AGENT_SCOPES, type Scope } from "./scopes.js";

export type AgentApiKeyEnvironment = "test" | "live";
export type AgentApiKeyProfile = "document_extractor_v1" | "bff_service_v1";

export const AGENT_API_KEY_PROFILE_SCOPES = {
  document_extractor_v1: ["raw:write"],
  bff_service_v1: BFF_SERVICE_AGENT_SCOPES,
} as const satisfies Record<AgentApiKeyProfile, readonly Scope[]>;

export const AGENT_API_KEY_TTL_DAYS = 90;
export const AGENT_ACCESS_TOKEN_TTL_SECONDS = 5 * 60;
export const AGENT_API_KEY_SUBJECT_TOKEN_TYPE = "urn:brain:params:oauth:token-type:agent-api-key";
export const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const ACCESS_TOKEN_REQUESTED_TYPE = "urn:ietf:params:oauth:token-type:access_token";

const SECRET_BYTES = 32;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface ParsedAgentApiKey {
  readonly id: string;
  readonly environment: AgentApiKeyEnvironment;
}

export interface GeneratedAgentApiKey extends ParsedAgentApiKey {
  readonly plaintext: string;
  readonly prefix: string;
  readonly last4: string;
}

export function generateAgentApiKey(environment: AgentApiKeyEnvironment): GeneratedAgentApiKey {
  const id = newAgentApiKeyId();
  const idPart = id.slice("agkey_".length);
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const prefix = `brain_ak_${environment}_`;
  const plaintext = `${prefix}${idPart}_${secret}`;
  return {
    plaintext,
    prefix,
    last4: plaintext.slice(-4),
    id,
    environment,
  };
}

export function parseAgentApiKey(value: string): ParsedAgentApiKey | null {
  const match = /^brain_ak_(test|live)_([0-9A-HJKMNP-TV-Z]{26})_([A-Za-z0-9_-]{43})$/.exec(value);
  if (match === null) return null;
  const environment = match[1];
  const idPart = match[2];
  const secret = match[3];
  if (
    (environment !== "test" && environment !== "live") ||
    idPart === undefined ||
    secret === undefined ||
    !ULID_RE.test(idPart) ||
    !SECRET_RE.test(secret)
  ) {
    return null;
  }
  return { id: `agkey_${idPart}`, environment };
}

export function hashAgentApiKey(value: string, pepper: string): string {
  return createHmac("sha256", pepper).update(value, "utf8").digest("hex");
}

export function agentApiKeyHashesEqual(storedHex: string, computedHex: string): boolean {
  const stored = Buffer.from(storedHex, "hex");
  const computed = Buffer.from(computedHex, "hex");
  return (
    stored.length > 0 && stored.length === computed.length && timingSafeEqual(stored, computed)
  );
}

export function scopesForAgentApiKeyProfile(profile: AgentApiKeyProfile): readonly Scope[] {
  return AGENT_API_KEY_PROFILE_SCOPES[profile];
}

export function scopesMatchAgentApiKeyProfile(
  profile: AgentApiKeyProfile,
  scopes: readonly string[],
): boolean {
  const expected = [...scopesForAgentApiKeyProfile(profile)].sort();
  const actual = [...new Set(scopes)].sort();
  return (
    expected.length === actual.length && expected.every((scope, index) => scope === actual[index])
  );
}

export function isAgentApiKeyProfile(value: unknown): value is AgentApiKeyProfile {
  return value === "document_extractor_v1" || value === "bff_service_v1";
}
