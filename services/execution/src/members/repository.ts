import { withTenantScope, type TenantScopedClient } from "@brain/shared";
import type { Pool } from "pg";
import type { ApprovalDomain, MemberAuthority, MemberIdentitySurface, MemberLookup } from "./types.js";

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

  public async findMemberById(
    tenantId: string,
    memberId: string,
  ): Promise<MemberAuthority | null> {
    return withTenantScope(this.pool, tenantId, (c) => findMemberById(c, memberId));
  }

  public async findMemberByEmail(
    tenantId: string,
    email: string,
  ): Promise<MemberAuthority | null> {
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
