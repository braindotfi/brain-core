/**
 * R-09 exit criterion: property tests proving the off-chain spend window and
 * the on-chain (Solidity) spend window agree at the boundary.
 *
 * The off-chain gate (agent-window-spend.ts, check 8.5) keys spend on
 *   floor(extract(epoch from now()) / p) * p           [SQL, numeric]
 * and BrainSmartAccount keys its session-key budget on
 *   (block.timestamp / p) * p                           [Solidity, uint]
 *
 * `tumblingWindowStartSeconds` is the canonical formula both mirror. These
 * tests prove (1) it matches an INDEPENDENT derivation of the Solidity
 * integer-division window (ts - ts % p), including at T-1 / T / T+1; (2) the
 * off-chain double-precision intermediate (`extract(epoch ...)` is a float64)
 * does not diverge from the exact integer window across the realistic epoch
 * range; and (3) the window's containment/monotonicity invariants hold.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { tumblingWindowStartSeconds } from "./agent-window-spend.js";

/**
 * Independent model of the on-chain `(block.timestamp / p) * p`. Solidity uint
 * division truncates toward zero; for non-negative operands that equals
 * `ts - (ts % p)`. Deriving it via modulo (not the same `(/)*` expression the
 * production formula uses) makes the equivalence a real check, not a tautology.
 */
function onChainWindowStart(ts: bigint, period: bigint): bigint {
  return ts - (ts % period);
}

// Realistic bounds: epoch seconds through ~year 2200, periods from 1s to ~1yr.
const EPOCH_MAX = 7_258_118_400; // 2200-01-01
const PERIOD_MAX = 31_536_000; // 365 days

describe("tumblingWindowStartSeconds — off-chain == on-chain (R-09)", () => {
  it("equals the independent Solidity integer-division window for all ts, period", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: BigInt(EPOCH_MAX) }),
        fc.bigInt({ min: 1n, max: BigInt(PERIOD_MAX) }),
        (ts, period) => {
          expect(tumblingWindowStartSeconds(ts, period)).toBe(onChainWindowStart(ts, period));
        },
      ),
    );
  });

  it("agrees exactly at the boundary: T-1 in the prior window, T and T+1 in window T", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: BigInt(Math.floor(EPOCH_MAX / PERIOD_MAX)) }),
        // period >= 2 so T+1 is strictly inside window T (with period 1 every
        // second is its own window and "T+1 still in window T" is vacuous).
        fc.bigInt({ min: 2n, max: BigInt(PERIOD_MAX) }),
        (k, period) => {
          const T = k * period; // a window boundary
          // At the boundary and one past it: still window T.
          expect(tumblingWindowStartSeconds(T, period)).toBe(T);
          expect(tumblingWindowStartSeconds(T + 1n, period)).toBe(T);
          // One before the boundary: the previous window.
          expect(tumblingWindowStartSeconds(T - 1n, period)).toBe(T - period);
          // Both enforcers land on the same value at each of T-1, T, T+1.
          for (const ts of [T - 1n, T, T + 1n]) {
            expect(tumblingWindowStartSeconds(ts, period)).toBe(onChainWindowStart(ts, period));
          }
        },
      ),
    );
  });

  it("the off-chain double-precision epoch intermediate does not diverge from the exact window", () => {
    // `extract(epoch from now())` is a float64 before the numeric cast. Prove
    // Math.floor(ts/p)*p (the float path) equals the exact BigInt window across
    // the realistic epoch range — i.e. no float rounding error at this scale.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: EPOCH_MAX }),
        fc.integer({ min: 1, max: PERIOD_MAX }),
        (ts, period) => {
          const floatWindow = Math.floor(ts / period) * period;
          const exact = Number(tumblingWindowStartSeconds(BigInt(ts), BigInt(period)));
          expect(floatWindow).toBe(exact);
        },
      ),
    );
  });

  it("window contains ts and is strictly below the next boundary", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: BigInt(EPOCH_MAX) }),
        fc.bigInt({ min: 1n, max: BigInt(PERIOD_MAX) }),
        (ts, period) => {
          const w = tumblingWindowStartSeconds(ts, period);
          expect(w <= ts).toBe(true);
          expect(ts < w + period).toBe(true);
          expect(w % period).toBe(0n);
        },
      ),
    );
  });

  it("is non-decreasing as time advances", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: BigInt(EPOCH_MAX) }),
        fc.bigInt({ min: 0n, max: BigInt(PERIOD_MAX) }),
        fc.bigInt({ min: 1n, max: BigInt(PERIOD_MAX) }),
        (ts, delta, period) => {
          expect(tumblingWindowStartSeconds(ts + delta, period)).toBeGreaterThanOrEqual(
            tumblingWindowStartSeconds(ts, period),
          );
        },
      ),
    );
  });

  it("returns 0 when period accounting is disabled (period 0), mirroring the contract", () => {
    expect(tumblingWindowStartSeconds(123_456n, 0n)).toBe(0n);
    expect(() => tumblingWindowStartSeconds(-1n, 86_400n)).toThrow();
  });
});
