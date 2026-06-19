/**
 * Partner-connector in-process isolation invariant.
 *
 * A `partner`-tier connector (see ConnectorTrustTier) is authored outside
 * Brain's trust boundary, so its code must never run inside the trusted
 * ingestion pipeline. The runtime piece -- hosting partner connector code in
 * an isolated runtime Brain operates -- is deferred to the R-03 deploy
 * substrate (separate process/container hosting does not exist yet). What is
 * enforceable today, substrate-independent, is the IN-PROCESS EXCLUSION, which
 * this asserts:
 *
 *   1. no SourceAdapter is registered for a partner-tier connectorType --
 *      partner code never links into the in-process adapter registry, holds
 *      provider credentials, or runs on the sync worker;
 *   2. a partner descriptor declares no parserVersions -- it cannot register a
 *      Ledger parser, which would mint high-trust `extracted` evidence;
 *   3. a partner connector declares no webhook delivery -- an in-process,
 *      HMAC-verified provider webhook mints authenticated provenance; a partner
 *      reaches Raw only through the authenticated generic-ingest boundary
 *      (`/raw/ingest`) as an `api_partner` principal, where its artifacts
 *      resolve as low evidence trust (`customer_asserted`) and the §6 gate
 *      refuses to settle on them uncorroborated.
 *
 * A `first_party` connector is unconstrained here; its in-process registration
 * is governed by the existing descriptor guard (check-connector-descriptors).
 *
 * Pure and env-independent (the invariant is structural, not a production-only
 * concern): callable from a boot fence, a unit test, or the CI guard.
 */

import type { ConnectorDescriptor } from "./descriptors.js";
import { listAdapters, listDescriptors } from "./registry.js";

export interface PartnerIsolationInput {
  descriptors: ReadonlyArray<ConnectorDescriptor>;
  /** sourceTypes with an in-process SourceAdapter registered. */
  registeredSourceTypes: ReadonlySet<string>;
}

/**
 * Throws if any partner-tier descriptor violates the in-process exclusion.
 * No-op when every partner connector is correctly out-of-process (and always
 * a no-op when there are no partner-tier connectors).
 */
export function assertPartnerConnectorIsolation(input: PartnerIsolationInput): void {
  const violations: string[] = [];
  for (const d of input.descriptors) {
    if (d.trustTier !== "partner") continue;
    if (input.registeredSourceTypes.has(d.connectorType)) {
      violations.push(
        `'${d.connectorType}' is partner-tier but has an in-process SourceAdapter registered`,
      );
    }
    if (d.parserVersions.length > 0) {
      violations.push(
        `'${d.connectorType}' is partner-tier but declares parserVersions ` +
          `[${d.parserVersions.join(", ")}]; partner code must not register a Ledger parser`,
      );
    }
    if (d.delivery.includes("webhook")) {
      violations.push(
        `'${d.connectorType}' is partner-tier but declares webhook delivery; a partner ` +
          `connector reaches Raw only via the authenticated generic-ingest boundary`,
      );
    }
  }
  if (violations.length > 0) {
    throw new Error(`partner-connector isolation violated: ${violations.join("; ")}`);
  }
}

/**
 * Convenience over the live adapter/descriptor registry. Called at boot so a
 * misdeclared partner connector fails closed (CrashLoopBackoff) rather than
 * silently running partner code in-process.
 */
export function assertRegistryPartnerIsolation(): void {
  assertPartnerConnectorIsolation({
    descriptors: listDescriptors(),
    registeredSourceTypes: new Set(listAdapters().map((a) => a.sourceType)),
  });
}
