import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";

const TENANT_ID = "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ";
const RECIPIENT_EMAIL = "braindotfi@gmail.com";
const RESULT_PATH = process.env.PRODUCTION_PRESENTER_INVITE_RESULT_PATH;
const TOKEN_PATH = process.env.PRODUCTION_PRESENTER_INVITE_TOKEN_PATH;
const bootstrapExternalRef = process.env.NORTHSTAR_BOOTSTRAP_EXTERNAL_REF;

if (!RESULT_PATH || !TOKEN_PATH || !bootstrapExternalRef) {
  throw new Error("Production presenter invite operation is missing its fixed inputs");
}

function fail(message) {
  throw new Error(`Production presenter invite operation failed: ${message}`);
}

async function request(path, init) {
  const response = await fetch(`http://127.0.0.1:3000/v1${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) fail(`core returned HTTP ${response.status} for ${path}`);
  return body;
}

const platformSecret = process.env.BRAIN_PLATFORM_SERVICE_SECRET;
if (!platformSecret) fail("platform service credential is unavailable in the API container");

const bootstrapSession = await request("/sessions", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-platform-service-auth": platformSecret,
  },
  body: JSON.stringify({ external_ref: bootstrapExternalRef }),
});
if (
  typeof bootstrapSession?.token !== "string" ||
  bootstrapSession.member?.tenantId !== TENANT_ID ||
  bootstrapSession.member?.role !== "admin" ||
  bootstrapSession.member?.status !== "active"
) {
  fail("recovered bootstrap principal is not the active Northstar production admin");
}

const adminHeaders = { authorization: `Bearer ${bootstrapSession.token}` };
const listed = await request("/members?limit=100", { headers: adminHeaders });
if (!Array.isArray(listed?.members)) fail("members response is malformed");
const existing = listed.members.find(
  (member) => member?.email?.trim().toLowerCase() === RECIPIENT_EMAIL,
);
const expectedDomains = ["ap", "ar", "treasury", "payroll", "reconciliation"];
let member;
let inviteToken;
let inviteExpiresAt;
let memberChangedAuditId;
let reissue = false;

if (existing !== undefined) {
  const approvalDomains = [...(existing.approval?.domains ?? [])].sort();
  const expectedExisting =
    existing.tenantId === TENANT_ID &&
    existing.role === "admin" &&
    existing.status === "invited" &&
    existing.active === false &&
    JSON.stringify(approvalDomains) === JSON.stringify([...expectedDomains].sort()) &&
    existing.approval?.perItemLimit === 100000000 &&
    existing.approval?.requiresSecondApproverAbove === null;
  if (!expectedExisting || typeof existing.id !== "string") {
    fail("presenter member exists outside the constrained reissue state");
  }
  const reissued = await request(`/members/${existing.id}/invites`, {
    method: "POST",
    headers: adminHeaders,
  });
  if (typeof reissued?.invite_token !== "string" || typeof reissued?.expires_at !== "string") {
    fail("member invite reissue response is malformed");
  }
  member = existing;
  inviteToken = reissued.invite_token;
  inviteExpiresAt = reissued.expires_at;
  reissue = true;
} else {
  const created = await request("/members", {
    method: "POST",
    headers: { ...adminHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      email: RECIPIENT_EMAIL,
      display_name: "Damon",
      role: "admin",
      invite: true,
      approval: {
        domains: expectedDomains,
        per_item_limit_cents: "100000000",
        requires_second_approver_above_cents: null,
      },
    }),
  });
  if (
    typeof created?.invite_token !== "string" ||
    typeof created?.audit_id !== "string" ||
    typeof created?.member?.id !== "string" ||
    created.member.tenantId !== TENANT_ID ||
    created.member.role !== "admin" ||
    created.member.status !== "invited" ||
    created.invite_expires_in_hours !== 72
  ) {
    fail("member invite response is malformed or outside the fixed scope");
  }
  member = created.member;
  inviteToken = created.invite_token;
  inviteExpiresAt = null;
  memberChangedAuditId = created.audit_id;
}

const audit = await request("/audit/events?limit=500", { headers: adminHeaders });
if (!Array.isArray(audit?.events)) fail("audit response is malformed");
const memberChanged = audit.events.some(
  (event) =>
    event?.action === "member.changed" &&
    event?.outputs?.after?.id === member.id &&
    (memberChangedAuditId === undefined || event.id === memberChangedAuditId),
);
const memberInvited = audit.events.some(
  (event) =>
    event?.action === "member.invited" &&
    event?.inputs?.member_id === member.id &&
    (reissue ? event.inputs?.reissue === true : event.inputs?.reissue !== true),
);
if (!memberChanged || !memberInvited) fail("required member audit events were not persisted");

const tokenSha256 = createHash("sha256").update(inviteToken).digest("hex");
writeFileSync(TOKEN_PATH, inviteToken, { encoding: "utf8", mode: 0o600 });
chmodSync(TOKEN_PATH, 0o600);
writeFileSync(
  RESULT_PATH,
  JSON.stringify({
    tenant_id: TENANT_ID,
    email: RECIPIENT_EMAIL,
    member_id: member.id,
    expires_at: inviteExpiresAt,
    invite_expires_in_hours: 72,
    token_sha256: tokenSha256,
    token_byte_length: Buffer.byteLength(inviteToken, "utf8"),
    reissue,
    status: "completed",
  }),
  { mode: 0o600 },
);
chmodSync(RESULT_PATH, 0o600);
