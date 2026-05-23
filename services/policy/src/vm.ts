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
  // --- Agent Autonomy v3 (1b.5) context. The VM stays pure: the caller loads
  // the agent's window aggregates (from policy_spend_counters) and the runtime
  // behaviorHash, then passes them in so evaluation is deterministic. ---
  agent_id?: string | null;
  tenant_category?: "business" | "consumer" | null;
  action_id?: string | null;
  behavior_hash?: string | null;
  /** Prior spend per window (this action NOT yet counted), e.g. {"24h": {currency,value}}. */
  spend_in_window?: Readonly<Record<string, { currency: string; value: string }>>;
  /** Prior tx count per window (this action NOT yet counted). */
  tx_count_in_window?: Readonly<Record<string, number>>;
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
      let approvers = rule.require === undefined ? [] : parseRequire(rule.require);
      let outcome = mapExecute(rule.execute, approvers.length > 0);
      // approval_required_above: force confirm when the amount exceeds the
      // threshold, even if the rule would otherwise allow (1b.5).
      if (
        rule.approval_required_above !== undefined &&
        outcome === "allow" &&
        action.amount !== null &&
        action.amount.currency === rule.approval_required_above.currency &&
        compareDecimal(action.amount.value, rule.approval_required_above.value) > 0
      ) {
        outcome = "confirm";
        if (approvers.length === 0) approvers = ["signer"];
      }
      return {
        outcome,
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

  // --- Agent Autonomy v3 (1b.5) primitives ---
  if (w["agent.id"] !== undefined) {
    const passed = action.agent_id === w["agent.id"];
    checks.push({ key: "agent.id", passed, detail: w["agent.id"] });
    if (!passed) return { matched: false, checks };
  }
  if (w["tenant.category"] !== undefined) {
    const passed = action.tenant_category === w["tenant.category"];
    checks.push({ key: "tenant.category", passed, detail: w["tenant.category"] });
    if (!passed) return { matched: false, checks };
  }
  if (w["action.in"] !== undefined) {
    const passed = action.action_id !== null && w["action.in"].includes(action.action_id ?? "");
    checks.push({ key: "action.in", passed, detail: w["action.in"].join(",") });
    if (!passed) return { matched: false, checks };
  }
  if (w["action.not_in"] !== undefined) {
    const passed =
      action.action_id === null ||
      action.action_id === undefined ||
      !w["action.not_in"].includes(action.action_id);
    checks.push({ key: "action.not_in", passed, detail: w["action.not_in"].join(",") });
    if (!passed) return { matched: false, checks };
  }
  if (w["agent.behaviorHash"] !== undefined) {
    const passed = action.behavior_hash === w["agent.behaviorHash"];
    checks.push({ key: "agent.behaviorHash", passed, detail: w["agent.behaviorHash"] });
    if (!passed) return { matched: false, checks };
  }
  if (w["agent.spend_in_window"] !== undefined) {
    const c = w["agent.spend_in_window"];
    const prior = action.spend_in_window?.[c.window];
    // Within envelope iff prior spend + this action's amount <= lte (same currency).
    // The envelope is denominated in a single currency. An action in a different
    // currency cannot be proven within-envelope without conversion, so fail closed
    // rather than treating its spend as zero — a foreign-currency action contributing
    // "0" would otherwise slip past the limit entirely.
    const amt = action.amount;
    const sameCurrency = amt !== null && amt.currency === c.lte.currency;
    const priorValue = prior !== undefined && prior.currency === c.lte.currency ? prior.value : "0";
    const projected = sameCurrency ? addDecimal(priorValue, amt.value) : priorValue;
    const passed = sameCurrency && compareDecimal(projected, c.lte.value) <= 0;
    checks.push({
      key: "agent.spend_in_window",
      passed,
      detail: `${c.window}<=${c.lte.currency} ${c.lte.value}`,
    });
    if (!passed) return { matched: false, checks };
  }
  if (w["agent.tx_count_in_window"] !== undefined) {
    const c = w["agent.tx_count_in_window"];
    const prior = action.tx_count_in_window?.[c.window] ?? 0;
    const passed = prior + 1 <= c.lte;
    checks.push({ key: "agent.tx_count_in_window", passed, detail: `${c.window}<=${c.lte}` });
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

/**
 * Add two stringified decimals without floating-point error (18 frac digits).
 * Used for spend-envelope projection (prior window spend + this action).
 */
export function addDecimal(a: string, b: string): string {
  const na = normalizeDecimal(a);
  const nb = normalizeDecimal(b);
  const sa = (na.negative ? -1n : 1n) * BigInt(na.int + na.frac);
  const sb = (nb.negative ? -1n : 1n) * BigInt(nb.int + nb.frac);
  const sum = sa + sb;
  const neg = sum < 0n;
  const abs = (neg ? -sum : sum).toString().padStart(19, "0");
  const intPart = abs.slice(0, abs.length - 18).replace(/^0+/, "") || "0";
  const fracPart = abs.slice(abs.length - 18).replace(/0+$/, "");
  const body = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  return neg ? `-${body}` : body;
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
