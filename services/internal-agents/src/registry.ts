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
import { paymentDefinition } from "./payment/definition.js";
import { paymentHandler } from "./payment/handler.js";
import { subscriptionDefinition } from "./subscription/definition.js";
import { subscriptionHandler } from "./subscription/handler.js";
import { vendorRiskDefinition } from "./vendor_risk/definition.js";
import { vendorRiskHandler } from "./vendor_risk/handler.js";
import { cashForecastDefinition } from "./cash_forecast/definition.js";
import { cashForecastHandler } from "./cash_forecast/handler.js";
import { disputeDefinition } from "./dispute/definition.js";
import { disputeHandler } from "./dispute/handler.js";
import { complianceDefinition } from "./compliance/definition.js";
import { complianceHandler } from "./compliance/handler.js";
import { revenueIntelDefinition } from "./revenue_intel/definition.js";
import { revenueIntelHandler } from "./revenue_intel/handler.js";
import type { InternalAgentHandler } from "./handler.js";

export const internalAgentCatalog: readonly InternalAgentDefinition[] = [
  collectionsDefinition,
  treasuryDefinition,
  reconciliationDefinition,
  paymentDefinition,
  subscriptionDefinition,
  vendorRiskDefinition,
  cashForecastDefinition,
  disputeDefinition,
  complianceDefinition,
  revenueIntelDefinition,
];

export const internalAgentHandlers: Readonly<Record<string, InternalAgentHandler>> = {
  collections: collectionsHandler,
  treasury: treasuryHandler,
  reconciliation: reconciliationHandler,
  payment: paymentHandler,
  subscription: subscriptionHandler,
  vendor_risk: vendorRiskHandler,
  cash_forecast: cashForecastHandler,
  dispute: disputeHandler,
  compliance: complianceHandler,
  revenue_intel: revenueIntelHandler,
};
