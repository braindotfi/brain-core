/**
 * H-18 policy diff — semantic diff between two policy versions.
 *
 * Pure. Matches rules by id; reports added / removed / modified, and for a
 * modified rule lists which fields changed (applies_to, when.*, require,
 * execute, approval_required_above). Field comparison is by canonical JSON so
 * key order never produces a false positive.
 */

import type { PolicyDocument, PolicyRule } from "./dsl.js";

export interface RuleFieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface ModifiedRule {
  id: string;
  changes: RuleFieldChange[];
}

export interface PolicyDiff {
  added: PolicyRule[];
  removed: PolicyRule[];
  modified: ModifiedRule[];
}

function canon(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canon(obj[k])}`)
    .join(",")}}`;
}

function ruleFields(rule: PolicyRule): Record<string, unknown> {
  return {
    applies_to: rule.applies_to,
    when: rule.when,
    require: rule.require,
    execute: rule.execute,
    approval_required_above: rule.approval_required_above,
  };
}

function diffRule(from: PolicyRule, to: PolicyRule): RuleFieldChange[] {
  const a = ruleFields(from);
  const b = ruleFields(to);
  const changes: RuleFieldChange[] = [];
  for (const field of Object.keys(a)) {
    if (canon(a[field]) !== canon(b[field])) {
      changes.push({ field, from: a[field] ?? null, to: b[field] ?? null });
    }
  }
  return changes;
}

export function diffPolicies(from: PolicyDocument, to: PolicyDocument): PolicyDiff {
  const fromById = new Map(from.rules.map((r) => [r.id, r]));
  const toById = new Map(to.rules.map((r) => [r.id, r]));

  const added = to.rules.filter((r) => !fromById.has(r.id));
  const removed = from.rules.filter((r) => !toById.has(r.id));
  const modified: ModifiedRule[] = [];
  for (const [id, fromRule] of fromById) {
    const toRule = toById.get(id);
    if (toRule === undefined) continue;
    const changes = diffRule(fromRule, toRule);
    if (changes.length > 0) modified.push({ id, changes });
  }

  return { added, removed, modified };
}
