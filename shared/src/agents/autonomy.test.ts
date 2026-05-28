import { describe, expect, it } from "vitest";
import {
  AUTONOMY_MODES,
  deriveAutonomyMode,
  type AutonomyMode,
  type DeriveAutonomyModeInput,
} from "./autonomy.js";

function input(over: Partial<DeriveAutonomyModeInput> = {}): DeriveAutonomyModeInput {
  return {
    isLive: true,
    defaultAuthority: "execute",
    policyMaxOutcome: "allow",
    ...over,
  };
}

describe("AUTONOMY_MODES", () => {
  it("enumerates the four-rung ladder in safety order", () => {
    expect(AUTONOMY_MODES).toEqual(["shadow", "recommend", "confirm", "live"]);
  });
});

describe("deriveAutonomyMode — truth table", () => {
  it("isLive=false → shadow (promotion gate dominates)", () => {
    expect(deriveAutonomyMode(input({ isLive: false }))).toBe("shadow");
    // Even with executive authority + allow policy, a shadowed agent stays shadow.
    expect(
      deriveAutonomyMode(
        input({ isLive: false, defaultAuthority: "execute", policyMaxOutcome: "allow" }),
      ),
    ).toBe("shadow");
  });

  it("defaultAuthority=notify_only → shadow (no proposal path)", () => {
    expect(deriveAutonomyMode(input({ defaultAuthority: "notify_only" }))).toBe("shadow");
  });

  it("defaultAuthority=propose → recommend (proposal but no auto-execute)", () => {
    expect(deriveAutonomyMode(input({ defaultAuthority: "propose" }))).toBe("recommend");
    // Even when policy says allow, "propose" authority means insight-only.
    expect(
      deriveAutonomyMode(input({ defaultAuthority: "propose", policyMaxOutcome: "allow" })),
    ).toBe("recommend");
  });

  it("policyMaxOutcome=reject → shadow (no path to action)", () => {
    expect(deriveAutonomyMode(input({ policyMaxOutcome: "reject" }))).toBe("shadow");
  });

  it("policyMaxOutcome=confirm → confirm (human-in-the-loop required)", () => {
    expect(deriveAutonomyMode(input({ policyMaxOutcome: "confirm" }))).toBe("confirm");
  });

  it("policyMaxOutcome=allow + authority=execute + isLive → live", () => {
    expect(deriveAutonomyMode(input())).toBe("live");
  });

  // Exhaustive matrix to lock the truth table — every combo resolves to one mode.
  it("is total over the {isLive × authority × outcome} input space", () => {
    const isLives = [true, false];
    const auths: DeriveAutonomyModeInput["defaultAuthority"][] = [
      "execute",
      "propose",
      "notify_only",
    ];
    const outcomes: DeriveAutonomyModeInput["policyMaxOutcome"][] = ["allow", "confirm", "reject"];
    const valid = new Set<AutonomyMode>(AUTONOMY_MODES);
    for (const isLive of isLives) {
      for (const defaultAuthority of auths) {
        for (const policyMaxOutcome of outcomes) {
          const mode = deriveAutonomyMode({ isLive, defaultAuthority, policyMaxOutcome });
          expect(valid.has(mode)).toBe(true);
        }
      }
    }
  });

  it("only `live` reachable when isLive=true + authority=execute + outcome=allow", () => {
    // Lock the invariant: `live` is the unique mode that permits unattended
    // execution. Anything else funnels through approval or insight-only.
    const isLives = [true, false];
    const auths: DeriveAutonomyModeInput["defaultAuthority"][] = [
      "execute",
      "propose",
      "notify_only",
    ];
    const outcomes: DeriveAutonomyModeInput["policyMaxOutcome"][] = ["allow", "confirm", "reject"];
    let liveCount = 0;
    for (const isLive of isLives) {
      for (const defaultAuthority of auths) {
        for (const policyMaxOutcome of outcomes) {
          if (
            deriveAutonomyMode({ isLive, defaultAuthority, policyMaxOutcome }) === "live"
          ) {
            liveCount += 1;
            expect({ isLive, defaultAuthority, policyMaxOutcome }).toEqual({
              isLive: true,
              defaultAuthority: "execute",
              policyMaxOutcome: "allow",
            });
          }
        }
      }
    }
    expect(liveCount).toBe(1);
  });
});
