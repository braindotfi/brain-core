import { createHash, createPublicKey } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
if (listed.members.some((member) => member?.email === RECIPIENT_EMAIL)) {
  fail("recipient member already exists; refusing to issue or replace an invite");
}

const created = await request("/members", {
  method: "POST",
  headers: adminHeaders,
  body: JSON.stringify({
    email: RECIPIENT_EMAIL,
    display_name: "Northstar Phase 4 Test Presenter",
    role: "admin",
    invite: true,
    approval: {
      domains: ["ap", "ar", "treasury", "payroll", "reconciliation"],
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

const audit = await request("/audit/events?limit=500", { headers: adminHeaders });
if (!Array.isArray(audit?.events)) fail("audit response is malformed");
const memberChanged = audit.events.some(
  (event) => event?.id === created.audit_id && event?.action === "member.changed",
);
const memberInvited = audit.events.some(
  (event) => event?.action === "member.invited" && event?.inputs?.member_id === created.member.id,
);
if (!memberChanged || !memberInvited) fail("required member audit events were not persisted");

const temporaryDirectory = mkdtempSync(join(tmpdir(), "northstar-invite-key-"));
const publicKeyPath = join(temporaryDirectory, "recipient-public-key.pem");
try {
  writeFileSync(publicKeyPath, PUBLIC_KEY_PEM, { mode: 0o600 });
  chmodSync(publicKeyPath, 0o600);
  const encrypted = spawnSync(
    "openssl",
    [
      "pkeyutl",
      "-encrypt",
      "-pubin",
      "-inkey",
      publicKeyPath,
      "-pkeyopt",
      "rsa_padding_mode:oaep",
      "-pkeyopt",
      "rsa_oaep_md:sha256",
    ],
    { input: created.invite_token },
  );
  if (encrypted.status !== 0) fail("invite token encryption failed");
  writeFileSync(
    RESULT_PATH,
    JSON.stringify({
      member_id: created.member.id,
      member_changed_audit_id: created.audit_id,
      invite_expires_in_hours: created.invite_expires_in_hours,
      status: "completed",
    }),
    { mode: 0o600 },
  );
  process.stdout.write(encrypted.stdout.toString("base64"));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
