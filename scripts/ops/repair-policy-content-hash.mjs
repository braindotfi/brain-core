/**
 * repair-policy-content-hash -- re-stamps `policies.content_hash` for rows
 * whose stored digest is not the canonical hash of `policies.content`.
 *
 * BACKGROUND. `content_hash` is supposed to be `contentHashHex(content)`:
 * sha256 over `canonicalize(doc)` (services/policy/src/dsl.ts), which
 * recursively sorts object keys before serializing. That digest is what the
 * EIP-712 signing payload commits to as `policyHash`
 * (services/policy/src/signing.ts's buildTypedData), and, as of commit
 * 6b544ed, what `getActive` (services/policy/src/repository.ts) recomputes
 * on every read -- it now THROWS `policy_not_active` on drift, deliberately
 * failing closed so an unsigned/tampered document can never reach the
 * section 6 gate.
 *
 * Two seeders (services/api/src/demo/brainsaas-seed.ts,
 * tools/seed-golden-path/src/cli.ts) used to write
 * `sha256(JSON.stringify(doc))` instead, which preserves key INSERTION order
 * rather than canonicalize()'s sorted order. Both are fixed as of 6b544ed,
 * but rows they already wrote to live databases still carry the old, wrong
 * digest -- and every one of those rows is a hard `policy_not_active` failure
 * the moment 6b544ed deploys. This script finds and repairs them.
 *
 * WHY THE LEGACY DIGEST CANNOT BE "VERIFIED" ANOTHER WAY. Both seeders passed
 * the JSON text as `$N::jsonb`, and Postgres jsonb normalizes object key
 * order on storage (by key length, then bytewise -- a third order, distinct
 * from both the original insertion order and canonicalize()'s lexicographic
 * order). The original insertion order is gone, so recomputing
 * `sha256(JSON.stringify(row.content))` on read cannot reproduce what was
 * stored either. `content` is the surviving truth; `content_hash` is what has
 * to be re-stamped from it, via the canonical hash function.
 *
 * WHY THIS NEEDS THE MIGRATION/OWNER DB ROLE, NOT DATABASE_URL's usual
 * runtime role. Commit 6b544ed's infra/db-roles.sql revoked blanket UPDATE on
 * `policies` from every runtime role (brain_app included) and re-granted only
 * `UPDATE (state, signers, activated_at, deactivated_at, onchain_tx,
 * onchain_version)`. `content_hash` is deliberately absent from that column
 * list -- no runtime connection can write it. Administrative repair through
 * the owner/migration role is the only path, by design.
 *
 * SAFETY RULE -- rows with `signers IS NOT NULL` are NEVER re-stamped, ever,
 * even with --apply. Those signatures were collected over the EIP-712 payload
 * committing to the STORED digest (services/policy/src/signing.ts). Silently
 * replacing content_hash underneath a signed row would make it present as
 * validly signed for a document hash nobody actually signed -- forging
 * agreement, which is worse than the outage this script exists to fix. Such
 * rows are reported separately as requiring manual re-signing (a fresh
 * compose-then-sign cycle) and force a non-zero exit. In practice, the
 * affected seeded rows all insert with signers absent from the column list
 * (so NULL) -- confirmed by reading both seeders' INSERT statements -- so the
 * normal repair path is unaffected.
 *
 * DRY RUN BY DEFAULT. Only `--apply` writes.
 *
 * EXIT CODES. 0 when nothing needs repair (or --apply repaired everything
 * repairable). Non-zero when a dry run finds outstanding repairs, or when any
 * signed-and-mismatched row exists regardless of --apply. This makes the
 * script usable as a pre-deploy gate: run with no args in CI and fail the
 * pipeline if repair hasn't happened yet.
 *
 * Scans EVERY row of `policies`, not just the active one -- a deactivated row
 * can be reactivated, and version history is read by the diff and simulate
 * routes, so a stale digest anywhere is still a latent failure.
 *
 * Plain ESM, not TypeScript, and run with plain `node`, not `pnpm exec tsx`:
 * every other `scripts/*.mjs` guard in this repo runs the same way, and doing
 * so here sidesteps a real local problem, not just a style choice -- tsx's
 * module resolver currently cannot resolve `@brain/shared` through this
 * checkout's workspace symlinks (confirmed against the pre-existing
 * scripts/ops/*.ts scripts too, so it is not new), while a plain `.mjs` under
 * scripts/ needs no such resolution step and just runs.
 *
 * Run (from repo root, against the migration/owner role):
 *   DATABASE_URL=<owner-role-url> node scripts/ops/repair-policy-content-hash.mjs
 *   DATABASE_URL=<owner-role-url> node scripts/ops/repair-policy-content-hash.mjs --apply
 */

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
// contentHashHex is imported, never re-implemented here: it is a
// security-relevant hash (the same one the EIP-712 signing payload and
// getActive's drift check use), and a second copy of canonicalize() would be
// free to silently drift from the one original.
import { contentHashHex } from "@brain/policy";

/**
 * A row scanned from `policies`.
 * @typedef {object} ScanRow
 * @property {string} id
 * @property {string} tenant_id
 * @property {number} version
 * @property {string} state
 * @property {object} content - the PolicyDocument (services/policy/src/dsl.ts)
 * @property {Buffer} content_hash
 * @property {unknown|null} signers - array of {address, signature} or null
 */

