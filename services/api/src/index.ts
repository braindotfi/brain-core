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
