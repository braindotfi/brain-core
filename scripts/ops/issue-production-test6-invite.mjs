import { constants, createHash, createPublicKey, publicEncrypt } from "node:crypto";
import { writeFileSync } from "node:fs";

const TENANT_ID = "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ";
const RECIPIENT_EMAIL = "braindotfi+test6@gmail.com";
const EXPECTED_PUBLIC_KEY_SHA256 =
  "9862158de969b874ca02ed2ea63acbfe8c7dc954f3ebc12391ac4759cd03e12a";
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAvkCWmPHh1Fl5qRMuuU8B
PGKduL83fzhQVqF4qP9m0DBsDFRd/HmWPZGNCVihGIkiQiz/Ucb5yj5Rrbtec7BG
33oZYn4U1RlRZnEYfKLMV7vgKUQtunq3CSk2qBEsWzRUWioGsFWle7ac67N4FEG/
feRQ32cWjltJ840tGU/4skqZtQlqx+CgpYWA2J47A4/6Lx4HzWTDswmZqzuLAhm3
yMp64dYSvtykmjxLcCoqmMKi/O0oBs+4kPBGCdRQfW9BeVSi6ZaIHk25ZwJaVh9Y
MLrdPNHoyXIxmYGF4FvqqpOK6q7gPhXh2h+zyfxObrj/yD2xQ64JMjarTHrjEsPw
Qx0JxpN9BWaVeRvD0XwpuV0rUEsUrWadWnS/4iQDEsAqV3HPdo/BgXsdD/G5nNmQ
GgA4xoW4WuIHYLPwHKFHux1j22iZ1QGsFvDeQnGlyCUxOY5mUomLIcXNJjNRnHGR
bcCjXtQ0UBE5cAMYCSwick3EFnVSsHHRvBb2ytIGpbAtvnmwvl4FKZmczDwah9Tb
nVL623u88uPy77qoz3JlyDCZBx5N7QmCy72HCezwFKQikKQGDutAdXRvqPl+YAR7
xuYYh5lvkxJymZPE5YjHWYsMqwAJXGbICRpzWbNbWUFiRNCTAtllj5TUjL4/f1J8
CjIu+JoXN39oFlW84+pv3PcCAwEAAQ==
-----END PUBLIC KEY-----
`;
const RESULT_PATH = process.env.PRODUCTION_TEST6_INVITE_RESULT_PATH;
const bootstrapExternalRef = process.env.NORTHSTAR_BOOTSTRAP_EXTERNAL_REF;

if (!RESULT_PATH || !bootstrapExternalRef) {
  throw new Error("Production test6 invite operation is missing its fixed inputs");
}

function fail(message) {
  throw new Error(`Production test6 invite operation failed: ${message}`);
}

async function request(path, init) {
  const response = await fetch(`http://127.0.0.1:3000/v1${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) fail(`core returned HTTP ${response.status} for ${path}`);
  return body;
}

const fingerprint = createHash("sha256")
  .update(createPublicKey(PUBLIC_KEY_PEM).export({ format: "der", type: "spki" }))
  .digest("hex");
if (fingerprint !== EXPECTED_PUBLIC_KEY_SHA256) fail("recipient public key fingerprint mismatch");

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
    fail("recipient member exists outside the constrained reissue state");
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
      display_name: "Northstar Presenter Test 6",
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
const ciphertext = publicEncrypt(
  {
    key: PUBLIC_KEY_PEM,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256",
  },
  Buffer.from(inviteToken, "utf8"),
).toString("base64");

writeFileSync(
  RESULT_PATH,
  JSON.stringify({
    tenant_id: TENANT_ID,
    email: RECIPIENT_EMAIL,
    member_id: member.id,
    expires_at: inviteExpiresAt,
    invite_expires_in_hours: 72,
    token_sha256: tokenSha256,
    public_key_sha256: fingerprint,
    reissue,
    status: "completed",
  }),
  { mode: 0o600 },
);
process.stdout.write(ciphertext);
