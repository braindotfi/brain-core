// Canonical validator for contracts/audit-status.json (.mjs port).
//
// This is the single source of truth for the lint-time consumers that run
// BEFORE the workspace is built (so they cannot import @brain/shared/dist):
//   - scripts/check-audit-status.mjs   (CI integrity guard, runs in `pnpm run lint`)
//   - scripts/production-readiness.mjs  (pre-deploy readiness aggregator)
//
// The runtime escrow boot fence (services/api/src/composition/escrow-audit-gate.ts)
// ships in the production image, which contains dist/ but NOT scripts/, so it
// uses the TYPE-SAFE port in shared/src/audit-status.ts. The two ports are kept
// byte-identical in behaviour by a shared parity corpus
// (scripts/lib/audit-status.fixtures.json) that both test suites assert against.
//
// Pure + dependency-free: no file IO, no node built-ins. Callers read the file.

export const STATUSES = ["pending", "in_progress", "approved"];

export const REQUIRED_KEYS = [
  "contract",
  "scope_doc",
  "status",
  "auditor",
  "audited_commit",
  "report_url",
  "report_sha256",
  "unresolved_findings",
];

const SEVERITIES = ["critical", "high", "medium", "low"];
const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isNonNegInt(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function compilerReasons(c) {
  if (!isObject(c)) return ['status "approved" requires a compiler object'];
  const out = [];
  if (!isNonEmptyString(c.solc_version))
    out.push('status "approved" requires compiler.solc_version');
  if (typeof c.optimizer_enabled !== "boolean")
    out.push('status "approved" requires compiler.optimizer_enabled (boolean)');
  if (!isNonNegInt(c.optimizer_runs))
    out.push('status "approved" requires compiler.optimizer_runs (non-negative integer)');
  if (!isNonEmptyString(c.evm_version))
    out.push('status "approved" requires compiler.evm_version');
  return out;
}

function isApprovedChainIds(ids) {
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
export function isChainApproved(doc, chainId) {
  if (!isObject(doc)) return false;
  const ids = doc.approved_chain_ids;
  return isApprovedChainIds(ids) && ids.includes(chainId);
}

/**
 * Parse a raw audit-status value. Accepts a JSON string or an already-parsed
 * object. Returns { ok, doc, error }; never throws.
 */
export function parseAuditStatus(raw) {
  if (typeof raw === "string") {
    try {
      return { ok: true, doc: JSON.parse(raw), error: null };
    } catch (err) {
      return { ok: false, doc: null, error: `invalid JSON: ${err.message}` };
    }
  }
  if (isObject(raw)) {
    return { ok: true, doc: raw, error: null };
  }
  return { ok: false, doc: null, error: "audit-status input is neither a JSON string nor an object" };
}

/**
 * Structural integrity: required keys present, status in the allowed set, and
 * unresolved_findings shaped as non-negative-integer-or-null counts. Independent
 * of approval. { ok, reasons }.
 */
export function checkIntegrity(doc) {
  if (!isObject(doc)) {
    return { ok: false, reasons: ["audit-status document is not an object"] };
  }
  const reasons = [];

  for (const k of REQUIRED_KEYS) {
    if (!(k in doc)) reasons.push(`missing required key: ${k}`);
  }

  if (!STATUSES.includes(doc.status)) {
    reasons.push(
      `status must be one of ${STATUSES.join(" | ")}, got ${JSON.stringify(doc.status)}`,
    );
  }

  const uf = doc.unresolved_findings;
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
 * zero unresolved critical/high findings). { approved, reasons }.
 */
export function evaluateApproval(doc) {
  if (!isObject(doc)) {
    return { approved: false, reasons: ["audit-status document is not an object"] };
  }

  const reasons = checkIntegrity(doc).reasons.slice();

  if (doc.status === "approved") {
    if (!isNonEmptyString(doc.auditor)) {
      reasons.push('status "approved" requires a non-empty auditor');
    }
    if (typeof doc.audited_commit !== "string" || !SHA1_RE.test(doc.audited_commit)) {
      reasons.push('status "approved" requires audited_commit to be a 40-hex git SHA');
    }
    if (!isNonEmptyString(doc.report_url) && !isNonEmptyString(doc.report_sha256)) {
      reasons.push('status "approved" requires a report_url or a report_sha256');
    }
    const uf = doc.unresolved_findings;
    if (isObject(uf)) {
      if (uf.critical !== 0) {
        reasons.push('status "approved" requires unresolved_findings.critical === 0');
      }
      if (uf.high !== 0) {
        reasons.push('status "approved" requires unresolved_findings.high === 0');
      }
    }
    // Build-evidence binding (P1: pin approval to the exact audited build).
    // Approval must name the source tree, compiler, and creation+runtime
    // bytecode that were audited, plus the chain ids the audit authorizes, so a
    // later contract or toolchain change cannot ride an older approval.
    if (!SHA256_RE.test(doc.contract_source_tree_sha256)) {
      reasons.push('status "approved" requires contract_source_tree_sha256 to be a 64-hex sha256');
    }
    if (!SHA256_RE.test(doc.creation_bytecode_sha256)) {
      reasons.push('status "approved" requires creation_bytecode_sha256 to be a 64-hex sha256');
    }
    if (!SHA256_RE.test(doc.runtime_bytecode_sha256)) {
      reasons.push('status "approved" requires runtime_bytecode_sha256 to be a 64-hex sha256');
    }
    for (const r of compilerReasons(doc.compiler)) reasons.push(r);
    if (!isApprovedChainIds(doc.approved_chain_ids)) {
      reasons.push(
        'status "approved" requires a non-empty approved_chain_ids array of positive integers',
      );
    }
  } else {
    reasons.push(`status is ${JSON.stringify(doc.status)}, not "approved"`);
  }

  return { approved: reasons.length === 0, reasons };
}
