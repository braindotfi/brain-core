import { describe, expect, it, vi } from "vitest";
import { assertDbRoles, type RoleIdentity, type RoleQuery } from "./db-roles.js";

/** A query fn returning `id` for the role query and `perms` for has_table_privilege. */
function fakeQuery(id: RoleIdentity, perms: Record<string, boolean> = {}): RoleQuery {
  return async (sql: string, params?: ReadonlyArray<unknown>) => {
    if (sql.includes("has_table_privilege")) {
      const key = `${String(params?.[0])}:${String(params?.[1])}`;
      return { rows: [{ has: perms[key] ?? false }] };
    }
    return { rows: [id] };
  };
}

const appRole: RoleIdentity = {
  current_user: "brain_app",
  session_user: "brain_app",
  rolbypassrls: false,
  rolsuper: false,
};
const privRole: RoleIdentity = {
  current_user: "brain_privileged",
  session_user: "brain_privileged",
  rolbypassrls: true,
  rolsuper: false,
};
const wikiRole: RoleIdentity = {
  current_user: "brain_wiki_reader",
  session_user: "brain_wiki_reader",
  rolbypassrls: false,
  rolsuper: false,
};

describe("assertDbRoles", () => {
  it("passes for a correct request/privileged/wiki split with role names + perms", async () => {
    const res = await assertDbRoles(
      [
        {
          label: "request",
          query: fakeQuery(appRole),
          mustBypassRls: false,
          expectedRole: "brain_app",
        },
        {
          label: "privileged",
          query: fakeQuery(privRole),
          mustBypassRls: true,
          expectedRole: "brain_privileged",
        },
        {
          label: "wiki",
          query: fakeQuery(wikiRole),
          mustBypassRls: false,
          expectedRole: "brain_wiki_reader",
          forbidden: [{ table: "ledger_counterparties", privilege: "INSERT" }], // returns false
        },
      ],
      { enforce: true },
    );
    expect(res.violations).toEqual([]);
    expect(res.identities).toHaveLength(3);
  });

  it("throws when the request pool is unexpectedly BYPASSRLS", async () => {
    await expect(
      assertDbRoles(
        [
          {
            label: "request",
            query: fakeQuery({ ...appRole, rolbypassrls: true }),
            mustBypassRls: false,
          },
        ],
        {
          enforce: true,
        },
      ),
    ).rejects.toThrow(/must NOT be BYPASSRLS/);
  });

  it("throws when the privileged pool is NOT BYPASSRLS", async () => {
    await expect(
      assertDbRoles(
        [
          {
            label: "privileged",
            query: fakeQuery({ ...privRole, rolbypassrls: false }),
            mustBypassRls: true,
          },
        ],
        {
          enforce: true,
        },
      ),
    ).rejects.toThrow(/must be BYPASSRLS/);
  });

  it("throws when any pool connects as a superuser", async () => {
    await expect(
      assertDbRoles(
        [
          {
            label: "request",
            query: fakeQuery({ ...appRole, rolsuper: true }),
            mustBypassRls: false,
          },
        ],
        {
          enforce: true,
        },
      ),
    ).rejects.toThrow(/SUPERUSER/);
  });

  it("throws when a pool connects as the wrong role (swapped URL)", async () => {
    // request URL points at the wiki role: same NOBYPASSRLS posture, wrong identity.
    await expect(
      assertDbRoles(
        [
          {
            label: "request",
            query: fakeQuery(wikiRole),
            mustBypassRls: false,
            expectedRole: "brain_app",
          },
        ],
        { enforce: true },
      ),
    ).rejects.toThrow(/must connect as brain_app but connected as brain_wiki_reader/);
  });

  it("throws when the wiki pool can write a Ledger table", async () => {
    await expect(
      assertDbRoles(
        [
          {
            label: "wiki",
            query: fakeQuery(wikiRole, { "ledger_counterparties:INSERT": true }),
            mustBypassRls: false,
            expectedRole: "brain_wiki_reader",
            forbidden: [{ table: "ledger_counterparties", privilege: "INSERT" }],
          },
        ],
        { enforce: true },
      ),
    ).rejects.toThrow(/must NOT have INSERT on ledger_counterparties/);
  });

  it("throws when a runtime role can UPDATE audit_events (append-only enforcement)", async () => {
    await expect(
      assertDbRoles(
        [
          {
            label: "request",
            query: fakeQuery(appRole, { "audit_events:UPDATE": true }),
            mustBypassRls: false,
            expectedRole: "brain_app",
            forbidden: [
              { table: "audit_events", privilege: "UPDATE" },
              { table: "audit_events", privilege: "DELETE" },
            ],
          },
        ],
        { enforce: true },
      ),
    ).rejects.toThrow(/must NOT have UPDATE on audit_events/);
  });

  it("does not throw in non-enforce (dev) mode but still reports violations + logs", async () => {
    const log = vi.fn();
    const res = await assertDbRoles(
      [
        {
          label: "request",
          query: fakeQuery({ ...appRole, rolsuper: true }),
          mustBypassRls: false,
        },
      ],
      { enforce: false, log },
    );
    expect(res.violations).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      "[boot] db role verified",
      expect.objectContaining({ pool: "request" }),
    );
  });
});
