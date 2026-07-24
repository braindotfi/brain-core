/**
 * Production fences on the DB-isolation env vars (Standards §1.2 / H-14).
 *
 * Targets the pure assertDbIsolationFences helper so we don't need to boot
 * the full server. The helper is the single source of truth that main.ts
 * delegates to.
 */

import { describe, expect, it, vi } from "vitest";
import { assertDbIsolationFences, type PrivilegedRoleUrls } from "./composition/db-isolation.js";

/** All eight §4 role URLs present. Tests blank out individual ones to fence. */
function allRoleUrls(): PrivilegedRoleUrls {
  return {
    BRAIN_RAW_WORKER_DB_URL: "postgres://raw@host/db",
    BRAIN_CANONICAL_PROJECTOR_DB_URL: "postgres://canon@host/db",
    BRAIN_LEDGER_PROJECTOR_DB_URL: "postgres://ledger@host/db",
    BRAIN_EXECUTION_WORKER_DB_URL: "postgres://exec@host/db",
    BRAIN_AUDIT_VERIFIER_DB_URL: "postgres://verifier@host/db",
    BRAIN_AUDIT_PUBLISHER_DB_URL: "postgres://publisher@host/db",
    BRAIN_RESOLVER_DB_URL: "postgres://resolver@host/db",
    BRAIN_TENANT_DELETION_DB_URL: "postgres://deletion@host/db",
  };
}

