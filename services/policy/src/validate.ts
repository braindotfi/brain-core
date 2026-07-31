/**
 * Structural validation for a candidate PolicyDocument (H-P0-1).
 *
 * Before this module existed, `POST /policy/:tenant_id/compose` checked only
 * that `content.rules` was an array and `content.version` a number, then
 * content-hashed, signed, and activated whatever rule shapes were inside. A
 * rule missing `applies_to` or `when` throws deep inside vm.ts on the FIRST
 * evaluateForGate call for that tenant, which bricks every payment intent
 * for that tenant with a 500 instead of a policy denial.
 * `validatePolicyDocument` pushes that failure to compose/sign time, where
 * it is a normal 400/422, not a production incident.
 *
 * Every check throws `policy_rule_invalid` (400) on the FIRST problem found,
 * with `details.path` pointing at the offending field. No zod: the shape is
 * small and stable, and the repo convention here is hand-written checks over
 * a new dependency.
 */

import { brainError } from "@brain/shared";
import type { ApplyTo, PolicyDocument, RuleWhen } from "./dsl.js";
import { parseRequire, validateCronExpression } from "./vm.js";

function fail(message: string, path: string): never {
  throw brainError("policy_rule_invalid", message, { details: { path } });
}

const APPLY_TO_VALUES: ReadonlySet<string> = new Set<ApplyTo>([
  "outbound_payment",
  "inbound_payment",
  "ledger_write",
  "onchain_tx",
  "agent_action",
  "any",
]);

/**
 * Keys of the `RuleWhen` interface (dsl.ts) that this validator recognizes.
 * MUST be kept in exact sync with that interface -- an unknown `when` key is
 * a hard reject below rather than a silently-ignored typo, because a typoed
 * key (e.g. "amount.lte " or "agent.confidence.gt") would otherwise drop the
 * constraint entirely and widen the rule to match more than the author
 * intended.
 */
const KNOWN_WHEN_KEYS: ReadonlySet<keyof RuleWhen> = new Set([
  "counterparty.in",
  "counterparty.not_in",
  "amount.lte",
  "amount.gt",
  "agent.role",
  "time_window",
  "agent.id",
  "tenant.category",
  "action.in",
  "action.not_in",
  "agent.behaviorHash",
  "agent.spend_in_window",
  "agent.tx_count_in_window",
  "agent.confidence.gte",
  "agent.evidence_score.gte",
  "agent.risk_level.lte",
]);

/**
 * Windows spend-counters.ts actually understands (its WINDOW_MS keys). An
 * unknown window silently maps to the epoch (an all-time bucket) in
 * bucketStart -- tighter than intended, not looser, so it is never a
 * breach, but it is not what the author signed either. Reject it explicitly.
 */
const KNOWN_WINDOWS: ReadonlySet<string> = new Set(["1h", "24h", "7d", "30d"]);

const AMOUNT_VALUE_RE = /^-?\d+(\.\d{1,18})?$/;

function checkAmountLiteral(raw: unknown, path: string): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`${path} must be an amount literal object ({ currency, value })`, path);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.currency !== "string" || obj.currency.length === 0) {
    fail(`${path}.currency must be a non-empty string`, `${path}.currency`);
  }
  if (typeof obj.value !== "string") {
    // A number here reaches compareDecimal, which calls .trim() on it and
    // throws -- reject the shape at the boundary instead.
    fail(`${path}.value must be a string decimal, not a number`, `${path}.value`);
  }
  if (!AMOUNT_VALUE_RE.test(obj.value)) {
    // normalizeDecimal (vm.ts) keeps 18 fractional digits and silently
    // truncates beyond that, so anything looser is rejected here explicitly.
    fail(
      `${path}.value must be an optionally-signed decimal string with at most 18 fractional digits`,
      `${path}.value`,
    );
  }
}

