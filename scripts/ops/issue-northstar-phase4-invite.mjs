import { constants, createHash, createPublicKey, publicEncrypt } from "node:crypto";
import { writeFileSync } from "node:fs";

const TENANT_ID = "tnt_01M0DBPNXG0TRB0SV1WTMB6F6J";
const RECIPIENT_EMAIL = "braindotfi+test5@gmail.com";
const EXPECTED_PUBLIC_KEY_SHA256 =
  "d6b1e38f91393dee8b631d5e6e36fe8338a335f5b2b49d2a22bd7eb564f00eb8";
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAsYL5R/dlsb1EWtzqHXx3
6QIHLaSM/Beydp34q9bop23xtAhITBYQB+uDDBg0Zl7TpEgJurvuUWQodGb7hRn2
L/V7NohV6C1Z9QCxMZJAW9r36mG1NM7jvyY0RfgfAGh1xUDPvabwimHGG+bZbcgc
RVcpskJTXWOaOklRYlLwuuKgm9mRrb2gQEsh2buYo4fQhustYWfQXsSZvoG301+g
Vc8HKFdrMB+es0eT2PujUzCsjNQ5jgD59u2s+29zvnIfhxrcTtwvwzOSw60FT6JO
gGwIHhMJEA6cDrwULBt8unrUzzMAaFwgYbjNm3V9s8cEDGAWLOhG9c8lb/pSpODp
zmzwPOLdx/Syq/XSpsfUym1CP2Am64SnGfEHXPHCir7kCeS9cM+NIJAKCKdtc/ev
C7+SNgmfC9NskYZvfAoGDgogtbbNFdVnX7Mch8s0uYIoOvVmWMMvEuRj6YHqLS3P
1j8PY6XWoj+/HeL+3dXqGC6qqhmo/YGMC4/KVxQX1oWDLfW/75iJk/AwxUt1e6kY
IoceR6Pby1PSHJDcmiKC86sPDhSzvW2d7INLWfvI8GOfmQiC9LITdRrurBZK2WJt
k3YqFCboIA2RAkg+U+GrqT03VG+uuTU2yetyXTCVq3nKxSRZrMSz5Vm1HOQQqfT5
q8CRqn2R8yQ0WhQ+70GnLqMCAwEAAQ==
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
    existing.active === false;
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
    headers: { ...adminHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      email: RECIPIENT_EMAIL,
      display_name: "Northstar Manual Policy Test 5",
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
