#!/usr/bin/env python3
"""Exercise production tenant API-key auth without retaining test data or secrets."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PRODUCTION_HEALTH_URL = "https://api.brain.fi/health"
APPROVED_SCOPES = ["ledger:read", "audit:read", "governance:read"]
SECRET_PATTERN = re.compile(r"brain_sk_(?:test|live)_[A-Za-z0-9_-]{20,}")


@dataclass
class Response:
    status: int
    body: Any


class AcceptanceFailure(Exception):
    pass


class AcceptanceRun:
    def __init__(self, env_file: Path, health_url: str, evidence_file: Path) -> None:
        if health_url != PRODUCTION_HEALTH_URL:
            raise AcceptanceFailure("production_health_url_mismatch")
        if env_file.name != ".env.api.prod" or not env_file.is_file() or env_file.is_symlink():
            raise AcceptanceFailure("production_env_file_boundary_failed")
        self.env_file = env_file
        self.base = api_base(health_url)
        self.evidence_file = evidence_file
        self.started_at = utc_now()
        self.tenant_id: str | None = None
        self.admin_token: str | None = None
        self.issued_id: str | None = None
        self.issued_secret: str | None = None
        self.rotated_id: str | None = None
        self.rotated_secret: str | None = None
        self.secrets: set[str] = set()
        self.cleanup_verified = False

        env = read_env(env_file)
        self.platform_secret = require_env(env, "BRAIN_PLATFORM_SERVICE_SECRET")
        self.pepper = require_env(env, "BRAIN_API_KEY_PEPPER")
        self.secrets.update({self.platform_secret, self.pepper})

    def execute(self) -> dict[str, Any]:
        nonce = f"{int(time.time())}-{uuid.uuid4().hex[:12]}"
        external_ref = f"production-api-key-acceptance-{nonce}"
        created = request_json(
            "POST",
            f"{self.base}/tenants",
            headers={"X-Platform-Service-Auth": self.platform_secret},
            payload={
                "company_name": f"Disposable API key acceptance {nonce}",
                "founder": {
                    "email": f"api-key-acceptance-{nonce}@brain.invalid",
                    "display_name": "API Key Acceptance",
                },
                "founder_external_ref": external_ref,
            },
        )
        require_status(created, 201, "tenant_create_failed")
        self.tenant_id = require_field(created.body, "tenant_id", "tenant_id_missing")
        self.admin_token = session_token_from_create(created.body)
        if self.admin_token is None:
            raise AcceptanceFailure("tenant_create_session_missing")
        self.secrets.add(self.admin_token)
        remember_response_secrets(created.body, self.secrets)

        issued = request_json(
            "POST",
            f"{self.base}/tenants/{self.tenant_id}/keys",
            token=self.admin_token,
            payload={
                "name": "production disposable acceptance",
                "environment": "live",
                "scopes": APPROVED_SCOPES,
            },
        )
        require_status(issued, 201, "api_key_issue_failed")
        self.issued_id = require_field(issued.body, "id", "issued_key_id_missing")
        self.issued_secret = require_field(issued.body, "secret", "issued_key_secret_missing")
        self.secrets.add(self.issued_secret)
        require_live_key_contract(issued.body, self.issued_secret)

        initial_reads = exercise_read_surface(self.base, self.issued_secret)
        require_approve_probe_denied(self.base, self.issued_secret)
        issued_usage = wait_for_usage(self.base, self.tenant_id, self.issued_id, self.admin_token)
        require_metered_operations(
            issued_usage,
            {"listAccounts", "queryAuditEvents", "listGovernanceAgents"},
        )

        rotated = request_json(
            "POST", f"{self.base}/keys/{self.issued_id}/rotate", token=self.admin_token
        )
        require_status(rotated, 201, "api_key_rotate_failed")
        self.rotated_id = require_field(rotated.body, "id", "rotated_key_id_missing")
        self.rotated_secret = require_field(
            rotated.body, "secret", "rotated_key_secret_missing"
        )
        self.secrets.add(self.rotated_secret)
        require_live_key_contract(rotated.body, self.rotated_secret)

        require_invalid_key(
            request_json("GET", f"{self.base}/ledger/accounts", token=self.issued_secret),
            "rotated_predecessor_not_rejected",
        )
        rotated_reads = exercise_read_surface(self.base, self.rotated_secret)
        require_approve_probe_denied(self.base, self.rotated_secret)
        rotated_usage = wait_for_usage(
            self.base, self.tenant_id, self.rotated_id, self.admin_token
        )
        require_metered_operations(
            rotated_usage,
            {"listAccounts", "queryAuditEvents", "listGovernanceAgents"},
        )

        revoked = request_json(
            "DELETE", f"{self.base}/keys/{self.rotated_id}", token=self.admin_token
        )
        require_status(revoked, 204, "api_key_revoke_failed")
        require_invalid_key(
            request_json("GET", f"{self.base}/ledger/accounts", token=self.rotated_secret),
            "revoked_replacement_not_rejected",
        )

        lifecycle_counts = wait_for_lifecycle_audit(
            self.base,
            self.admin_token,
            self.issued_id,
            self.rotated_id,
        )
        return {
            "ok": True,
            "started_at": self.started_at,
            "completed_at": utc_now(),
            "tenant_id": self.tenant_id,
            "issued_key_id": self.issued_id,
            "rotated_key_id": self.rotated_id,
            "key_environment": "live",
            "key_prefix": "brain_sk_live_",
            "scopes": APPROVED_SCOPES,
            "initial_read_statuses": initial_reads,
            "rotated_read_statuses": rotated_reads,
            "payment_approve_probe_status": 403,
            "issued_metered_requests": int(issued_usage.get("total_requests", 0)),
            "rotated_metered_requests": int(rotated_usage.get("total_requests", 0)),
            "lifecycle_audit_counts": lifecycle_counts,
            "workflow_artifact_uploads": 0,
        }

    def cleanup(self) -> None:
        failures: list[str] = []
        if self.admin_token is not None:
            for key_id in (self.rotated_id, self.issued_id):
                if key_id is None:
                    continue
                response = request_json(
                    "DELETE", f"{self.base}/keys/{key_id}", token=self.admin_token
                )
                if response.status not in {204, 404}:
                    failures.append(f"key_cleanup_status_{response.status}")

        if self.tenant_id is not None and self.admin_token is not None:
            deleted = request_json(
                "DELETE",
                f"{self.base}/tenants/{self.tenant_id}",
                token=self.admin_token,
                payload={"confirm": self.tenant_id},
            )
            if deleted.status != 200:
                failures.append(f"tenant_cleanup_status_{deleted.status}")
            else:
                provenance = request_json(
                    "GET",
                    f"{self.base}/tenants/{self.tenant_id}/provenance",
                    headers={"X-Platform-Service-Auth": self.platform_secret},
                )
                if provenance.status != 404:
                    failures.append(f"tenant_cleanup_provenance_status_{provenance.status}")
                else:
                    self.cleanup_verified = True
        if failures:
            raise AcceptanceFailure("cleanup_failed:" + ",".join(failures))

    def write_evidence(self, evidence: dict[str, Any]) -> None:
        evidence["tenant_cleanup_verified"] = self.cleanup_verified
        serialized = json.dumps(evidence, sort_keys=True)
        assert_redacted(serialized, self.secrets)
        self.evidence_file.parent.mkdir(parents=True, exist_ok=True)
        self.evidence_file.write_text(serialized + "\n")
        self.evidence_file.chmod(0o600)
        print(serialized)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--health-url", required=True)
    parser.add_argument("--evidence-file", required=True)
    args = parser.parse_args()

    run: AcceptanceRun | None = None
    evidence: dict[str, Any] | None = None
    primary_error: Exception | None = None
    cleanup_error: Exception | None = None
    try:
        run = AcceptanceRun(Path(args.env_file), args.health_url, Path(args.evidence_file))
        evidence = run.execute()
    except Exception as err:  # cleanup must run for every partial lifecycle
        primary_error = err
    finally:
        if run is not None:
            try:
                run.cleanup()
            except Exception as err:
                cleanup_error = err

    redaction_error: Exception | None = None
    if run is not None:
        try:
            redaction = verify_container_log_redaction(run.started_at, run.secrets)
            if evidence is not None:
                evidence["container_log_redaction"] = redaction
        except Exception as err:
            redaction_error = err

    if primary_error is not None or cleanup_error is not None or redaction_error is not None:
        reasons = [
            safe_exception(primary_error),
            safe_exception(cleanup_error),
            safe_exception(redaction_error),
        ]
        reason = ";".join(value for value in reasons if value is not None)
        if run is not None:
            assert_redacted(reason, run.secrets)
        print(json.dumps({"ok": False, "reason": reason}, sort_keys=True), file=sys.stderr)
        return 1
    if run is None or evidence is None:
        raise AcceptanceFailure("acceptance_state_missing")
    run.write_evidence(evidence)
    return 0


def exercise_read_surface(base: str, token: str) -> dict[str, int]:
    calls = {
        "ledger": f"{base}/ledger/accounts",
        "audit": f"{base}/audit/events?limit=10",
        "governance": f"{base}/governance/agents?limit=10",
    }
    statuses: dict[str, int] = {}
    for name, url in calls.items():
        response = request_json("GET", url, token=token)
        require_status(response, 200, f"{name}_read_failed")
        statuses[name] = response.status
    return statuses


def require_approve_probe_denied(base: str, token: str) -> None:
    response = request_json(
        "GET", f"{base}/authz/probes/payment-intent-approve", token=token
    )
    require_status(response, 403, "payment_approve_probe_not_denied")
    require_error_code(response, "auth_scope_insufficient", "payment_approve_probe_wrong_error")


def wait_for_usage(
    base: str, tenant_id: str, key_id: str, admin_token: str
) -> dict[str, Any]:
    quoted_key = urllib.parse.quote(key_id, safe="")
    url = f"{base}/tenants/{tenant_id}/usage?window=30d&environment=live&key_id={quoted_key}"
    for _ in range(10):
        response = request_json("GET", url, token=admin_token)
        require_status(response, 200, "api_key_usage_failed")
        if isinstance(response.body, dict) and int(response.body.get("total_requests", 0)) > 0:
            keys = response.body.get("keys")
            if not isinstance(keys, list) or not any(
                isinstance(item, dict)
                and item.get("key_id") == key_id
                and item.get("environment") == "live"
                for item in keys
            ):
                raise AcceptanceFailure("usage_key_attribution_mismatch")
            return response.body
        time.sleep(2)
    raise AcceptanceFailure("usage_missing_after_key_requests")


def require_metered_operations(usage: dict[str, Any], expected: set[str]) -> None:
    breakdowns = usage.get("breakdowns")
    routes = breakdowns.get("routes") if isinstance(breakdowns, dict) else None
    if not isinstance(routes, list):
        raise AcceptanceFailure("metered_route_breakdown_missing")
    found = {
        str(item.get("operation_id"))
        for item in routes
        if isinstance(item, dict)
    }
    missing = sorted(expected - found)
    if missing:
        raise AcceptanceFailure("metered_operations_missing:" + ",".join(missing))


def wait_for_lifecycle_audit(
    base: str, admin_token: str, issued_id: str, rotated_id: str
) -> dict[str, int]:
    expected = {"api_key.issued": 1, "api_key.rotated": 1, "api_key.revoked": 1}
    for _ in range(10):
        response = request_json("GET", f"{base}/audit/events?limit=100", token=admin_token)
        require_status(response, 200, "lifecycle_audit_read_failed")
        events = response.body.get("events") if isinstance(response.body, dict) else None
        counts = {action: 0 for action in expected}
        if isinstance(events, list):
            for event in events:
                if not isinstance(event, dict) or event.get("action") not in counts:
                    continue
                action = str(event["action"])
                payload = json.dumps(
                    {"inputs": event.get("inputs"), "outputs": event.get("outputs")},
                    sort_keys=True,
                )
                if issued_id in payload or rotated_id in payload:
                    counts[action] += 1
        if all(counts[action] >= minimum for action, minimum in expected.items()):
            return counts
        time.sleep(2)
    raise AcceptanceFailure("lifecycle_audit_evidence_missing")


def verify_container_log_redaction(started_at: str, secrets: set[str]) -> dict[str, Any]:
    result = subprocess.run(
        ["docker", "logs", "--since", started_at, "brain-prod-api"],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    if result.returncode != 0:
        raise AcceptanceFailure("container_log_read_failed")
    logs = result.stdout + result.stderr
    assert_redacted(logs, secrets)
    if SECRET_PATTERN.search(logs) is not None:
        raise AcceptanceFailure("container_log_contains_api_key_shape")
    return {"checked": True, "secret_matches": 0, "api_key_shape_matches": 0}


def require_live_key_contract(body: Any, secret: str) -> None:
    if not secret.startswith("brain_sk_live_"):
        raise AcceptanceFailure("live_key_prefix_mismatch")
    if not isinstance(body, dict) or body.get("environment") != "live":
        raise AcceptanceFailure("live_key_environment_mismatch")
    scopes = body.get("scopes")
    if not isinstance(scopes, list) or sorted(scopes) != sorted(APPROVED_SCOPES):
        raise AcceptanceFailure("live_key_scope_mismatch")


def require_invalid_key(response: Response, reason: str) -> None:
    require_status(response, 401, reason)
    require_error_code(response, "auth_invalid_key", reason + "_wrong_error")


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
    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            text = response.read().decode("utf-8", errors="replace")
            return Response(response.status, parse_body(text))
    except urllib.error.HTTPError as err:
        text = err.read().decode("utf-8", errors="replace")
        return Response(err.code, parse_body(text))
    except urllib.error.URLError as err:
        raise AcceptanceFailure(f"request_failed:{method}:{redact_url(url)}") from err


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


def require_env(env: dict[str, str], key: str) -> str:
    value = env.get(key)
    if value is None or value == "":
        raise AcceptanceFailure(f"required_production_config_missing:{key}")
    return value


def require_status(response: Response, expected: int, reason: str) -> None:
    if response.status != expected:
        code = error_code(response)
        raise AcceptanceFailure(f"{reason}:status={response.status}:code={code}")


def require_error_code(response: Response, expected: str, reason: str) -> None:
    code = error_code(response)
    if code != expected:
        raise AcceptanceFailure(f"{reason}:code={code}")


def error_code(response: Response) -> str | None:
    if not isinstance(response.body, dict):
        return None
    error = response.body.get("error")
    return error.get("code") if isinstance(error, dict) else None


def require_field(body: Any, name: str, reason: str) -> str:
    value = body.get(name) if isinstance(body, dict) else None
    if not isinstance(value, str) or value == "":
        raise AcceptanceFailure(reason)
    return value


def session_token_from_create(body: Any) -> str | None:
    session = body.get("session") if isinstance(body, dict) else None
    token = session.get("token") if isinstance(session, dict) else None
    return token if isinstance(token, str) and token != "" else None


def remember_response_secrets(body: Any, secrets: set[str]) -> None:
    if not isinstance(body, dict):
        return
    for container_name in ("session", "agent"):
        container = body.get(container_name)
        if not isinstance(container, dict):
            continue
        for field in ("token", "refresh_token", "secret"):
            value = container.get(field)
            if isinstance(value, str) and value != "":
                secrets.add(value)


def assert_redacted(text: str, secrets: set[str]) -> None:
    if any(secret != "" and secret in text for secret in secrets):
        raise AcceptanceFailure("secret_redaction_check_failed")


def parse_body(text: str) -> Any:
    if text == "":
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def api_base(health_url: str) -> str:
    parsed = urllib.parse.urlparse(health_url)
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, "/v1", "", "", ""))


def redact_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def safe_exception(err: Exception | None) -> str | None:
    if err is None:
        return None
    return str(err)[:500]


if __name__ == "__main__":
    raise SystemExit(main())
