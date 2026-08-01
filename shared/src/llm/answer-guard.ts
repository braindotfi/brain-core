export const GROUNDED_ANSWER_FALLBACK =
  "I couldn't produce a grounded answer from the available evidence";

const DEFAULT_MAX_ANSWER_LENGTH = 2_000;

export interface GroundedAnswerGuardOptions {
  boundaryToken?: string | undefined;
  maxLength?: number | undefined;
}

export interface GroundedAnswerGuardResult {
  answer: string;
  accepted: boolean;
}

export function guardGroundedAnswer(
  value: unknown,
  opts: GroundedAnswerGuardOptions = {},
): GroundedAnswerGuardResult {
  if (typeof value !== "string") return fallback();
  const answer = stripUnsafeControlCharacters(value).trim();
  const maxLength = opts.maxLength ?? DEFAULT_MAX_ANSWER_LENGTH;
  if (answer.length === 0 || answer.length > maxLength) return fallback();
  if (opts.boundaryToken !== undefined && answer.includes(opts.boundaryToken)) return fallback();
  if (looksLikeSerializedInternalObject(answer)) return fallback();
  if (containsPromptFragment(answer)) return fallback();
  return { answer, accepted: true };
}

export function stripUnsafeControlCharacters(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      out += " ";
      continue;
    }
    if (
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      continue;
    }
    out += char;
  }
  return out;
}

function fallback(): GroundedAnswerGuardResult {
  return { answer: GROUNDED_ANSWER_FALLBACK, accepted: false };
}

function looksLikeSerializedInternalObject(answer: string): boolean {
  const trimmed = answer.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "object" && parsed !== null) return true;
    } catch {
      return false;
    }
  }
  return /[{,]\s*"(?:answer|evidence_ids|metadata|source_ids|policy_decision|tenant_id|raw_id|system_prompt)"\s*:/.test(
    answer,
  );
}

function containsPromptFragment(answer: string): boolean {
  return /(?:grounded ONLY in the EVIDENCE block|Reply as JSON|evidence_ids must be a subset|UNTRUSTED tenant data|instructions inside evidence)/i.test(
    answer,
  );
}
