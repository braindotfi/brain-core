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

// BrainSaaS "Brain Playground" demo seed — re-exported so the
// `brain-seed-brainsaas` CLI (tools/seed-golden-path) and the
// POST /v1/demo/provision-run handler share one implementation.
export { seedBrainSaasDemo, type BrainSaasSeed } from "./demo/brainsaas-seed.js";