describe("assertDbIsolationFences - BRAIN_WIKI_DB_URL", () => {
  it("throws in NODE_ENV=production when unset", () => {
    expect(() =>
      assertDbIsolationFences({
        nodeEnv: "production",
        wikiDbUrl: undefined,
        privilegedRoleUrls: allRoleUrls(),
      }),
    ).toThrow(/BRAIN_WIKI_DB_URL is required in NODE_ENV=production/);
  });

  it("throws in NODE_ENV=production when empty string", () => {
    expect(() =>
      assertDbIsolationFences({
        nodeEnv: "production",
        wikiDbUrl: "",
        privilegedRoleUrls: allRoleUrls(),
      }),
    ).toThrow(/BRAIN_WIKI_DB_URL is required in NODE_ENV=production/);
  });

  it("warns rather than throws in dev when unset", () => {
    const warn = vi.fn();
    const warnings = assertDbIsolationFences({
      nodeEnv: "development",
      wikiDbUrl: undefined,
      privilegedRoleUrls: allRoleUrls(),
      warn,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warnings[0]).toMatch(/BRAIN_WIKI_DB_URL unset/);
  });

  it("is silent in production when wiki + all eight role URLs are set", () => {
    const warn = vi.fn();
    const warnings = assertDbIsolationFences({
      nodeEnv: "production",
      wikiDbUrl: "postgres://reader@host/db",
      privilegedRoleUrls: allRoleUrls(),
      warn,
    });
    expect(warn).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });
});

describe("assertDbIsolationFences - BRAIN_MCP_READER_DB_URL", () => {
  it("throws in production when MCP reader is required, unset, and the opt-out is not set", () => {
    expect(() =>
      assertDbIsolationFences({
        nodeEnv: "production",
        wikiDbUrl: "postgres://reader@host/db",
        mcpReaderDbUrl: undefined,
        requireMcpReader: true,
        privilegedRoleUrls: allRoleUrls(),
      }),
    ).toThrow(/BRAIN_MCP_READER_DB_URL is required.*BRAIN_ALLOW_MISSING_MCP_READER/s);
  });

  it("warns rather than throws in production when MCP reader is required, unset, and allowMissingMcpReader is true", () => {
    const warn = vi.fn();
    let warnings: string[] = [];
    expect(() => {
      warnings = assertDbIsolationFences({
        nodeEnv: "production",
        wikiDbUrl: "postgres://reader@host/db",
        mcpReaderDbUrl: undefined,
        requireMcpReader: true,
        allowMissingMcpReader: true,
        privilegedRoleUrls: allRoleUrls(),
        warn,
      });
    }).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(warnings[0]).toMatch(/BRAIN_MCP_READER_DB_URL unset/);
  });

  it("warns in dev when MCP reader is required and unset", () => {
    const warn = vi.fn();
    const warnings = assertDbIsolationFences({
      nodeEnv: "development",
      wikiDbUrl: "postgres://reader@host/db",
      mcpReaderDbUrl: undefined,
      requireMcpReader: true,
      privilegedRoleUrls: allRoleUrls(),
      warn,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warnings[0]).toMatch(/BRAIN_MCP_READER_DB_URL unset/);
  });

  it("is silent in production when MCP reader URL is set", () => {
    const warn = vi.fn();
    const warnings = assertDbIsolationFences({
      nodeEnv: "production",
      wikiDbUrl: "postgres://reader@host/db",
      mcpReaderDbUrl: "postgres://mcpreader@host/db",
      requireMcpReader: true,
      privilegedRoleUrls: allRoleUrls(),
      warn,
    });
    expect(warn).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });
});

describe("assertDbIsolationFences - §4 role URLs", () => {
  it("throws in NODE_ENV=production when any one role URL is unset", () => {
    expect(() =>
      assertDbIsolationFences({
        nodeEnv: "production",
        wikiDbUrl: "postgres://reader@host/db",
        privilegedRoleUrls: { ...allRoleUrls(), BRAIN_LEDGER_PROJECTOR_DB_URL: undefined },
      }),
    ).toThrow(/BRAIN_LEDGER_PROJECTOR_DB_URL is required in NODE_ENV=production/);
  });

  it("throws in NODE_ENV=production when a role URL is an empty string", () => {
    expect(() =>
      assertDbIsolationFences({
        nodeEnv: "production",
        wikiDbUrl: "postgres://reader@host/db",
        privilegedRoleUrls: { ...allRoleUrls(), BRAIN_TENANT_DELETION_DB_URL: "" },
      }),
    ).toThrow(/BRAIN_TENANT_DELETION_DB_URL is required in NODE_ENV=production/);
  });

  it("warns rather than throws in dev when a role URL is unset", () => {
    const warn = vi.fn();
    const warnings = assertDbIsolationFences({
      nodeEnv: "test",
      wikiDbUrl: "postgres://reader@host/db",
      privilegedRoleUrls: { ...allRoleUrls(), BRAIN_RAW_WORKER_DB_URL: undefined },
      warn,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warnings[0]).toMatch(/BRAIN_RAW_WORKER_DB_URL unset/);
  });

  it("emits a warning per missing URL in dev (wiki + all eight)", () => {
    const warn = vi.fn();
    const blank: PrivilegedRoleUrls = {
      BRAIN_RAW_WORKER_DB_URL: undefined,
      BRAIN_CANONICAL_PROJECTOR_DB_URL: undefined,
      BRAIN_LEDGER_PROJECTOR_DB_URL: undefined,
      BRAIN_EXECUTION_WORKER_DB_URL: undefined,
      BRAIN_AUDIT_VERIFIER_DB_URL: undefined,
      BRAIN_AUDIT_PUBLISHER_DB_URL: undefined,
      BRAIN_RESOLVER_DB_URL: undefined,
      BRAIN_TENANT_DELETION_DB_URL: undefined,
    };
    const warnings = assertDbIsolationFences({
      nodeEnv: "development",
      wikiDbUrl: undefined,
      privilegedRoleUrls: blank,
      warn,
    });
    expect(warn).toHaveBeenCalledTimes(9); // wiki + 8 role URLs
    expect(warnings).toHaveLength(9);
  });

  it("throws on the FIRST missing URL in production (wiki checked first)", () => {
    expect(() =>
      assertDbIsolationFences({
        nodeEnv: "production",
        wikiDbUrl: undefined,
        privilegedRoleUrls: { ...allRoleUrls(), BRAIN_RAW_WORKER_DB_URL: undefined },
      }),
    ).toThrow(/BRAIN_WIKI_DB_URL is required/);
  });
});

describe("assertDbIsolationFences - composition scoping (worker/process separation)", () => {
  const blank: PrivilegedRoleUrls = {
    BRAIN_RAW_WORKER_DB_URL: undefined,
    BRAIN_CANONICAL_PROJECTOR_DB_URL: undefined,
    BRAIN_LEDGER_PROJECTOR_DB_URL: undefined,
    BRAIN_EXECUTION_WORKER_DB_URL: undefined,
    BRAIN_AUDIT_VERIFIER_DB_URL: undefined,
    BRAIN_AUDIT_PUBLISHER_DB_URL: undefined,
    BRAIN_RESOLVER_DB_URL: undefined,
    BRAIN_TENANT_DELETION_DB_URL: undefined,
  };

  it("requireWiki:false does not require the wiki URL in production (worker process)", () => {
    expect(() =>
      assertDbIsolationFences({
        nodeEnv: "production",
        wikiDbUrl: undefined,
        requireWiki: false,
        requiredEnv: new Set(["BRAIN_RAW_WORKER_DB_URL"]),
        privilegedRoleUrls: { ...blank, BRAIN_RAW_WORKER_DB_URL: "postgres://raw@host/db" },
      }),
    ).not.toThrow();
  });

  it("only fences the URLs in requiredEnv (a single-worker process)", () => {
    // Raw worker: only BRAIN_RAW_WORKER_DB_URL is required; the other seven unset
    // URLs must NOT throw in production.
    expect(() =>
      assertDbIsolationFences({
        nodeEnv: "production",
        wikiDbUrl: undefined,
        requireWiki: false,
        requiredEnv: new Set(["BRAIN_RAW_WORKER_DB_URL"]),
        privilegedRoleUrls: { ...blank, BRAIN_RAW_WORKER_DB_URL: "postgres://raw@host/db" },
      }),
    ).not.toThrow();
  });

  it("throws when a URL named in requiredEnv is missing in production", () => {
    expect(() =>
      assertDbIsolationFences({
        nodeEnv: "production",
        wikiDbUrl: undefined,
        requireWiki: false,
        requiredEnv: new Set(["BRAIN_RAW_WORKER_DB_URL"]),
        privilegedRoleUrls: blank,
      }),
    ).toThrow(/BRAIN_RAW_WORKER_DB_URL is required/);
  });
});
