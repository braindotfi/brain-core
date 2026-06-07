import { describe, expect, it, vi } from "vitest";
import { assertDbRoles, type PoolRoleExpectation, type RoleIdentity } from "./db-roles.js";

function fakePool(id: RoleIdentity): PoolRoleExpectation["pool"] {
  return { query: vi.fn(async () => ({ rows: [id] })) };
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

describe("assertDbRoles", () => {
  it("passes for a correct request/privileged/wiki split", async () => {
    const res = await assertDbRoles(
      [
        { label: "request", pool: fakePool(appRole), mustBypassRls: false },
        { label: "privileged", pool: fakePool(privRole), mustBypassRls: true },
        {
          label: "wiki",
          pool: fakePool({ ...appRole, current_user: "brain_wiki_reader" }),
          mustBypassRls: false,
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
            pool: fakePool({ ...appRole, rolbypassrls: true }),
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
            pool: fakePool({ ...privRole, rolbypassrls: false }),
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
            pool: fakePool({ ...appRole, rolsuper: true }),
            mustBypassRls: false,
          },
        ],
        {
          enforce: true,
        },
      ),
    ).rejects.toThrow(/SUPERUSER/);
  });

  it("does not throw in non-enforce (dev) mode but still reports violations + logs", async () => {
    const log = vi.fn();
    const res = await assertDbRoles(
      [{ label: "request", pool: fakePool({ ...appRole, rolsuper: true }), mustBypassRls: false }],
      { enforce: false, log },
    );
    expect(res.violations).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      "[boot] db role verified",
      expect.objectContaining({ pool: "request" }),
    );
  });
});
