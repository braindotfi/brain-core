import type { AuditEmitter } from "@brain/api/shared";
import type { Pool } from "pg";
import type { RailRegistry } from "./rails/stubs.js";

export interface ExecutionDeps {
  pool: Pool;
  audit: AuditEmitter;
  rails: RailRegistry;
  /** HTTP client to the policy service for evaluate. Stubbable in tests. */
  evaluatePolicy: (
    tenantId: string,
    action: Record<string, unknown>,
  ) => Promise<{
    outcome: "allow" | "confirm" | "reject";
    matched_rule_id: string | null;
    required_approvers: string[];
    trace: unknown[];
    policy_version: number;
  }>;
}
