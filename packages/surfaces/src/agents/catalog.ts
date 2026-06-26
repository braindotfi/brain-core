/**
 * Catalog of the four public agents. Each exports a factory that turns its own
 * raw finding into a canonical Proposal. Adding an agent means adding a factory
 * here. Surfaces never change.
 */
export { buildInvoiceProposal } from "./invoice.js";
export type { InvoiceFinding } from "./invoice.js";

export { buildCollectionsProposal } from "./collections.js";
export type { CollectionsFinding } from "./collections.js";

export { buildCashProposal } from "./cash.js";
export type { CashFinding } from "./cash.js";

export { buildCloseProposal } from "./close.js";
export type { CloseFinding } from "./close.js";
