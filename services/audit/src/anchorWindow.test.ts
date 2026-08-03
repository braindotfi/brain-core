import { describe, expect, it } from "vitest";
import { MAX_ANCHOR_WINDOW_MS, nextAnchorWindow } from "./anchorWindow.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("nextAnchorWindow", () => {
  it("starts a never-anchored tenant at its oldest unanchored event", () => {
    const oldestUnanchored = new Date("2026-06-01T00:00:00Z");
    const now = new Date("2026-06-01T01:00:00Z");

    const { periodStart, periodEnd } = nextAnchorWindow(null, oldestUnanchored, now);

    expect(periodStart).toEqual(oldestUnanchored);
    expect(periodEnd).toEqual(now);
  });

  it("starts at oldest_unanchored in the normal (no gap) case, which is covered_to + 1ms when the next event lands exactly on the boundary", () => {
    const coveredTo = new Date("2026-06-01T00:00:00.000Z");
    const oldestUnanchored = new Date(coveredTo.getTime() + 1); // next event right after the boundary
    const now = new Date("2026-06-01T01:00:00Z");

    const { periodStart, periodEnd } = nextAnchorWindow(coveredTo, oldestUnanchored, now);

    expect(periodStart).toEqual(new Date(coveredTo.getTime() + 1));
    expect(periodEnd).toEqual(now);
  });

  it("floors periodStart at covered_to + 1ms (never re-anchors already-covered time) if oldest_unanchored is stale", () => {
    // The caller's coverage query always produces oldest_unanchored strictly
    // after covered_to, so this shouldn't happen in practice -- but the pure
    // function still guards against ever starting at or before what's already
    // covered.
    const coveredTo = new Date("2026-06-01T00:00:00.000Z");
    const oldestUnanchored = new Date("2026-05-01T00:00:00.000Z"); // stale/before covered_to
    const now = new Date("2026-06-01T01:00:00Z");

    const { periodStart } = nextAnchorWindow(coveredTo, oldestUnanchored, now);

    expect(periodStart).toEqual(new Date(coveredTo.getTime() + 1));
  });

  it("skips the empty window and starts at oldest_unanchored when the gap since covered_to exceeds the backlog", () => {
    // Regression for the >7 day quiet-period livelock: covered_to is 10 days
    // old, but the next unanchored event is only 1 day old (a long quiet
    // spell in between). covered_to + 1ms clamped to +7 days would end
    // before oldestUnanchored, giving a window with zero events forever.
    const coveredTo = new Date("2026-05-22T00:00:00Z"); // 10 days before now
    const oldestUnanchored = new Date("2026-05-31T00:00:00Z"); // 1 day before now
    const now = new Date("2026-06-01T00:00:00Z");

    const { periodStart, periodEnd } = nextAnchorWindow(coveredTo, oldestUnanchored, now);

    expect(periodStart).toEqual(oldestUnanchored);
    expect(periodEnd).toEqual(now);
  });

  it("clamps periodEnd to maxWindowMs after periodStart when the backlog itself is wider than the cap", () => {
    const coveredTo = null;
    const oldestUnanchored = new Date("2026-05-01T00:00:00Z"); // ~31 days of backlog
    const now = new Date("2026-06-01T00:00:00Z");

    const { periodStart, periodEnd } = nextAnchorWindow(coveredTo, oldestUnanchored, now);

    expect(periodStart).toEqual(oldestUnanchored);
    expect(periodEnd).toEqual(new Date(oldestUnanchored.getTime() + MAX_ANCHOR_WINDOW_MS));
    expect(periodEnd.getTime()).toBeLessThan(now.getTime());
  });

  it("does not clamp when the window is exactly at the boundary", () => {
    const oldestUnanchored = new Date("2026-05-25T00:00:00Z");
    const now = new Date(oldestUnanchored.getTime() + MAX_ANCHOR_WINDOW_MS);

    const { periodStart, periodEnd } = nextAnchorWindow(null, oldestUnanchored, now);

    expect(periodStart).toEqual(oldestUnanchored);
    expect(periodEnd).toEqual(now);
  });

  it("honors a custom maxWindowMs", () => {
    const oldestUnanchored = new Date("2026-06-01T00:00:00Z");
    const now = new Date(oldestUnanchored.getTime() + 3 * DAY_MS);

    const { periodEnd } = nextAnchorWindow(null, oldestUnanchored, now, DAY_MS);

    expect(periodEnd).toEqual(new Date(oldestUnanchored.getTime() + DAY_MS));
  });
});
