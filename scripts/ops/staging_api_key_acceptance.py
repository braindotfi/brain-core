#!/usr/bin/env python3
"""Run the staging API key lifecycle acceptance test without printing secrets."""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class Response:
    status: int
    body: Any
    text: str


class AcceptanceFailure(Exception):
    pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--health-url", required=True)
    args = parser.parse_args()

    env = read_env(Path(args.env_file))
    platform_secret = env.get("BRAIN_PLATFORM_SERVICE_SECRET")
    if platform_secret is None or platform_secret == "":
        raise AcceptanceFailure("missing BRAIN_PLATFORM_SERVICE_SECRET in staging env")

    base = api_base(args.health_url)
    nonce = str(int(time.time()))
    email = f"api-key-acceptance-{nonce}@brain.invalid"
    external_ref = f"api-key-acceptance-{nonce}"

    created = request_json(
        "POST",
        f"{base}/tenants",
        headers={"X-Platform-Service-Auth": platform_secret},
        payload={
            "company_name": f"API key staging acceptance {nonce}",
            "founder": {"email": email, "display_name": "API Key Acceptance"},
            "founder_external_ref": external_ref,
        },
    )
    require_status(created, 201, "tenant_create_failed")
    tenant_id = require_field(created.body, "tenant_id", "tenant_create_missing_tenant_id")
    admin_token = session_token_from_create(created.body)
    if admin_token is None:
        session = request_json(
            "POST",
            f"{base}/sessions",
            headers={"X-Platform-Service-Auth": platform_secret},
            payload={
                "external_ref": external_ref,
                "scopes": ["ledger:read", "audit:read", "execution:admin"],
            },
        )
        require_status(session, 200, "session_exchange_failed")
        admin_token = require_field(session.body, "token", "session_exchange_missing_token")

    issued = request_json(
        "POST",
        f"{base}/tenants/{tenant_id}/keys",
        token=admin_token,
        payload={
            "name": "staging acceptance",
            "environment": "sandbox",
            "scopes": ["ledger:read", "audit:read"],
        },
    )

    require_status(issued, 201, "api_key_issue_failed")
    issued_id = require_field(issued.body, "id", "api_key_issue_missing_id")
    issued_secret = require_field(issued.body, "secret", "api_key_issue_missing_secret")

    direct = request_json("GET", f"{base}/ledger/accounts", token=issued_secret)
    require_status(direct, 200, "api_key_request_failed")

    usage = wait_for_usage(base, tenant_id, issued_id, admin_token)
    if usage is None:
        raise AcceptanceFailure(f"usage_missing_after_key_request key_id={issued_id}")

    rotated = request_json("POST", f"{base}/keys/{issued_id}/rotate", token=admin_token)
    require_status(rotated, 201, "api_key_rotate_failed")
    rotated_id = require_field(rotated.body, "id", "api_key_rotate_missing_id")
    rotated_secret = require_field(rotated.body, "secret", "api_key_rotate_missing_secret")

    old_rejected = request_json("GET", f"{base}/ledger/accounts", token=issued_secret)
    require_status(old_rejected, 401, "api_key_old_key_not_rejected")
    require_error_code(old_rejected, "auth_invalid_key", "api_key_old_key_wrong_error")

    revoked = request_json("DELETE", f"{base}/keys/{rotated_id}", token=admin_token)
    require_status(revoked, 204, "api_key_revoke_failed")

    new_rejected = request_json("GET", f"{base}/ledger/accounts", token=rotated_secret)
    require_status(new_rejected, 401, "api_key_revoked_key_not_rejected")
    require_error_code(new_rejected, "auth_invalid_key", "api_key_revoked_key_wrong_error")

    print(
        json.dumps(
            {
                "ok": True,
                "tenant_id": tenant_id,
                "issued_key_id": issued_id,
                "rotated_key_id": rotated_id,
                "usage_total_events": usage["total_events"],
            },
            sort_keys=True,
        )
    )
    return 0


def read_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if stripped == "" or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        env[key.strip()] = value
    return env


def api_base(health_url: str) -> str:
    parsed = urllib.parse.urlparse(health_url)
    if parsed.scheme == "" or parsed.netloc == "":
        raise AcceptanceFailure(f"invalid health url: {health_url}")
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, "/v1", "", "", ""))


def request_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    payload: Any | None = None,
    token: str | None = None,
) -> Response:
    request_headers = {"Accept": "application/json"}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    if token is not None:
        request_headers["Authorization"] = f"Bearer {token}"
    if headers is not None:
        request_headers.update(headers)

    req = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            text = res.read().decode("utf-8", errors="replace")
            return Response(res.status, parse_body(text), text)
    except urllib.error.HTTPError as err:
        text = err.read().decode("utf-8", errors="replace")
        return Response(err.code, parse_body(text), text)
    except urllib.error.URLError as err:
        raise AcceptanceFailure(f"request_failed {method} {redact_query(url)}: {err}") from err


def parse_body(text: str) -> Any:
    if text == "":
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def wait_for_usage(
    base: str,
    tenant_id: str,
    key_id: str,
    admin_token: str,
) -> dict[str, Any] | None:
    quoted_key = urllib.parse.quote(key_id, safe="")
    url = f"{base}/tenants/{tenant_id}/usage?window=30d&environment=sandbox&key_id={quoted_key}"
    last: Response | None = None
    for _ in range(6):
        last = request_json("GET", url, token=admin_token)
        require_status(last, 200, "api_key_usage_failed")
        body = last.body
        if isinstance(body, dict) and int(body.get("total_events", 0)) > 0:
            return body
        time.sleep(2)
    if last is not None:
        print(json.dumps({"usage_response": safe_usage(last.body)}, sort_keys=True))
    return None


def require_status(response: Response, expected: int, reason: str) -> None:
    if response.status != expected:
        raise AcceptanceFailure(
            f"{reason} status={response.status} body={short_body(response.body)}"
        )


def require_field(value: Any, field: str, reason: str) -> str:
    if not isinstance(value, dict):
        raise AcceptanceFailure(f"{reason} parent_type={type(value).__name__}")
    found = value.get(field)
    if not isinstance(found, str) or found == "":
        raise AcceptanceFailure(f"{reason} field={field}")
    return found


def session_token_from_create(body: Any) -> str | None:
    if not isinstance(body, dict):
        return None
    session = body.get("session")
    if not isinstance(session, dict):
        return None
    token = session.get("token")
    return token if isinstance(token, str) and token != "" else None


def require_error_code(response: Response, expected: str, reason: str) -> None:
    body = response.body
    code = body.get("error", {}).get("code") if isinstance(body, dict) else None
    if code != expected:
        raise AcceptanceFailure(f"{reason} code={code!r} body={short_body(body)}")


def safe_usage(body: Any) -> Any:
    if not isinstance(body, dict):
        return body
    return {
        "key_id": body.get("key_id"),
        "total_events": body.get("total_events"),
        "keys": body.get("keys"),
    }


def short_body(body: Any) -> str:
    text = json.dumps(body, sort_keys=True) if not isinstance(body, str) else body
    return text[:500]


def redact_query(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AcceptanceFailure as err:
        print(json.dumps({"ok": False, "reason": str(err)}, sort_keys=True), file=sys.stderr)
        raise SystemExit(1)