function checkNonEmptyString(raw: unknown, path: string): void {
  if (typeof raw !== "string" || raw.length === 0) {
    fail(`${path} must be a non-empty string`, path);
  }
}

function checkStringArray(raw: unknown, path: string): void {
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || v.length === 0)) {
    fail(`${path} must be an array of non-empty strings`, path);
  }
}

function checkUnitInterval(raw: unknown, path: string): void {
  if (typeof raw !== "number" || Number.isNaN(raw) || raw < 0 || raw > 1) {
    fail(`${path} must be a number in the inclusive range 0 to 1`, path);
  }
}

function checkWindow(raw: unknown, path: string): void {
  if (typeof raw !== "string" || !KNOWN_WINDOWS.has(raw)) {
    fail(
      `${path} must be one of ${[...KNOWN_WINDOWS].join(", ")} -- these are the only windows spend-counters.ts computes a real bucket for`,
      path,
    );
  }
}

function checkCounterpartyRef(
  raw: unknown,
  path: string,
  lists: Readonly<Record<string, ReadonlyArray<string>>>,
): void {
  if (typeof raw !== "string" || raw.length === 0) {
    fail(`${path} must be a non-empty list-reference string`, path);
  }
  // Highest-value single check in this module: today policy.lists?.[ref] ??
  // [] treats a dangling reference as an empty list, which silently makes
  // counterparty.in match nothing (the rule never fires) and
  // counterparty.not_in match everything (the rule always fires). A typoed
  // blocklist reference therefore silently disables a block.
  if (!Object.prototype.hasOwnProperty.call(lists, raw)) {
    fail(`${path} references list "${raw}" which is not defined in this document lists`, path);
  }
}

function validateWhen(
  when: Record<string, unknown>,
  path: string,
  lists: Readonly<Record<string, ReadonlyArray<string>>>,
): void {
  if (when["counterparty.in"] !== undefined) {
    checkCounterpartyRef(when["counterparty.in"], `${path}["counterparty.in"]`, lists);
  }
  if (when["counterparty.not_in"] !== undefined) {
    checkCounterpartyRef(when["counterparty.not_in"], `${path}["counterparty.not_in"]`, lists);
  }
  if (when["amount.lte"] !== undefined) {
    checkAmountLiteral(when["amount.lte"], `${path}["amount.lte"]`);
  }
  if (when["amount.gt"] !== undefined) {
    checkAmountLiteral(when["amount.gt"], `${path}["amount.gt"]`);
  }
  if (when["agent.role"] !== undefined) {
    checkNonEmptyString(when["agent.role"], `${path}["agent.role"]`);
  }
  if (when["agent.id"] !== undefined) {
    checkNonEmptyString(when["agent.id"], `${path}["agent.id"]`);
  }
  if (when["tenant.category"] !== undefined) {
    const v = when["tenant.category"];
    if (v !== "business" && v !== "consumer") {
      fail(
        `${path}["tenant.category"] must be "business" or "consumer"`,
        `${path}["tenant.category"]`,
      );
    }
  }
  if (when["action.in"] !== undefined) {
    checkStringArray(when["action.in"], `${path}["action.in"]`);
  }
  if (when["action.not_in"] !== undefined) {
    checkStringArray(when["action.not_in"], `${path}["action.not_in"]`);
  }
  if (when["agent.behaviorHash"] !== undefined) {
    const v = when["agent.behaviorHash"];
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) {
      fail(
        `${path}["agent.behaviorHash"] must be a 0x-prefixed hex string`,
        `${path}["agent.behaviorHash"]`,
      );
    }
  }
  if (when["agent.confidence.gte"] !== undefined) {
    checkUnitInterval(when["agent.confidence.gte"], `${path}["agent.confidence.gte"]`);
  }
  if (when["agent.evidence_score.gte"] !== undefined) {
    checkUnitInterval(when["agent.evidence_score.gte"], `${path}["agent.evidence_score.gte"]`);
  }
  if (when["agent.risk_level.lte"] !== undefined) {
    const v = when["agent.risk_level.lte"];
    if (v !== "low" && v !== "medium" && v !== "high" && v !== "critical") {
      fail(
        `${path}["agent.risk_level.lte"] must be one of low, medium, high, critical`,
        `${path}["agent.risk_level.lte"]`,
      );
    }
  }
  if (when["agent.tx_count_in_window"] !== undefined) {
    const c = when["agent.tx_count_in_window"];
    if (c === null || typeof c !== "object" || Array.isArray(c)) {
      fail(
        `${path}["agent.tx_count_in_window"] must be an object ({ window, lte })`,
        `${path}["agent.tx_count_in_window"]`,
      );
    }
    const cc = c as Record<string, unknown>;
    checkWindow(cc.window, `${path}["agent.tx_count_in_window"].window`);
    if (!Number.isInteger(cc.lte) || (cc.lte as number) < 0) {
      fail(
        `${path}["agent.tx_count_in_window"].lte must be an integer >= 0`,
        `${path}["agent.tx_count_in_window"].lte`,
      );
    }
  }
  if (when["agent.spend_in_window"] !== undefined) {
    const c = when["agent.spend_in_window"];
    if (c === null || typeof c !== "object" || Array.isArray(c)) {
      fail(
        `${path}["agent.spend_in_window"] must be an object ({ window, lte })`,
        `${path}["agent.spend_in_window"]`,
      );
    }
    const cc = c as Record<string, unknown>;
    checkWindow(cc.window, `${path}["agent.spend_in_window"].window`);
    checkAmountLiteral(cc.lte, `${path}["agent.spend_in_window"].lte`);
  }
  if (when.time_window !== undefined) {
    if (typeof when.time_window !== "string") {
      fail(`${path}.time_window must be a cron-expression string`, `${path}.time_window`);
    }
    try {
      validateCronExpression(when.time_window);
    } catch (err) {
      fail(`${path}.time_window ${(err as Error).message}`, `${path}.time_window`);
    }
  }
}

