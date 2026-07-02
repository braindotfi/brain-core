import { withTenantScope, type TenantScopedClient } from "@brain/shared";
import type { Pool } from "pg";
import type {
  ApprovalDomain,
  MemberAuthority,
  MemberIdentitySurface,
  MemberLookup,
} from "./types.js";

interface MemberRow {
  tenant_id: string;
  id: string;
  email: string;
  display_name: string;
  role: "admin" | "approver" | "viewer";
  active: boolean;
  approval_domains: ApprovalDomain[];
  per_item_limit_cents: string | number | bigint;
  requires_second_approver_above_cents: string | number | bigint | null;
}

export class PostgresMemberLookup implements MemberLookup {
  public constructor(private readonly pool: Pool) {}

  public async findMemberById(tenantId: string, memberId: string): Promise<MemberAuthority | null> {
    return withTenantScope(this.pool, tenantId, (c) => findMemberById(c, memberId));
  }

  public async findMemberByEmail(tenantId: string, email: string): Promise<MemberAuthority | null> {
    return withTenantScope(this.pool, tenantId, (c) => findMemberByEmail(c, email));
  }

  public async findMemberByIdentityLink(input: {
    tenantId: string;
    surface: MemberIdentitySurface;
    externalRef: string;
  }): Promise<MemberAuthority | null> {
    return withTenantScope(this.pool, input.tenantId, (c) =>
      findMemberByIdentityLink(c, input.surface, input.externalRef),
    );
  }
}

export async function findMemberById(
  client: TenantScopedClient,
  memberId: string,
): Promise<MemberAuthority | null> {
  const { rows } = await client.query<MemberRow>(
    `SELECT tenant_id, id, email, display_name, role, active, approval_domains,
            per_item_limit_cents, requires_second_approver_above_cents
       FROM members
      WHERE id = $1
      LIMIT 1`,
    [memberId],
  );
  return rows[0] === undefined ? null : toMember(rows[0]);
}

export async function listMembers(
  client: TenantScopedClient,
  filters: { role?: string; domain?: string; limit: number },
): Promise<MemberAuthority[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.role !== undefined) {
    values.push(filters.role);
    where.push(`role = $${values.length}`);
  }
  if (filters.domain !== undefined) {
    values.push(filters.domain);
    where.push(`$${values.length} = ANY(approval_domains)`);
  }
  values.push(filters.limit);
  const limitIndex = values.length;
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const { rows } = await client.query<MemberRow>(
    `SELECT tenant_id, id, email, display_name, role, active, approval_domains,
            per_item_limit_cents, requires_second_approver_above_cents
       FROM members
       ${whereSql}
      ORDER BY email ASC
      LIMIT $${limitIndex}`,
    values,
  );
  return rows.map(toMember);
}