/**
 * The classification of one scanned row.
 * @typedef {object} RowClassification
 * @property {string} id
 * @property {string} tenant_id
 * @property {number} version
 * @property {string} state
 * @property {string} stored - stored content_hash as hex
 * @property {string} recomputed - canonical contentHashHex(content) as hex
 * @property {"canonical"|"repairable"|"blocked_signed"} status
 */

/**
 * Compare a scanned row's stored digest against the canonical recomputation.
 * @param {ScanRow} row
 * @returns {RowClassification}
 */
export function classifyRow(row) {
  const stored = Buffer.from(row.content_hash).toString("hex");
  const recomputed = contentHashHex(row.content);
  const status =
    recomputed === stored ? "canonical" : row.signers !== null ? "blocked_signed" : "repairable";
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    version: row.version,
    state: row.state,
    stored,
    recomputed,
    status,
  };
}

/** @param {RowClassification} c */
export function formatRow(c) {
  return `policy_id=${c.id} tenant_id=${c.tenant_id} version=${c.version} state=${c.state} stored=${c.stored} recomputed=${c.recomputed}`;
}

/**
 * Structural subset of pg's Pool/PoolClient this script needs -- lets tests
 * pass a plain stub object (any `{ query(text, params) }`) instead of a real
 * database connection.
 * @typedef {{ query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }} MinimalClient
 */

/**
 * Re-stamp content_hash for repairable rows only, one UPDATE per row scoped
 * by `WHERE id = $1` -- never a predicate-less write. Wrapped in a
 * transaction so a failure partway through never leaves some rows re-stamped
 * and others not; a half-repaired scan would hide which rows still need it.
 * @param {MinimalClient} client
 * @param {readonly RowClassification[]} repairable
 * @returns {Promise<number>}
 */
export async function applyRepairs(client, repairable) {
  if (repairable.length === 0) return 0;
  // Belt on the safety rule, not just a caller convention. main() filters to
  // `repairable`, but this is the one function that can overwrite a digest, and
  // passing a blocked_signed row through it would present that row as validly
  // signed for a hash nobody signed. Refuse rather than trust the caller.
  const notRepairable = repairable.filter((row) => row.status !== "repairable");
  if (notRepairable.length > 0) {
    throw new Error(
      `refusing to re-stamp ${notRepairable.length} row(s) not classified repairable: ` +
        notRepairable.map((row) => `${row.id}=${row.status}`).join(", "),
    );
  }
  await client.query("BEGIN");
  try {
    for (const row of repairable) {
      await client.query("UPDATE policies SET content_hash = $2 WHERE id = $1", [
        row.id,
        Buffer.from(row.recomputed, "hex"),
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return repairable.length;
}

/**
 * Non-zero whenever a signed-and-mismatched row exists (needs a human,
 * --apply cannot make it go away), or a dry run still has outstanding
 * repairs -- that second case is what lets a bare invocation double as a
 * pre-deploy gate.
 * @param {{ blockedCount: number, repairableCount: number, apply: boolean }} args
 * @returns {number}
 */
export function exitCode(args) {
  if (args.blockedCount > 0) return 1;
  if (!args.apply && args.repairableCount > 0) return 1;
  return 0;
}

function usageAndExit(message) {
  if (message !== undefined) console.error(message);
  console.error("Usage: repair-policy-content-hash [--apply] [--help]");
  console.error(
    "  --apply   Write corrected content_hash for repairable rows (default: dry run, reports only)",
  );
  console.error("  --help    Print this message and exit");
  process.exit(message === undefined ? 0 : 1);
}

async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) usageAndExit();

  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined) {
    usageAndExit("DATABASE_URL must be set to the migration/owner role -- see file header");
  }

  const pool = new Pool({ connectionString });
  try {
    const { rows } = await pool.query(
      `SELECT id, tenant_id, version, state, content, content_hash, signers FROM policies`,
    );
    const classifications = rows.map(classifyRow);
    const repairable = classifications.filter((c) => c.status === "repairable");
    const blocked = classifications.filter((c) => c.status === "blocked_signed");
    const canonicalCount = classifications.length - repairable.length - blocked.length;

    for (const c of blocked) {
      console.log(`${formatRow(c)}  BLOCKED: signed row, requires manual re-sign`);
    }
    // Write BEFORE reporting the outcome. Printing "REPAIRED" first would leave
    // an operator with a log claiming success for rows a failed transaction
    // rolled back, and this log is the record of a write to a proof table.
    if (values.apply && repairable.length > 0) {
      const client = await pool.connect();
      try {
        await applyRepairs(client, repairable);
      } finally {
        client.release();
      }
    }

    for (const c of repairable) {
      console.log(`${formatRow(c)}  ${values.apply ? "REPAIRED" : "WOULD REPAIR"}`);
    }

    console.log(
      `\nScanned ${classifications.length} row(s): ${canonicalCount} already canonical, ` +
        `${repairable.length} ${values.apply ? "repaired" : "repairable"}, ` +
        `${blocked.length} blocked by signatures.`,
    );

    process.exitCode = exitCode({
      blockedCount: blocked.length,
      repairableCount: repairable.length,
      apply: values.apply,
    });
  } finally {
    await pool.end();
  }
}

// Guarded so the test file can import the pure functions above without
// triggering a real DB connection (mirrors scripts/check-payment-intent-loaders.mjs).
const isCli = fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
