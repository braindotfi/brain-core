import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryAuditEmitter,
  errorHandlerPlugin,
  newTenantId,
  type Principal,
} from "@brain/shared";
import { registerTeamRoutes } from "./routes.js";

const tenantId = newTenantId();

type Role = "owner" | "admin" | "approver" | "analyst" | "viewer";

interface MemberRow {
  tenant_id: string;
  id: string;
  email: string;
  display_name: string;
  role: Role;
  status: "invited" | "active" | "deactivated";
  active: boolean;
  approval_domains: string[];
  per_item_limit_cents: string;
  requires_second_approver_above_cents: string | null;
}

interface AuthorityRow {
  id: string;
  tenant_id: string;
  user_id: string;
  agent: string;
  can_approve: boolean;
  can_edit: boolean;
  can_reject: boolean;
  max_amount_cents: string | null;
  can_delegate: boolean;
}

interface InviteRow {
  tenant_id: string;
  member_id: string;
  token_hash: string;
  email: string;
  role: Role;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

function principal(id: string): Principal {
  return {
    id,
    type: "user",
    tenantId,
    scopes: ["execution:admin", "execution:read"],
    tokenId: "tok_team",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function memberRow(id: string, role: Role): MemberRow {
  return {
    tenant_id: tenantId,
    id,
    email: `${id}@example.com`,
    display_name: id,
    role,
    status: "active",
    active: true,
    approval_domains: ["ap"],
    per_item_limit_cents: "10000",
    requires_second_approver_above_cents: null,
  };
}

async function buildApp() {
  const members: Record<string, MemberRow> = { usr_owner: memberRow("usr_owner", "owner") };
  const authorities: AuthorityRow[] = [];
  const invites: InviteRow[] = [];
  const users: Record<string, { id: string; email: string; role: Role; status: string }> = {};
  let currentTenant = tenantId;
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT set_config")) {
        currentTenant = String(values[0]);
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM members") && sql.includes("WHERE id = $1")) {
        const found = members[String(values[0])];
        return { rows: found === undefined ? [] : [found], rowCount: found === undefined ? 0 : 1 };
      }
      if (sql.startsWith("INSERT INTO members")) {
        const row: MemberRow = {
          tenant_id: String(values[0]),
          id: String(values[1]),
          email: String(values[2]).toLowerCase(),
          display_name: String(values[3]),
          role: values[4] as Role,
          status: values[5] as MemberRow["status"],
          active: values[6] === true,
          approval_domains: values[7] as string[],
          per_item_limit_cents: String(values[8]),
          requires_second_approver_above_cents:
            values[9] === null || values[9] === undefined ? null : String(values[9]),
        };
        members[row.id] = row;
        return { rows: [row], rowCount: 1 };
      }
      if (sql.startsWith("DELETE FROM user_agent_authority")) {
        const userId = String(values[0]);
        for (let i = authorities.length - 1; i >= 0; i -= 1) {
          if (authorities[i]?.user_id === userId) authorities.splice(i, 1);
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO user_agent_authority")) {
        const row: AuthorityRow = {
          id: String(values[0]),
          tenant_id: currentTenant,
          user_id: String(values[1]),
          agent: String(values[2]),
          can_approve: values[3] === true,
          can_edit: values[4] === true,
          can_reject: values[5] === true,
          max_amount_cents: values[6] === null ? null : String(values[6]),
          can_delegate: values[7] === true,
        };
        authorities.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE pending_invites")) {
        const tokenHash = String(values[0]);
        for (const invite of invites) {
          if (invite.token_hash === tokenHash) invite.accepted_at = new Date().toISOString();
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO pending_invites")) {
        invites.push({
          tenant_id: String(values[0]),
          member_id: String(values[1]),
          token_hash: String(values[2]),
          email: String(values[3]),
          role: values[4] as Role,
          expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
          accepted_at: null,
          revoked_at: null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM pending_invites")) {
        const found = invites.find((invite) => invite.token_hash === values[0]);
        return { rows: found === undefined ? [] : [found], rowCount: found === undefined ? 0 : 1 };
      }
      if (sql.startsWith("INSERT INTO users")) {
        users[String(values[0])] = {
          id: String(values[0]),
          email: String(values[2]),
          role: values[3] as Role,
          status: "active",
        };
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE members")) {
        const id = String(values[values.length - 1]);
        const found = members[id];
        if (found === undefined) return { rows: [], rowCount: 0 };
        if (sql.includes("display_name")) found.display_name = String(values[0]);
        if (sql.includes("status")) found.status = "active";
        if (sql.includes("active")) found.active = true;
        return { rows: [found], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn((sql: string, values?: unknown[]) => client.query(sql, values ?? [])),
  };
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request: FastifyRequest) => {
    request.principal = principal("usr_owner");
  });
  const audit = new InMemoryAuditEmitter();
  await registerTeamRoutes(app, {
    pool: pool as never,
    audit,
    resolverPool: pool as never,
    inviteBaseUrl: "https://app.example.test/team/accept",
  });
  return { app, audit, authorities, users };
}

describe("team routes", () => {
  it("invites and accepts a team user with per-agent authority", async () => {
    const { app, audit, authorities, users } = await buildApp();
    try {
      const invite = await app.inject({
        method: "POST",
        url: "/team/invite",
        payload: {
          tenant_id: tenantId,
          email: "new@example.com",
          role: "approver",
          agent_authority: [
            {
              agent: "treasury",
              can_approve: true,
              can_edit: false,
              can_reject: true,
              max_amount_cents: 1000000,
              can_delegate: false,
            },
          ],
        },
      });
      expect(invite.statusCode).toBe(201);
      const inviteBody = invite.json();
      expect(inviteBody.user.role).toBe("approver");
      expect(inviteBody.user.agent_authority[0]).toMatchObject({
        agent: "treasury",
        max_amount_cents: 1000000,
      });

      const accepted = await app.inject({
        method: "POST",
        url: "/team/accept",
        payload: {
          invite_token: inviteBody.invite_token,
          display_name: "New User",
        },
      });
      expect(accepted.statusCode).toBe(200);
      const acceptedBody = accepted.json();
      expect(acceptedBody.user).toMatchObject({
        email: "new@example.com",
        display_name: "New User",
        role: "approver",
        active: true,
      });
      expect(authorities).toHaveLength(1);
      expect(authorities[0]).toMatchObject({ agent: "treasury", max_amount_cents: "1000000" });
      expect(users[acceptedBody.user.id]).toMatchObject({ role: "approver", status: "active" });
      expect(audit.events.map((event) => event.action)).toEqual(["member.invited", "user.joined"]);
    } finally {
      await app.close();
    }
  });
});
