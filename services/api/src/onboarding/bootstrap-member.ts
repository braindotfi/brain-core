import type { TenantScopedClient } from "@brain/shared";

export const BOOTSTRAP_APPROVAL_DOMAINS = [
  "ap",
  "ar",
  "treasury",
  "payroll",
  "reconciliation",
] as const;

export const BOOTSTRAP_PER_ITEM_LIMIT_CENTS = "9223372036854775807";

export interface BootstrapMemberInput {
  readonly tenantId: string;
  readonly memberId: string;
  readonly email?: string | null;
  readonly displayName?: string | null;
}

export function bootstrapPlaceholderEmail(tenantId: string): string {
  return `bootstrap+${tenantId}@brain.invalid`;
}

export function bootstrapDisplayName(input: BootstrapMemberInput): string {
  const displayName = input.displayName?.trim();
  if (displayName !== undefined && displayName.length > 0) return displayName;
  const email = input.email?.trim();
  if (email !== undefined && email.length > 0) return email;
  return "Bootstrap Admin";
}

export function bootstrapEmail(input: BootstrapMemberInput): string {
  const email = input.email?.trim().toLowerCase();
  return email !== undefined && email.length > 0
    ? email
    : bootstrapPlaceholderEmail(input.tenantId);
}

export async function insertBootstrapAdminMember(
  client: TenantScopedClient,
  input: BootstrapMemberInput,
): Promise<void> {
  await client.query(
    `INSERT INTO members (
       tenant_id, id, email, display_name, role, status, active, approval_domains,
       per_item_limit_cents, requires_second_approver_above_cents
     )
     VALUES ($1, $2, $3, $4, 'admin', 'active', true, $5, $6, NULL)
     ON CONFLICT (tenant_id, id) DO NOTHING`,
    [
      input.tenantId,
      input.memberId,
      bootstrapEmail(input),
      bootstrapDisplayName(input),
      [...BOOTSTRAP_APPROVAL_DOMAINS],
      BOOTSTRAP_PER_ITEM_LIMIT_CENTS,
    ],
  );
}