export async function insertMember(
  client: TenantScopedClient,
  input: {
    tenantId: string;
    id: string;
    email: string;
    displayName: string;
    role: "admin" | "approver" | "viewer";
    approvalDomains: ApprovalDomain[];
    perItemLimitCents: bigint;
    requiresSecondApproverAboveCents: bigint | null;
  },
): Promise<MemberAuthority> {
  const { rows } = await client.query<MemberRow>(
    `INSERT INTO members (
       tenant_id, id, email, display_name, role, active, approval_domains,
       per_item_limit_cents, requires_second_approver_above_cents
     )
     VALUES ($1,$2,lower($3),$4,$5,true,$6,$7,$8)
     RETURNING tenant_id, id, email, display_name, role, active, approval_domains,
               per_item_limit_cents, requires_second_approver_above_cents`,
    [
      input.tenantId,
      input.id,
      input.email,
      input.displayName,
      input.role,
      input.approvalDomains,
      input.perItemLimitCents.toString(),
      input.requiresSecondApproverAboveCents?.toString() ?? null,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("members insert returned no row");
  return toMember(row);
}

export async function updateMember(
  client: TenantScopedClient,
  input: {
    id: string;
    role?: "admin" | "approver" | "viewer";
    active?: boolean;
    approvalDomains?: ApprovalDomain[];
    perItemLimitCents?: bigint;
    requiresSecondApproverAboveCents?: bigint | null;
  },
): Promise<MemberAuthority | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.role !== undefined) {
    values.push(input.role);
    sets.push(`role = $${values.length}`);
  }
  if (input.active !== undefined) {
    values.push(input.active);
    sets.push(`active = $${values.length}`);
  }
  if (input.approvalDomains !== undefined) {
    values.push(input.approvalDomains);
    sets.push(`approval_domains = $${values.length}`);
  }
  if (input.perItemLimitCents !== undefined) {
    values.push(input.perItemLimitCents.toString());
    sets.push(`per_item_limit_cents = $${values.length}`);
  }
  if (Object.prototype.hasOwnProperty.call(input, "requiresSecondApproverAboveCents")) {
    values.push(input.requiresSecondApproverAboveCents?.toString() ?? null);
    sets.push(`requires_second_approver_above_cents = $${values.length}`);
  }
  if (sets.length === 0) return findMemberById(client, input.id);
  values.push(input.id);
  const idIndex = values.length;
  const { rows } = await client.query<MemberRow>(
    `UPDATE members
        SET ${sets.join(", ")}, updated_at = now()
      WHERE id = $${idIndex}
      RETURNING tenant_id, id, email, display_name, role, active, approval_domains,
                per_item_limit_cents, requires_second_approver_above_cents`,
    values,
  );
  return rows[0] === undefined ? null : toMember(rows[0]);
}

export async function countActiveAdmins(client: TenantScopedClient): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM members WHERE role = 'admin' AND active = true`,
  );
  return Number(rows[0]?.count ?? "0");
}

export async function insertMemberIdentityLink(
  client: TenantScopedClient,
  input: {
    tenantId: string;
    memberId: string;
    surface: MemberIdentitySurface;
    externalRef: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO member_identity_links (tenant_id, member_id, surface, external_ref)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, surface, external_ref)
     DO UPDATE SET member_id = EXCLUDED.member_id, linked_at = now()`,
    [input.tenantId, input.memberId, input.surface, input.externalRef],
  );
}

export async function deleteMemberIdentityLink(
  client: TenantScopedClient,
  input: { memberId: string; surface: MemberIdentitySurface; externalRef: string },
): Promise<void> {
  await client.query(
    `DELETE FROM member_identity_links
      WHERE member_id = $1 AND surface = $2 AND external_ref = $3`,
    [input.memberId, input.surface, input.externalRef],
  );
}

export async function findMemberByEmail(
  client: TenantScopedClient,
  email: string,
): Promise<MemberAuthority | null> {
  const { rows } = await client.query<MemberRow>(
    `SELECT tenant_id, id, email, display_name, role, active, approval_domains,
            per_item_limit_cents, requires_second_approver_above_cents
       FROM members
      WHERE lower(email) = lower($1)
      LIMIT 1`,
    [email],
  );
  return rows[0] === undefined ? null : toMember(rows[0]);
}

export async function findMemberByIdentityLink(
  client: TenantScopedClient,
  surface: MemberIdentitySurface,
  externalRef: string,
): Promise<MemberAuthority | null> {
  const { rows } = await client.query<MemberRow>(
    `SELECT m.tenant_id, m.id, m.email, m.display_name, m.role, m.active,
            m.approval_domains, m.per_item_limit_cents,
            m.requires_second_approver_above_cents
       FROM member_identity_links l
       JOIN members m
         ON m.tenant_id = l.tenant_id
        AND m.id = l.member_id
      WHERE l.surface = $1
        AND l.external_ref = $2
      LIMIT 1`,
    [surface, externalRef],
  );
  return rows[0] === undefined ? null : toMember(rows[0]);
}

function toMember(row: MemberRow): MemberAuthority {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    active: row.active,
    approvalDomains: row.approval_domains,
    perItemLimitCents: BigInt(row.per_item_limit_cents),
    requiresSecondApproverAboveCents:
      row.requires_second_approver_above_cents === null
        ? null
        : BigInt(row.requires_second_approver_above_cents),
  };
}
