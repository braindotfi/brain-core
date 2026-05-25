/**
 * H-18 policy linter — catch dangerous policy before it is signed.
 *
 * Pure over a PolicyDocument. Rules map to the Brain DSL where a primitive
 * exists; where the spec references a concept the DSL has no primitive for
 * (a "verified counterparty" flag, a per-rule risk level), the closest faithful
 * proxy is used and noted: an auto money-mover is required to scope its
 * counterparty via a `counterparty.in` allowlist, and to bound risk via the
 * `agent.risk_level.lte` primitive (H-16) when present.
 *
 * "Rule matched zero actions in last 30 days" is data-dependent, so it is only
 * evaluated when the route supplies `recentMatchCounts` (from a DB count).
 */

import { compareDecimal } from "./vm.js";
import type { AmountLiteral, ApplyTo, PolicyDocument, PolicyRule } from "./dsl.js";

export type LintSeverity = "ERROR" | "WARN";

export interface LintFinding {
  code: string;
  severity: LintSeverity;
  rule_id: string | null;
  message: string;
}

export interface LintOptions {
  /** Currencies the tenant transacts in; defaults to a common fiat + chain set. */
  supportedCurrencies?: ReadonlyArray<string>;
  /** Valid approver roles; defaults to the user-role set + signer. */
  knownRoles?: ReadonlyArray<string>;
  /** Per-rule match counts over the trailing window (rule_id → count). */
  recentMatchCounts?: Readonly<Record<string, number>>;
  /** Threshold above which an approval path is required (default USD 10000). */
  highValueThreshold?: AmountLiteral;
}

const DEFAULT_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "ETH", "USDC", "USDT"];
const DEFAULT_ROLES = ["owner", "admin", "approver", "signer", "finance", "controller"];
const MONEY_MOVEMENT: ReadonlyArray<ApplyTo> = ["outbound_payment", "onchain_tx", "any"];

function isMoneyMover(rule: PolicyRule): boolean {
  return rule.applies_to.some((a) => MONEY_MOVEMENT.includes(a));
}
function isAuto(rule: PolicyRule): boolean {
  return rule.execute === "auto";
}
function hasAmountCap(rule: PolicyRule): boolean {
  return rule.when["amount.lte"] !== undefined || rule.approval_required_above !== undefined;
}
function hasCounterpartyConstraint(rule: PolicyRule): boolean {
  return (
    rule.when["counterparty.in"] !== undefined || rule.when["counterparty.not_in"] !== undefined
  );
}
/** Loose read of the H-16 risk primitive so the linter doesn't hard-depend on it. */
function riskConstraint(rule: PolicyRule): string | undefined {
  const v = (rule.when as Record<string, unknown>)["agent.risk_level.lte"];
  return typeof v === "string" ? v : undefined;
}
function parseRoles(require: string | undefined): string[] {
  if (require === undefined) return [];
  if (require === "single_signer") return ["signer"];
  if (require.endsWith("_approval")) return [require.slice(0, -"_approval".length)];
  if (require.includes("_and_")) return require.split("_and_").filter((s) => s.length > 0);
  return [require];
}

export function lintPolicy(doc: PolicyDocument, opts: LintOptions = {}): LintFinding[] {
  const currencies = new Set(opts.supportedCurrencies ?? DEFAULT_CURRENCIES);
  const roles = new Set(opts.knownRoles ?? DEFAULT_ROLES);
  const threshold = opts.highValueThreshold ?? { currency: "USD", value: "10000" };
  const findings: LintFinding[] = [];
  const add = (
    severity: LintSeverity,
    code: string,
    rule_id: string | null,
    message: string,
  ): void => {
    findings.push({ severity, code, rule_id, message });
  };

  // Track a catch-all (matches everything) for the unreachable-rule check.
  let catchAllSeen: string | null = null;

  for (const rule of doc.rules) {
    const auto = isAuto(rule);
    const mover = isMoneyMover(rule);

    if (auto && mover && !hasAmountCap(rule)) {
      add(
        "ERROR",
        "auto_no_amount_cap",
        rule.id,
        "Auto-execute money-movement rule has no amount cap (amount.lte / approval_required_above).",
      );
    }
    if (auto && mover && !hasCounterpartyConstraint(rule)) {
      add(
        "ERROR",
        "auto_no_counterparty_constraint",
        rule.id,
        "Auto-execute money-movement rule has no counterparty constraint.",
      );
    }
    // "Verified-counterparty requirement" proxy: an auto mover must scope to a
    // trusted allowlist (counterparty.in), not merely a blocklist.
    if (auto && mover && rule.when["counterparty.in"] === undefined) {
      add(
        "ERROR",
        "auto_no_verified_counterparty",
        rule.id,
        "Auto-execute money-movement rule must restrict to a trusted counterparty allowlist (counterparty.in).",
      );
    }
    // Approval path required above the high-value threshold.
    const cap = rule.when["amount.lte"];
    const exceedsThreshold =
      cap === undefined ||
      (cap.currency === threshold.currency && compareDecimal(cap.value, threshold.value) > 0);
    if (
      auto &&
      mover &&
      exceedsThreshold &&
      rule.require === undefined &&
      rule.approval_required_above === undefined
    ) {
      add(
        "ERROR",
        "no_approval_path_high_value",
        rule.id,
        `Rule can auto-execute above ${threshold.currency} ${threshold.value} with no approval path.`,
      );
    }
    // Unsupported currency anywhere in the rule.
    for (const lit of [
      rule.when["amount.lte"],
      rule.when["amount.gt"],
      rule.approval_required_above,
    ]) {
      if (lit !== undefined && !currencies.has(lit.currency)) {
        add(
          "ERROR",
          "unsupported_currency",
          rule.id,
          `References unsupported currency ${lit.currency}.`,
        );
      }
    }
    // Invalid approval role.
    for (const role of parseRoles(rule.require)) {
      if (!roles.has(role)) {
        add("ERROR", "invalid_approval_role", rule.id, `Unknown approver role "${role}".`);
      }
    }
    // Risk bound: an auto mover with no risk_level constraint when one is available.
    if (auto && mover && riskConstraint(rule) === undefined) {
      add(
        "ERROR",
        "auto_no_risk_bound",
        rule.id,
        "Auto-execute money-movement rule does not bound agent.risk_level.lte.",
      );
    }
    // Broad `any` rule with money movement auto-enabled.
    if (auto && rule.applies_to.includes("any")) {
      add(
        "ERROR",
        "broad_any_auto",
        rule.id,
        "Broad `any` rule auto-executes — scope applies_to narrowly.",
      );
    }
    // Unreachable: a rule after an earlier catch-all can never match.
    if (catchAllSeen !== null) {
      add(
        "WARN",
        "unreachable_rule",
        rule.id,
        `Rule is unreachable — subsumed by earlier catch-all rule "${catchAllSeen}".`,
      );
    }
    if (rule.applies_to.includes("any") && Object.keys(rule.when).length === 0) {
      catchAllSeen ??= rule.id;
    }
    // Zero recent matches (data-dependent; only when counts supplied).
    if (opts.recentMatchCounts !== undefined && (opts.recentMatchCounts[rule.id] ?? 0) === 0) {
      add(
        "WARN",
        "zero_recent_matches",
        rule.id,
        "Rule matched zero actions in the trailing window — possibly dead.",
      );
    }
  }

  return findings;
}
