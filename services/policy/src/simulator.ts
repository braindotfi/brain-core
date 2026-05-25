/**
 * H-18 policy simulator — replay historical actions against a candidate policy.
 *
 * Pure: the route fetches every PaymentIntent + proposal in the period, maps
 * each to a VM `Action`, and passes them here. No DB, no writes — so a CFO can
 * see exactly what a new policy WOULD have done before signing it, plus a diff
 * against the currently-active policy.
 *
 * The DB fetch + Action mapping live in the route (services/policy/src/routes.ts)
 * and need Postgres to verify end to end (blocked in the sandbox); this replay
 * core is unit-tested directly.
 */

import { evaluate, type Action } from "./vm.js";
import type { PolicyDocument } from "./dsl.js";

/** One historical action to replay, with a stable id for the diff buckets. */
export interface ReplayAction {
  id: string;
  action: Action;
}

export interface SimulationResult {
  total: number;
  would_allow: number;
  would_confirm: number;
  would_reject: number;
  /** Compared to the active policy (omitted/empty buckets when no active policy). */
  diff_vs_active: {
    newly_allowed: string[];
    newly_rejected: string[];
    /** Outcome changed but not into allow/reject (e.g. allow→confirm). */
    changed_other: string[];
    unchanged: number;
  };
}

export function simulateHistorical(
  candidate: PolicyDocument,
  active: PolicyDocument | null,
  actions: ReadonlyArray<ReplayAction>,
): SimulationResult {
  let allow = 0;
  let confirm = 0;
  let reject = 0;
  const newly_allowed: string[] = [];
  const newly_rejected: string[] = [];
  const changed_other: string[] = [];
  let unchanged = 0;

  for (const { id, action } of actions) {
    const c = evaluate(candidate, action).outcome;
    if (c === "allow") allow += 1;
    else if (c === "confirm") confirm += 1;
    else reject += 1;

    if (active !== null) {
      const a = evaluate(active, action).outcome;
      if (a === c) {
        unchanged += 1;
      } else if (c === "allow") {
        newly_allowed.push(id);
      } else if (c === "reject") {
        newly_rejected.push(id);
      } else {
        changed_other.push(id);
      }
    }
  }

  return {
    total: actions.length,
    would_allow: allow,
    would_confirm: confirm,
    would_reject: reject,
    diff_vs_active: { newly_allowed, newly_rejected, changed_other, unchanged },
  };
}
