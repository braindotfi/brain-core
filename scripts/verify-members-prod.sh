#!/usr/bin/env bash
set -euo pipefail

API_BASE="${BRAIN_API_BASE:-https://api.brain.fi}"
SECRET="${BRAIN_DEMO_PROVISION_SECRET:-}"

if [[ -z "${SECRET}" ]]; then
  echo "BRAIN_DEMO_PROVISION_SECRET is required" >&2
  exit 2
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

provision_body="${tmpdir}/provision.json"
member_body="${tmpdir}/member.json"
agent_body="${tmpdir}/agent.json"

provision_status="$(
  curl -sS -o "${provision_body}" -w "%{http_code}" \
    -X POST "${API_BASE}/v1/demo/provision-run" \
    -H "X-Demo-Provision-Auth: ${SECRET}" \
    -H "Content-Type: application/json"
)"

member_token="$(
  python3 - "${provision_body}" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    body = json.load(fh)
tokens = body.get("tokens") or {}
print(((tokens.get("member") or {}).get("token")) or body.get("member_token") or "")
PY
)"

agent_token="$(
  python3 - "${provision_body}" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    body = json.load(fh)
tokens = body.get("tokens") or {}
print(((tokens.get("agent") or {}).get("token")) or body.get("agent_token") or body.get("token") or "")
PY
)"

if [[ "${provision_status}" != "201" || -z "${member_token}" || -z "${agent_token}" ]]; then
  echo "PROVISION_STATUS=${provision_status}"
  echo "PROVISION_BODY=$(cat "${provision_body}")"
  echo "Provision failed or did not return both tokens" >&2
  exit 1
fi

members_status="$(
  curl -sS -o "${member_body}" -w "%{http_code}" \
    "${API_BASE}/v1/members" \
    -H "Authorization: Bearer ${member_token}"
)"

agent_members_status="$(
  curl -sS -o "${agent_body}" -w "%{http_code}" \
    "${API_BASE}/v1/members" \
    -H "Authorization: Bearer ${agent_token}"
)"

echo "PROVISION_STATUS=${provision_status}"
echo "PROVISION_BODY_REDACTED=$(python3 - "${provision_body}" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    body = json.load(fh)

tokens = body.get("tokens") or {}
if "member_token" in body:
    body["member_token"] = "<redacted>"
if "agent_token" in body:
    body["agent_token"] = "<redacted>"
if "token" in body:
    body["token"] = "<redacted>"
if "member" in tokens and "token" in tokens["member"]:
    tokens["member"]["token"] = "<redacted>"
if "agent" in tokens and "token" in tokens["agent"]:
    tokens["agent"]["token"] = "<redacted>"

print(json.dumps(body, sort_keys=True))
PY
)"
echo "MEMBER_GET_STATUS=${members_status}"
echo "MEMBER_GET_BODY=$(cat "${member_body}")"
echo "AGENT_GET_STATUS=${agent_members_status}"
echo "AGENT_GET_BODY=$(cat "${agent_body}")"

python3 - "${member_body}" "${agent_body}" "${members_status}" "${agent_members_status}" <<'PY'
import json
import sys

member_body_path, agent_body_path, members_status, agent_status = sys.argv[1:5]
ok = True

with open(member_body_path, "r", encoding="utf-8") as fh:
    member_body = json.load(fh)
members = member_body.get("members")
if members_status != "200" or not isinstance(members, list) or len(members) != 1:
    ok = False
else:
    member = members[0]
    if member.get("role") != "admin" or member.get("active") is not True:
        ok = False

with open(agent_body_path, "r", encoding="utf-8") as fh:
    agent_body = json.load(fh)
reason = ((agent_body.get("error") or {}).get("details") or {}).get("reason")
code = (agent_body.get("error") or {}).get("code")
if agent_status != "403" or (reason != "actor_unresolved" and code != "payment_intent_approval_invalid"):
    ok = False

if not ok:
    raise SystemExit(1)
PY

echo "RESULT=PASS"
