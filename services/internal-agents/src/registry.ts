/**
 * Internal-agent catalog.
 *
 * The router selects over `internalAgentCatalog`; the worker dispatches the
 * selected agent's action through `internalAgentHandlers`. Adding an agent in
 * a later phase means adding its definition + handler here — no router change.
 */

import type { InternalAgentDefinition } from "@brain/schemas";
import { collectionsDefinition } from "./collections/definition.js";
import { collectionsHandler } from "./collections/handler.js";
import { treasuryDefinition } from "./treasury/definition.js";
import { treasuryHandler } from "./treasury/handler.js";
import { reconciliationDefinition } from "./reconciliation/definition.js";
import { reconciliationHandler } from "./reconciliation/handler.js";
import type { InternalAgentHandler } from "./handler.js";

export const internalAgentCatalog: readonly InternalAgentDefinition[] = [
  collectionsDefinition,
  treasuryDefinition,
  reconciliationDefinition,
];

export const internalAgentHandlers: Readonly<Record<string, InternalAgentHandler>> = {
  collections: collectionsHandler,
  treasury: treasuryHandler,
  reconciliation: reconciliationHandler,
};
