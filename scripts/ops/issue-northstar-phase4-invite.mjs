import { constants, createHash, createPublicKey, publicEncrypt } from "node:crypto";
import { writeFileSync } from "node:fs";

const TENANT_ID = "tnt_01M08J9B75QH08MCVA884N57VB";
const RECIPIENT_EMAIL = "braindotfi+test1@gmail.com";
const EXPECTED_PUBLIC_KEY_SHA256 =
  "05e3e5924f48e385afbd6b58334f8355c03696012887b87747f486568640a8a2";
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAsNSjWThpXRvOufxTOKQu
Kt3U3Qd7qIdP7MsMGCDGTnozstnAJWOCBMabOq9A3NgNJ11McUNyH5b9ujGpVorB
wwpaxnmiMLwLHXU0NFdi8CP2shEIOmcvkEbh+SAl3G+fRLvNRdsTECElyFZo5/q8
F8vq4iWmJ26r5QVtWcXw14x1rrkr5VbTbFZxO8SFPwV+4D1LneDf0caytZbGInoi
bEBO6763qdeuClHV/rrgOxYUIqob4ZyqgWQG8xbHX9r6oXWrM9xURqUWL3dzPpQL
3LlnNaAhSYHjMpGwDikyS8L+prCjsRAeE5qfWBkg+rvAD4FbFi5bAeNIxPRF0LlW
xWP5t5Y/P5MoFAWzzsNUBUE/g0+JWbBnoC32dm7p6rwCyG/tl/jJpY5LelSNYmDf
8mPBRu6rLYPwovqtK0nh4Qxn5PHU3YNE5nCSIomHfjwk/xoopb5dHHA+/hxASrzs
P3dtnfN187KUwdAi/aKA3RvDnw6IEoI+HDyuwG8aKtxOCZ+GXZJJTZo0oUQkO/UT
iU6TxU5KWh0g4G4C3a/86vhHjPm3SWcmNKuKas488anq3HUfEYqPXRI9RVc1TzEl
jjB/XnhSqfz+TMrGAYlRe/h5Tl4+E1IBWVIBHtRZz83zUKtyh2QoS+WYTYzFr/wd
fMlgXoq2kugnaIzS6/AboOECAwEAAQ==
-----END PUBLIC KEY-----
`;
const RESULT_PATH = process.env.NORTHSTAR_RESULT_PATH;
const bootstrapExternalRef = process.env.NORTHSTAR_BOOTSTRAP_EXTERNAL_REF;

if (!RESULT_PATH || !bootstrapExternalRef) {
  throw new Error("Northstar invite operation is missing its fixed recovery inputs");
}

function fail(message) {
  throw new Error(`Northstar invite operation failed: ${message}`);
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
  bootstrapSession.member?.role !== "admin"
) {
  fail("recovered bootstrap principal is not the Northstar active admin");
}

const adminHeaders = {
  authorization: `Bearer ${bootstrapSession.token}`,
  "content-type": "application/json",
};
const listed = await request("/members?limit=100", { headers: adminHeaders });
if (!Array.isArray(listed?.members)) fail("members response is malformed");
const existing = listed.members.find((member) => member?.email === RECIPIENT_EMAIL);
const expectedDomains = ["ap", "ar", "treasury", "payroll", "reconciliation"];
let member;
let inviteToken;
let memberChangedAuditId;
let reissue = false;

if (existing !== undefined) {
  const expectedExisting =
    existing.tenantId === TENANT_ID &&
    existing.role === "admin" &&
    existing.status === "invited" &&
    existing.active === false &&
    existing.approval?.perItemLimit === 100000000 &&
    existing.approval?.requiresSecondApproverAbove === null &&
    JSON.stringify([...(existing.approval?.domains ?? [])].sort()) ===
      JSON.stringify(expectedDomains);
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
  reissue = true;
} else {
  const created = await request("/members", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      email: RECIPIENT_EMAIL,
      display_name: "Northstar Phase 4 Test Presenter",
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
    created.invite_expires_in_hours !== 72
  ) {
    fail("member invite response is malformed or outside the fixed scope");
  }
  member = created.member;
  inviteToken = created.invite_token;
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
    member_id: member.id,
    invite_expires_in_hours: 72,
    reissue,
    status: "completed",
  }),
  { mode: 0o600 },
);
process.stdout.write(ciphertext);
