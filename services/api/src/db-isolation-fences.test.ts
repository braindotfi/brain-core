/**
 * Production fences on the DB-isolation env vars (Standards §1.2 / H-14).
 *
 * Targets the pure assertDbIsolationFences helper so we don't need to boot
 * the full server. The helper is the single source of truth that main.ts
 * delegates to.
 */

import { describe, expect, it, vi } from "vitest";
import { assertDbIsolationFences } from "./composition/db-isolation.js";

describe("assertDbIsolationFences — BRAIN_WIKI_DB_URL", () => {
  it("throws in NODE_ENV=production when unset", () => {
    expect(() =>
      assertDbIsolationFences({
        nodeEnv: "production",
        wikiDbUrl: undefined,
        privilegedDbUrl: "postgres://priv@host/db",
      }),
    ).toThrow(/BRAIN_WIKI_DB_URL is required in NODE_ENV=production/);
  });

  it("throws in NODE_ENV=production when empty string", () => {
    expect(() =>
      assertDbIsolationFences({
        nodeEnv: "production",
        wikiDbUrl: "",
        privilegedDbUrl: "postgres://priv@host/db",
      }),
    ).toThrow(/BRAIN_WIKI_DB_URL is required in NODE_ENV=production/);
  });

  it("warns rather than throws in dev when unset", () => {
    const warn = vi.fn();
    const warnings = assertDbIsolationFences({
      nodeEnv: "development",
      wikiDbUrl: undefined,
      privilegedDbUrl: "postgres://priv@host/db",
      warn,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warnings[0]).toMatch(/BRAIN_WIKI_DB_URL unset/);
  });

  it("is silent in production when both URLs are set", () => {
    const warn = vi.fn();
    const warnings = assertDbIsolationFences({
      nodeEnv: "production",
      wikiDbUrl: "postgres://reader@host/db",
      privilegedDbUrl: "postgres://priv@host/db",
      warn,
    });
    expect(warn).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });
});

describe("assertDbIsolationFences — DATABASE_PRIVILEGED_URL", () => {
  it("throws in NODE_ENV=production when unset", () => {
    expect(() =>
      assertDbIsolationFences({
        nodeEnv: "production",
        wikiDbUrl: "postgres://reader@host/db",
        privilegedDbUrl: undefined,
      }),
    ).toThrow(/DATABASE_PRIVILEGED_URL is required in NODE_ENV=production/);
  });

  it("throws in NODE_ENV=production when empty string", () => {
    expect(() =>
      assertDbIsolationFences({
        nodeEnv: "production",
        wikiDbUrl: "postgres://reader@host/db",
        privilegedDbUrl: "",
      }),
    ).toThrow(/DATABASE_PRIVILEGED_URL is required in NODE_ENV=production/);
  });

  it("warns rather than throws in dev when unset", () => {
    const warn = vi.fn();
    const warnings = assertDbIsolationFences({
      nodeEnv: "test",
      wikiDbUrl: "postgres://reader@host/db",
      privilegedDbUrl: undefined,
      warn,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warnings[0]).toMatch(/DATABASE_PRIVILEGED_URL unset/);
  });

  it("emits both warnings when both are missing in dev", () => {
    const warn = vi.fn();
    const warnings = assertDbIsolationFences({
      nodeEnv: "development",
      wikiDbUrl: undefined,
      privilegedDbUrl: undefined,
      warn,
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warnings).toHaveLength(2);
  });

  it("throws on the FIRST missing URL in production (does not collect a list)", () => {
    // Defensive: if main.ts ever wants both messages it should refactor; today
    // a single throw on the first failure is enough to fail fast at boot.
    expect(() =>
      assertDbIsolationFences({
        nodeEnv: "production",
        wikiDbUrl: undefined,
        privilegedDbUrl: undefined,
      }),
    ).toThrow(/BRAIN_WIKI_DB_URL is required/);
  });
});
