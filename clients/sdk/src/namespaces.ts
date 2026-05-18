/** Internal barrel re-exporting every namespace module, to avoid a long
 * import block in `src/index.ts`. Public consumers should import the
 * namespace symbols directly from `@brain/sdk` (the root re-exports them).
 *
 * @internal
 */

export * from "./actions/index.js";
export * from "./agents/index.js";
export * from "./audit/index.js";
export * from "./auth/index.js";
export * from "./cash_flows/index.js";
export * from "./ledger/index.js";
export * from "./policy/index.js";
export * from "./sources/index.js";
export * from "./wiki/index.js";