function validateRule(
  raw: unknown,
  index: number,
  seenIds: Set<string>,
  lists: Readonly<Record<string, ReadonlyArray<string>>>,
): void {
  const path = `rules[${index}]`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`${path} must be an object`, path);
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.id !== "string" || r.id.length === 0) {
    fail(`${path}.id must be a non-empty string`, `${path}.id`);
  }
  if (seenIds.has(r.id)) {
    // A duplicate id makes findRule() in service.ts return the wrong rule for
    // a matched_rule_id, which corrupts the proof artifact amount_upper_bound
    // and the autonomous-cap fields the section 6 gate reads.
    fail(
      `duplicate rule id "${r.id}" -- rule ids must be unique in a policy document`,
      `${path}.id`,
    );
  }
  seenIds.add(r.id);

  if (!Array.isArray(r.applies_to) || r.applies_to.length === 0) {
    fail(`${path}.applies_to must be a non-empty array`, `${path}.applies_to`);
  }
  for (const value of r.applies_to) {
    if (typeof value !== "string" || !APPLY_TO_VALUES.has(value)) {
      fail(
        `${path}.applies_to has unknown value "${String(value)}" (expected one of ${[...APPLY_TO_VALUES].join(", ")})`,
        `${path}.applies_to`,
      );
    }
  }

  if (r.when === null || typeof r.when !== "object" || Array.isArray(r.when)) {
    fail(`${path}.when must be a non-null object`, `${path}.when`);
  }
  const when = r.when as Record<string, unknown>;
  for (const key of Object.keys(when)) {
    if (!KNOWN_WHEN_KEYS.has(key as keyof RuleWhen)) {
      fail(
        `${path}.when has unknown key "${key}" (known keys: ${[...KNOWN_WHEN_KEYS].join(", ")})`,
        `${path}.when.${key}`,
      );
    }
  }
  validateWhen(when, `${path}.when`, lists);

  if (r.execute !== "auto" && r.execute !== "confirm" && r.execute !== "reject") {
    fail(`${path}.execute must be one of auto, confirm, reject`, `${path}.execute`);
  }

  if (r.require !== undefined) {
    if (typeof r.require !== "string" || r.require.length === 0) {
      fail(`${path}.require must be a non-empty string`, `${path}.require`);
    }
    const roles = parseRequire(r.require);
    if (roles.length === 0 || roles.some((role) => role.length === 0)) {
      fail(
        `${path}.require "${r.require}" does not resolve to a non-empty list of role names`,
        `${path}.require`,
      );
    }
  }

  if (r.approval_required_above !== undefined) {
    checkAmountLiteral(r.approval_required_above, `${path}.approval_required_above`);
  }
  if (r.x402_autonomous_max_amount !== undefined) {
    checkAmountLiteral(r.x402_autonomous_max_amount, `${path}.x402_autonomous_max_amount`);
  }
  if (r.ach_autonomous_max_amount !== undefined) {
    checkAmountLiteral(r.ach_autonomous_max_amount, `${path}.ach_autonomous_max_amount`);
  }
  if (r.card_autonomous_max_amount !== undefined) {
    checkAmountLiteral(r.card_autonomous_max_amount, `${path}.card_autonomous_max_amount`);
  }
}

