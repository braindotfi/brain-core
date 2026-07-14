# Production Tenancy, Sessions, and Invites

Production counterpart to the demo provision fence. The tenant is the company; members are
the humans in it. Colleagues JOIN a tenant via invites - signup never creates a second
universe for an invited user. The demo fence remains, structurally separate, for the
playground only.

## Principals and paths

- PLATFORM SERVICE CREDENTIAL: a machine credential held by the platform BFF, scoped to
  tenant:create, session:exchange, invite:consume. It identifies the platform, never a
  human. It can mint nothing that approves.
- Production tenants are created ONLY via POST /v1/tenants with the service credential.
  The demo fence (/demo/provision-run) can NEVER create a production tenant; production
  tenants carry no TTL and are exempt from demo cleanup sweeps. tenant.kind:
  "production" | "demo", immutable.

## Tenant lifecycle

POST /v1/tenants (auth: platform service credential)
body: { company_name, founder: { email, display_name }, founder_external_ref }
-> 201 { tenant_id, member: {...bootstrap admin...}, session: { token, refresh_token,
expires_in }, agent: {...propose-only production BFF service agent...} }
Semantics: atomic - tenant + bootstrap admin member (role admin, all domains, high limit,
active) + identity link (surface "platform", external_ref = founder_external_ref) + session +
production BFF service agent + initial agent token, one transaction. No seeded data. Audit:
tenant.created, member.changed, auth.production_agent_token.minted.

## Sessions (exchange model; ACTOR = SESSION preserved)

POST /v1/sessions (auth: platform service credential)
body: { external_ref }
-> 200 { token, refresh_token, expires_in, member: { id, role, approval } }
-> 403 { reason: "session_identity_unlinked" } when no identity link matches - the
platform must treat this as "not a member of any tenant", never auto-provision.
POST /v1/sessions/refresh { refresh_token } -> rotated pair; reuse of a rotated refresh
token revokes the family. DELETE /v1/sessions (token) -> revoke.
Token: principal_type "user", member claim, verification "session". Actor derived from the
token ONLY; payload actor stripped (unchanged rule). Demo tokens keep their short TTL;
production sessions are long-lived via refresh.

## Invites (how a colleague joins THE tenant)

Member gains status: "invited" | "active" | "deactivated" (replaces the bare active
boolean; the bootstrap admin is born active). INVITED members fail gate check 1 (not
active): they cannot approve, hold no session, and do not count toward last-admin.

POST /v1/members (existing, admin-gated) with { email, display_name, role, approval,
invite: true } -> 201 member with status "invited" + first invite issued.
POST /v1/members/{id}/invites (admin) -> { invite_token, expires_at } - token returned
ONCE, stored hashed, single-use, default expiry 72h. Reissue revokes prior outstanding
invites for the member.
DELETE /v1/members/{id}/invites (admin) -> revoke outstanding.
POST /v1/invites/consume (auth: platform service credential)
body: { invite_token, external_ref, display_name? }
-> 200 { tenant_id, member, session } - atomic: validate token (unexpired, unconsumed,
unrevoked, member still invited) + create identity link + member -> active + issue
session, one transaction.
-> 403 reasons: "invite_invalid" | "invite_expired" | "invite_consumed" |
"invite_revoked" (exact strings; expired/consumed/revoked only after the token itself
matches - never confirm token validity on a bad token).
Consuming an invite can never change role or envelope: authority is fixed by the admin who
created the member. Audit: member.invited, invite.consumed, invite.revoked. Webhooks:
member.changed carries status transitions.

## Reconciliation with service-token

POST /v1/auth/service-token remains a sandbox and testnet BFF break-glass credential for
agent propose-only workflows. It is not a production user-session exchange path, it does not
mint member-resolvable user tokens, and it must reject tenant.kind = "production".

Production tenants have their own agent path, governed by
`docs/contracts/production-agents.md`: POST /v1/tenants creates the initial production BFF
service agent and token, and POST /v1/tenants/{tenant_id}/agent-token returns or rotates that
agent token. These paths are mutually exclusive by tenant.kind. The production path for human
sessions remains POST /v1/sessions.

## Invariants (pinned by tests)

1. Every production tenant is created with exactly one active bootstrap admin, atomically.
2. The demo fence cannot create tenant.kind "production"; no production tenant is ever
   swept by demo cleanup; POST /v1/tenants rejects demo-fence auth.
3. Invite tokens: hashed at rest, single-use, expiring; consume is one transaction; a
   consumed/revoked/expired token can never create a link or session.
4. Consume never escalates: member role/envelope byte-identical before and after.
5. Invited members: cannot approve (gate check 1), cannot hold sessions, excluded from
   last-admin counting; last-admin guard still blocks deactivating/demoting the last
   ACTIVE admin.
6. Session exchange with an unlinked external_ref returns session_identity_unlinked and
   creates nothing.
7. Actor is never read from any payload on any path in this contract (existing rule,
   re-asserted here).
8. Agent principals remain never member-resolvable (unchanged; re-pinned).
9. Production tenants use `docs/contracts/production-agents.md` for propose-only agent
   principals; they never use POST /v1/auth/service-token.
