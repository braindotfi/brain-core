/**
 * @brain/api
 *
 * Public HTTP API gateway. Terminates auth, routes to internal services.
 * Hosts shared primitives under `./shared/`, which every other service
 * imports via `@brain/api/shared`.
 *
 * Endpoint implementation lands in stages 2–7 per Brain_Claude_Code_Prompt.docx.
 */

export const SERVICE_NAME = "brain-api" as const;

// BrainSaaS "Brain Playground" demo seed - re-exported so the
// `brain-seed-brainsaas` CLI (tools/seed-golden-path) and the
// POST /v1/demo/provision-run handler share one implementation.
export { seedBrainSaasDemo, type BrainSaasSeed } from "./demo/brainsaas-seed.js";

// Fixed golden-path demo identity - re-exported so
// `brain-seed-golden-path` (tools/seed-golden-path) can seed a `members` row
// for the exact id GET /v1/demo/token mints, making that session
// member-resolvable for approval workflows. See golden-tenant.ts.
export { DEMO_GOLDEN_USER, DEMO_GOLDEN_TENANT } from "./demo/golden-tenant.js";

// Bootstrap admin-member insert - reused by the golden-path seed CLI so the
// demo token's principal has a real `members` row (see above), not just by
// provision.ts / brainsaas-seed.ts.
export { insertBootstrapAdminMember } from "./onboarding/bootstrap-member.js";

// §6 gate check 9.5 evidence loader - re-exported so integration tests (e.g.
// tests/invariants) can exercise the REAL ledger-enrichment join (raw_parsed
// -> ledger_invoices / ledger_obligations by evidence_ids) instead of
// hand-rolling a mock that drifts from production semantics. See the header
// comment on gate-loaders/index.ts for why this loader lives here.
export { makeResolveEvidence } from "./gate-loaders/index.js";
