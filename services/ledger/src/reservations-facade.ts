/**
 * LedgerReservations — sanctioned cross-service surface for execution-time
 * balance reservations. SQL remains owned by services/ledger while the
 * execution money path can atomically reserve/consume/release holds.
 */

import {
  consumeReservation,
  insertReservation,
  releaseReservation,
  reserveIfAvailable,
  sumActiveReservations,
} from "./repository/reservations.js";

export const LedgerReservations = {
  insert: insertReservation,
  reserveIfAvailable,
  sumActive: sumActiveReservations,
  consume: consumeReservation,
  release: releaseReservation,
} as const;
