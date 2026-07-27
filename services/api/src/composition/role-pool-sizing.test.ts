import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROLE_POOL_MAX,
  LEDGER_PROJECTOR_MIN_POOL_MAX,
  rolePoolMax,
} from "./role-pool-sizing.js";

describe("rolePoolMax", () => {
  it("keeps ordinary role pools small", () => {
    expect(rolePoolMax("raw_worker", 10)).toBe(DEFAULT_ROLE_POOL_MAX);
    expect(rolePoolMax("canonical_projector", 10)).toBe(DEFAULT_ROLE_POOL_MAX);
  });

  it("keeps spare ledger projector connections beyond its leased workers", () => {
    expect(rolePoolMax("ledger_projector", 3)).toBe(LEDGER_PROJECTOR_MIN_POOL_MAX);
    expect(rolePoolMax("ledger_projector", 10)).toBe(10);
  });
});
