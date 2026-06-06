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
  } else {
    reasons.push(`status is ${JSON.stringify(doc["status"])}, not "approved"`);
  }

  return { approved: reasons.length === 0, reasons };
}
