/**
 * Canonical approver-role vocabulary for a policy `require` clause.
 *
 * There is exactly one place a signed approval role comes from at runtime:
 * `authorizeApproval` (services/execution/src/members/authorizeApproval.ts)
 * persists `approverRole` as `MemberRole` ("admin" | "approver"; never
 * "viewer" — that role is rejected upstream by `isApprovalCapableRole`).
 * "signer" is not a member role; it is the documented generic-slot token
 * (see `hasRequiredRoleQuorum` below) that any signed named role can fill.
 *
 * This is the single source of truth both @brain/policy's linter
 * (`invalid_approval_role`) and the §6 gate must agree on, so the linter
 * cannot bless a `require` clause the gate can never satisfy. Lives in
 * `shared` (the common dependency of both `@brain/policy` and
 * `services/execution`) rather than either service, to avoid a cycle.
 */
export const APPROVER_ROLE_TOKENS = ["admin", "approver", "signer"] as const;
export type ApproverRoleToken = (typeof APPROVER_ROLE_TOKENS)[number];

/**
 * Quorum check shared by the §6 gate (check 11) and `ApprovalService`. A
 * named role (e.g. "admin") must be matched by an identically-named signed
 * role and is consumed once. A "signer" entry is a generic slot: it does not
 * need to match any specific role, it just needs ONE remaining signed role
 * (named or not) that no other required role already claimed. Both call
 * sites must share this one implementation so they cannot silently diverge
 * on what counts as a satisfied approval requirement.
 */
export function hasRequiredRoleQuorum(
  requiredRoles: readonly string[],
  signedRoles: ReadonlySet<string>,
): boolean {
  const available = new Set(signedRoles);
  let signerSlots = 0;
  for (const requiredRole of requiredRoles) {
    if (requiredRole === "signer") {
      signerSlots += 1;
      continue;
    }
    if (!available.delete(requiredRole)) return false;
  }
  return available.size >= signerSlots;
}
