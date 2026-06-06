/**
 * Canonical validator for `contracts/audit-status.json` (TypeScript port).
 *
 * This is the single source of truth for the runtime consumer that ships in the
 * production image (which contains `dist/` but not `scripts/`):
 *   - services/api/src/composition/escrow-audit-gate.ts (mainnet escrow boot fence)
 *
 * The lint-time consumers run BEFORE the workspace is built (so they cannot
 * import `@brain/shared/dist`) and use the byte-equivalent `.mjs` port at
 * `scripts/lib/audit-status.mjs`:
 *   - scripts/check-audit-status.mjs   (CI integrity guard)
 *   - scripts/production-readiness.mjs  (pre-deploy readiness aggregator)
 *
 * The two ports are pinned to identical behaviour by a shared parity corpus
 * (`scripts/lib/audit-status.fixtures.json`) that BOTH test suites assert
 * against, so neither can silently drift from the other.
 *
 * Pure + dependency-free: no file IO. The caller reads the file and passes the
 * raw string (or a pre-parsed value) in.
 */

export const AUDIT_STATUSES = ["pending", "in_progress", "approved"] as const;
export type AuditStatusValue = (typeof AUDIT_STATUSES)[number];

export const AUDIT_REQUIRED_KEYS = [
  "contract",
  "scope_doc",
  "status",
  "auditor",
  "audited_commit",
  "report_url",
  "report_sha256",
  "unresolved_findings",
] as const;

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export interface ParseResult {
  ok: boolean;
  doc: unknown;
  error: string | null;
}

export interface IntegrityResult {
  ok: boolean;
  reasons: string[];
}

export interface ApprovalResult {
  approved: boolean;
  reasons: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function isNonNegInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isSha256(v: unknown): boolean {
  return typeof v === "string" && SHA256_RE.test(v);
}

function compilerReasons(c: unknown): string[] {
  if (!isObject(c)) return ['status "approved" requires a compiler object'];
  const out: string[] = [];
  if (!isNonEmptyString(c["solc_version"]))
    out.push('status "approved" requires compiler.solc_version');
  if (typeof c["optimizer_enabled"] !== "boolean")
    out.push('status "approved" requires compiler.optimizer_enabled (boolean)');
  if (!isNonNegInt(c["optimizer_runs"]))
    out.push('status "approved" requires compiler.optimizer_runs (non-negative integer)');
  if (!isNonEmptyString(c["evm_version"]))
    out.push('status "approved" requires compiler.evm_version');
  return out;
}

function isApprovedChainIds(ids: unknown): ids is number[] {
  return (
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.every((n) => typeof n === "number" && Number.isInteger(n) && n > 0)
  );
}

/**
 * Whether `chainId` is among the chain ids the audit authorizes. The runtime
 * escrow fence uses this so an approved audit for Base mainnet cannot be
 * stretched to authorize escrow on a different chain.
 */
export function isChainApproved(doc: unknown, chainId: number): boolean {
  if (!isObject(doc)) return false;
  const ids = doc["approved_chain_ids"];
  return isApprovedChainIds(ids) && ids.includes(chainId);
}

/**
 * Parse a raw audit-status value. Accepts a JSON string or an already-parsed
 * object. Returns `{ ok, doc, error }`; never throws.
 */
export function parseAuditStatus(raw: unknown): ParseResult {
  if (typeof raw === "string") {
    try {
      return { ok: true, doc: JSON.parse(raw), error: null };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, doc: null, error: `invalid JSON: ${message}` };
    }
  }
  if (isObject(raw)) {
    return { ok: true, doc: raw, error: null };
  }
  return {
    ok: false,
    doc: null,
    error: "audit-status input is neither a JSON string nor an object",
  };
}

/**
 * Structural integrity: required keys present, status in the allowed set, and
 * `unresolved_findings` shaped as non-negative-integer-or-null counts.
 * Independent of approval.
 */
export function checkIntegrity(doc: unknown): IntegrityResult {
  if (!isObject(doc)) {
    return { ok: false, reasons: ["audit-status document is not an object"] };
  }
  const reasons: string[] = [];

  for (const k of AUDIT_REQUIRED_KEYS) {
    if (!(k in doc)) reasons.push(`missing required key: ${k}`);
  }

  if (!(AUDIT_STATUSES as readonly string[]).includes(doc["status"] as string)) {
    reasons.push(
      `status must be one of ${AUDIT_STATUSES.join(" | ")}, got ${JSON.stringify(doc["status"])}`,
    );
  }

  const uf = doc["unresolved_findings"];
  if (!isObject(uf)) {
    reasons.push("unresolved_findings must be an object with critical/high/medium/low");
  } else {
    for (const sev of SEVERITIES) {
      const v = uf[sev];
      if (v !== null && !isNonNegInt(v)) {
        reasons.push(`unresolved_findings.${sev} must be null or a non-negative integer`);
      }
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Whether the record authorizes a mainnet (deployment) escrow boot. Fail-closed:
 * the document must be structurally valid AND status "approved" AND carry the
 * full evidence set (auditor, 40-hex audited commit, a report reference, and
 * zero unresolved critical/high findings).
 */
export function evaluateApproval(doc: unknown): ApprovalResult {
  if (!isObject(doc)) {
    return { approved: false, reasons: ["audit-status document is not an object"] };
  }

  const reasons = checkIntegrity(doc).reasons.slice();

  if (doc["status"] === "approved") {
    if (!isNonEmptyString(doc["auditor"])) {
      reasons.push('status "approved" requires a non-empty auditor');
    }
    const commit = doc["audited_commit"];
    if (typeof commit !== "string" || !SHA1_RE.test(commit)) {
      reasons.push('status "approved" requires audited_commit to be a 40-hex git SHA');
    }
    if (!isNonEmptyString(doc["report_url"]) && !isNonEmptyString(doc["report_sha256"])) {
      reasons.push('status "approved" requires a report_url or a report_sha256');
    }
    const uf = doc["unresolved_findings"];
    if (isObject(uf)) {
      if (uf["critical"] !== 0) {
        reasons.push('status "approved" requires unresolved_findings.critical === 0');
      }
      if (uf["high"] !== 0) {
        reasons.push('status "approved" requires unresolved_findings.high === 0');
      }
    }
    // Build-evidence binding (P1: pin approval to the exact audited build).
    // Approval must name the source tree, compiler, and creation+runtime
    // bytecode that were audited, plus the chain ids the audit authorizes, so a
    // later contract or toolchain change cannot ride an older approval.
    if (!isSha256(doc["contract_source_tree_sha256"])) {
      reasons.push('status "approved" requires contract_source_tree_sha256 to be a 64-hex sha256');
    }
    if (!isSha256(doc["creation_bytecode_sha256"])) {
      reasons.push('status "approved" requires creation_bytecode_sha256 to be a 64-hex sha256');
    }
    if (!isSha256(doc["runtime_bytecode_sha256"])) {
      reasons.push('status "approved" requires runtime_bytecode_sha256 to be a 64-hex sha256');
    }
    for (const r of compilerReasons(doc["compiler"])) reasons.push(r);
    if (!isApprovedChainIds(doc["approved_chain_ids"])) {
      reasons.push(
        'status "approved" requires a non-empty approved_chain_ids array of positive integers',
      );
    }
  } else {
    reasons.push(`status is ${JSON.stringify(doc["status"])}, not "approved"`);
  }

  return { approved: reasons.length === 0, reasons };
}