function validateLists(raw: unknown): Readonly<Record<string, ReadonlyArray<string>>> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("lists must be an object", "lists");
  }
  const obj = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      fail(`lists.${key} must be an array of strings`, `lists.${key}`);
    }
  }
  return obj as Record<string, ReadonlyArray<string>>;
}

function validateAgentActions(raw: unknown): void {
  if (raw === undefined) return;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("agent_actions must be an object", "agent_actions");
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    checkStringArray(value, `agent_actions.${key}`);
  }
}

/** Placeholder syntax the templates use, e.g. two-brace {name}. */
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function validateMessageTemplates(raw: unknown): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) fail("message_templates must be an array", "message_templates");
  raw.forEach((tpl, i) => {
    const path = `message_templates[${i}]`;
    if (tpl === null || typeof tpl !== "object" || Array.isArray(tpl)) {
      fail(`${path} must be an object`, path);
    }
    const t = tpl as Record<string, unknown>;
    checkNonEmptyString(t.id, `${path}.id`);
    checkNonEmptyString(t.subject, `${path}.subject`);
    checkNonEmptyString(t.body, `${path}.body`);
    checkStringArray(t.allowed_variables, `${path}.allowed_variables`);
    const allowed = new Set(t.allowed_variables as string[]);
    // The renderer only substitutes allowed_variables; an unlisted
    // placeholder would ship literal double-brace text to a counterparty.
    for (const field of ["subject", "body"] as const) {
      for (const match of (t[field] as string).matchAll(PLACEHOLDER_RE)) {
        const name = match[1]!;
        if (!allowed.has(name)) {
          fail(
            `${path}.${field} references placeholder {{${name}}} which is not in allowed_variables`,
            `${path}.${field}`,
          );
        }
      }
    }
  });
}

export function validatePolicyDocument(raw: unknown): PolicyDocument {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("policy content must be a non-null object", "$");
  }
  const doc = raw as Record<string, unknown>;

  if (!Number.isInteger(doc.version) || (doc.version as number) < 1) {
    fail("version must be an integer >= 1", "version");
  }
  if (!Array.isArray(doc.rules) || doc.rules.length === 0) {
    fail("rules must be a non-empty array", "rules");
  }

  const lists = validateLists(doc.lists);
  validateAgentActions(doc.agent_actions);
  validateMessageTemplates(doc.message_templates);

  const seenIds = new Set<string>();
  doc.rules.forEach((rule, i) => validateRule(rule, i, seenIds, lists));

  return raw as PolicyDocument;
}
