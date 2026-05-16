/**
 * Policy rule VM.
 *
 * Evaluates the 6 MVP primitives against an incoming Action and returns
 * a Decision with a trace. Deterministic — property tests hammer this
 * module in fast-check to look for edge cases the spec didn't enumerate.
 */

import type { ApplyTo, ExecuteMode, PolicyDocument, PolicyRule, RuleWhen } from "./dsl.js";

export interface Action {
  kind: ApplyTo;
  counterparty_id: string | null;
  amount: { currency: string; value: string } | null;
  agent_role: string | null;
  timestamp: Date;
}

export interface Decision {
  outcome: "allow" | "confirm" | "reject";
  matched_rule_id: string | null;
  required_approvers: string[];
  trace: DecisionTrace[];
}

export interface DecisionTrace {
  rule_id: string;
  matched: boolean;
  checks: Array<{ key: keyof RuleWhen; passed: boolean; detail?: string }>;
}

export function evaluate(policy: PolicyDocument, action: Action): Decision {
  const trace: DecisionTrace[] = [];
  for (const rule of policy.rules) {
    const { matched, checks } = matchRule(policy, rule, action);
    trace.push({ rule_id: rule.id, matched, checks });
    if (matched) {
      const approvers = rule.require === undefined ? [] : parseRequire(rule.require);
      return {
        outcome: mapExecute(rule.execute, approvers.length > 0),
        matched_rule_id: rule.id,
        required_approvers: approvers,
        trace,
      };
    }
  }
  // No rule matched. Default-deny keeps the policy layer safe.
  return {
    outcome: "reject",
    matched_rule_id: null,
    required_approvers: [],
    trace,
  };
}

function matchRule(
  policy: PolicyDocument,
  rule: PolicyRule,
  action: Action,
): { matched: boolean; checks: DecisionTrace["checks"] } {
  const checks: DecisionTrace["checks"] = [];

  // applies_to gate
  if (!rule.applies_to.includes("any") && !rule.applies_to.includes(action.kind)) {
    return { matched: false, checks };
  }

  const w = rule.when;
  if (w["counterparty.in"] !== undefined) {
    const list = policy.lists?.[w["counterparty.in"]] ?? [];
    const passed = action.counterparty_id !== null && list.includes(action.counterparty_id);
    checks.push({ key: "counterparty.in", passed, detail: w["counterparty.in"] });
    if (!passed) return { matched: false, checks };
  }
  if (w["counterparty.not_in"] !== undefined) {
    const list = policy.lists?.[w["counterparty.not_in"]] ?? [];
    const passed = action.counterparty_id === null || !list.includes(action.counterparty_id);
    checks.push({ key: "counterparty.not_in", passed, detail: w["counterparty.not_in"] });
    if (!passed) return { matched: false, checks };
  }
  if (w["amount.lte"] !== undefined) {
    const bound = w["amount.lte"];
    const passed =
      action.amount !== null &&
      action.amount.currency === bound.currency &&
      compareDecimal(action.amount.value, bound.value) <= 0;
    checks.push({ key: "amount.lte", passed, detail: `${bound.currency} ${bound.value}` });
    if (!passed) return { matched: false, checks };
  }
  if (w["amount.gt"] !== undefined) {
    const bound = w["amount.gt"];
    const passed =
      action.amount !== null &&
      action.amount.currency === bound.currency &&
      compareDecimal(action.amount.value, bound.value) > 0;
    checks.push({ key: "amount.gt", passed, detail: `${bound.currency} ${bound.value}` });
    if (!passed) return { matched: false, checks };
  }
  if (w["agent.role"] !== undefined) {
    const passed = action.agent_role === w["agent.role"];
    checks.push({ key: "agent.role", passed, detail: w["agent.role"] });
    if (!passed) return { matched: false, checks };
  }
  if (w.time_window !== undefined) {
    const passed = matchesCron(w.time_window, action.timestamp);
    checks.push({ key: "time_window", passed, detail: w.time_window });
    if (!passed) return { matched: false, checks };
  }

  return { matched: true, checks };
}

function mapExecute(mode: ExecuteMode, hasApprovers: boolean): Decision["outcome"] {
  if (mode === "reject") return "reject";
  if (mode === "auto") return hasApprovers ? "confirm" : "allow";
  if (mode === "confirm") return "confirm";
  return "reject";
}

/**
 * Parse a `require` clause: "single_signer", "<role>_approval", or
 * "<role>_and_<role>". Returns the role list.
 */
export function parseRequire(expr: string): string[] {
  if (expr === "single_signer") return ["signer"];
  if (expr.endsWith("_approval")) return [expr.slice(0, -"_approval".length)];
  if (expr.includes("_and_")) {
    return expr.split("_and_").filter((s) => s.length > 0);
  }
  // Unknown shape — fail closed.
  return [expr];
}

/**
 * Compare two stringified decimal numbers without floating-point error.
 * Handles optional leading '-' and up to 18 decimal places.
 * Returns -1/0/1 like String.prototype.localeCompare.
 */
export function compareDecimal(a: string, b: string): number {
  const na = normalizeDecimal(a);
  const nb = normalizeDecimal(b);
  if (na.negative !== nb.negative) return na.negative ? -1 : 1;
  const intCmp = compareBigNumeric(na.int, nb.int);
  if (intCmp !== 0) return na.negative ? -intCmp : intCmp;
  const fracCmp = compareBigNumeric(na.frac, nb.frac);
  return na.negative ? -fracCmp : fracCmp;
}

interface NormalizedDecimal {
  negative: boolean;
  int: string; // digits only, no leading zeros
  frac: string; // digits only, right-padded to length 18
}

function normalizeDecimal(s: string): NormalizedDecimal {
  let str = s.trim();
  const negative = str.startsWith("-");
  if (negative) str = str.slice(1);
  const [intPartRaw, fracPartRaw = ""] = str.split(".");
  const intPart = (intPartRaw ?? "").replace(/^0+/, "") || "0";
  const frac = fracPartRaw.padEnd(18, "0").slice(0, 18);
  return { negative, int: intPart, frac };
}

function compareBigNumeric(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Minimal cron matcher. MVP supports 5-field cron with * and literal numbers
 * (plus comma lists). Real cron semantics (ranges, steps, named months) are
 * post-MVP. The spec hint is "time_window: <cron_expr>" — we honor the
 * tight subset that covers the design-partner interview patterns.
 */
export function matchesCron(expr: string, at: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hr, dom, mon, dow] = parts;
  const utc = at; // policies evaluated in UTC; callers must align tz
  return (
    matchField(min ?? "*", utc.getUTCMinutes()) &&
    matchField(hr ?? "*", utc.getUTCHours()) &&
    matchField(dom ?? "*", utc.getUTCDate()) &&
    matchField(mon ?? "*", utc.getUTCMonth() + 1) &&
    matchField(dow ?? "*", utc.getUTCDay())
  );
}

function matchField(field: string, value: number): boolean {
  if (field === "*") return true;
  for (const token of field.split(",")) {
    const n = Number.parseInt(token, 10);
    if (Number.isFinite(n) && n === value) return true;
  }
  return false;
}
