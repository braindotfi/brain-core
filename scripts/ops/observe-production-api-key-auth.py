#!/usr/bin/env python3
"""Observe the fixed 30-minute production API-key enablement window."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Any


OBSERVATION_SECONDS = 30 * 60
SAMPLE_SECONDS = 30
HEALTH_URL = "https://api.brain.fi/health"
API_KEY_PATTERN = re.compile(r"brain_sk_(?:test|live)_[A-Za-z0-9_-]{20,}")
MONITORED_PATH = re.compile(
    r"^/v1/(?:tenants/[^/]+/(?:keys|usage)|keys/[^/]+|ledger/|audit/|governance/|authz/probes/)"
)


class ObservationFailure(Exception):
    pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence-file", required=True)
    args = parser.parse_args()
    evidence_path = Path(args.evidence_file)
    if not evidence_path.is_file() or evidence_path.is_symlink():
        raise ObservationFailure("acceptance_evidence_file_invalid")
    evidence = json.loads(evidence_path.read_text())
    tenant_id = require_id(evidence, "tenant_id", r"^tnt_[0-9A-Z]{26}$")
    issued_id = require_id(evidence, "issued_key_id", r"^akey_[0-9A-Z]{26}$")
    rotated_id = require_id(evidence, "rotated_key_id", r"^akey_[0-9A-Z]{26}$")
    if evidence.get("tenant_cleanup_verified") is not True:
        raise ObservationFailure("acceptance_cleanup_not_verified")
    if evidence.get("key_environment") != "live" or evidence.get("scopes") != [
        "ledger:read",
        "audit:read",
        "governance:read",
    ]:
        raise ObservationFailure("acceptance_key_contract_mismatch")

    initial = runtime_sample()
    failures: list[str] = []
    samples = 0
    deadline = time.monotonic() + OBSERVATION_SECONDS
    while True:
        sample = runtime_sample()
        samples += 1
        if sample["health_ok"] is not True:
            failures.append("public_health_failed")
        if sample["redis_ok"] is not True:
            failures.append("redis_health_failed")
        if sample["api_healthy"] is not True:
            failures.append("api_container_unhealthy")
        if sample["api_key_auth_enabled"] is not True:
            failures.append("api_key_auth_became_disabled")
        if sample["pepper_present"] is not True:
            failures.append("api_key_pepper_became_missing")
        if sample["git_sha"] != initial["git_sha"]:
            failures.append("api_commit_changed")
        if sample["restart_count"] != initial["restart_count"]:
            failures.append("api_restart_count_changed")
        if failures:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(SAMPLE_SECONDS, remaining))

    final = runtime_sample()
    log_summary = summarize_logs(str(evidence.get("started_at", "")))
    database_summary = acceptance_database_summary(tenant_id, issued_id, rotated_id)

    if log_summary["api_key_shape_matches"] != 0:
        failures.append("api_key_secret_found_in_logs")
    if log_summary["monitored_5xx"] != 0:
        failures.append("monitored_route_5xx_observed")
    if log_summary["redis_error_records"] != 0:
        failures.append("api_redis_errors_observed")
    if database_summary["tenant_rows"] != 0 or database_summary["api_key_rows"] != 0:
        failures.append("acceptance_cleanup_database_residue")
    expected_audit = {
        "api_key.issued": 1,
        "api_key.rotated": 1,
        "api_key.revoked": 1,
        "tenant.deleted": 1,
    }
    for action, minimum in expected_audit.items():
        if database_summary["audit_counts"].get(action, 0) < minimum:
            failures.append(f"audit_count_missing:{action}")
    if int(evidence.get("issued_metered_requests", 0)) < 3:
        failures.append("issued_key_metering_too_low")
    if int(evidence.get("rotated_metered_requests", 0)) < 3:
        failures.append("rotated_key_metering_too_low")

    result = {
        "ok": len(failures) == 0,
        "observation_seconds": OBSERVATION_SECONDS,
        "sample_interval_seconds": SAMPLE_SECONDS,
        "samples": samples,
        "initial_runtime": initial,
        "final_runtime": final,
        "acceptance": {
            "tenant_id": tenant_id,
            "issued_key_id": issued_id,
            "rotated_key_id": rotated_id,
            "issued_metered_requests": evidence.get("issued_metered_requests"),
            "rotated_metered_requests": evidence.get("rotated_metered_requests"),
            "tenant_cleanup_verified": evidence.get("tenant_cleanup_verified"),
        },
        "logs": {
            **log_summary,
            "per_minute": {
                key: round(value / (OBSERVATION_SECONDS / 60), 4)
                for key, value in log_summary.items()
                if key.endswith("_records") or key.startswith("monitored_")
            },
        },
        "database": database_summary,
        "workflow_artifact_uploads": 0,
        "failures": sorted(set(failures)),
    }
    print(json.dumps(result, sort_keys=True))
    return 0 if result["ok"] else 1


def runtime_sample() -> dict[str, Any]:
    inspect = run(
        [
            "docker",
            "inspect",
            "--format",
            "{{json .State}}",
            "brain-prod-api",
        ]
    )
    state = json.loads(inspect)
    runtime = json.loads(
        run(
            [
                "docker",
                "exec",
                "brain-prod-api",
                "node",
                "-e",
                "process.stdout.write(JSON.stringify({git_sha:process.env.GIT_SHA??null,enabled:(process.env.BRAIN_API_KEY_AUTH_ENABLED??'false').toLowerCase()==='true',pepper_present:Boolean(process.env.BRAIN_API_KEY_PEPPER)}))",
            ]
        )
    )
    health_ok = False
    health_commit = None
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=10) as response:
            body = json.loads(response.read().decode("utf-8"))
            health_ok = response.status == 200 and body.get("ok") is True
            health_commit = body.get("commit")
    except Exception:
        health_ok = False
    redis_ok = run(
        ["docker", "exec", "brain-prod-redis", "redis-cli", "ping"], check=False
    ).strip() == "PONG"
    return {
        "health_ok": health_ok and health_commit == runtime["git_sha"],
        "health_commit": health_commit,
        "git_sha": runtime["git_sha"],
        "api_key_auth_enabled": runtime["enabled"],
        "pepper_present": runtime["pepper_present"],
        "api_healthy": state.get("Health", {}).get("Status") == "healthy",
        "restart_count": int(
            run(
                [
                    "docker",
                    "inspect",
                    "--format",
                    "{{.RestartCount}}",
                    "brain-prod-api",
                ]
            ).strip()
        ),
        "redis_ok": redis_ok,
    }


def summarize_logs(since: str) -> dict[str, int]:
    if not since.endswith("Z"):
        raise ObservationFailure("acceptance_start_timestamp_invalid")
    completed: dict[str, str] = {}
    status_by_request: dict[str, int] = {}
    auth_invalid = 0
    scope_insufficient = 0
    rate_limited = 0
    redis_errors = 0
    secret_matches = 0
    process = subprocess.run(
        ["docker", "logs", "--since", since, "brain-prod-api"],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    if process.returncode != 0:
        raise ObservationFailure("operator_command_failed:docker:logs")
    logs = process.stdout + process.stderr
    for line in logs.splitlines():
        secret_matches += len(API_KEY_PATTERN.findall(line))
        lowered = line.lower()
        auth_invalid += lowered.count("auth_invalid_key")
        scope_insufficient += lowered.count("auth_scope_insufficient")
        rate_limited += lowered.count("rate_limited") + lowered.count("rate_limit_exceeded")
        if "redis" in lowered and any(word in lowered for word in ("error", "failed", "timeout")):
            redis_errors += 1
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        request_id = str(record.get("reqId", ""))
        request = record.get("req")
        response = record.get("res")
        if request_id and isinstance(request, dict) and isinstance(request.get("url"), str):
            completed[request_id] = request["url"].split("?", 1)[0]
        if request_id and isinstance(response, dict) and isinstance(response.get("statusCode"), int):
            status_by_request[request_id] = response["statusCode"]
    monitored_4xx = 0
    monitored_5xx = 0
    for request_id, status in status_by_request.items():
        path = completed.get(request_id, "")
        if MONITORED_PATH.search(path) is None:
            continue
        monitored_4xx += int(400 <= status < 500)
        monitored_5xx += int(status >= 500)
    return {
        "auth_invalid_key_records": auth_invalid,
        "auth_scope_insufficient_records": scope_insufficient,
        "rate_limited_records": rate_limited,
        "redis_error_records": redis_errors,
        "monitored_4xx": monitored_4xx,
        "monitored_5xx": monitored_5xx,
        "api_key_shape_matches": secret_matches,
    }


def acceptance_database_summary(tenant_id: str, issued_id: str, rotated_id: str) -> dict[str, Any]:
    sql = """
BEGIN TRANSACTION READ ONLY;
SELECT json_build_object(
  'tenant_rows', (SELECT count(*) FROM tenants WHERE id = :'tenant_id'),
  'api_key_rows', (SELECT count(*) FROM api_keys WHERE tenant_id = :'tenant_id'),
  'audit_counts', COALESCE((
    SELECT json_object_agg(action, count)
      FROM (
        SELECT action, count(*) AS count
          FROM audit_events
         WHERE tenant_id = :'tenant_id'
           AND action = ANY(ARRAY['api_key.issued','api_key.rotated','api_key.revoked','tenant.deleted'])
         GROUP BY action
      ) counts
  ), '{}'::json)
)::text;
COMMIT;
"""
    output = run(
        [
            "docker",
            "exec",
            "-i",
            "brain-prod-postgres",
            "psql",
            "-X",
            "-qAt",
            "-v",
            "ON_ERROR_STOP=1",
            "-v",
            f"tenant_id={tenant_id}",
            "-v",
            f"issued_id={issued_id}",
            "-v",
            f"rotated_id={rotated_id}",
            "-U",
            "brain",
            "-d",
            "brain",
        ],
        input_text=sql,
    )
    rows = [line for line in output.splitlines() if line.strip().startswith("{")]
    if len(rows) != 1:
        raise ObservationFailure("acceptance_database_summary_invalid")
    value = json.loads(rows[0])
    return {
        "tenant_rows": int(value.get("tenant_rows", -1)),
        "api_key_rows": int(value.get("api_key_rows", -1)),
        "audit_counts": {
            str(key): int(count) for key, count in value.get("audit_counts", {}).items()
        },
        "issued_key_id": issued_id,
        "rotated_key_id": rotated_id,
    }


def require_id(value: dict[str, Any], key: str, pattern: str) -> str:
    found = value.get(key)
    if not isinstance(found, str) or re.fullmatch(pattern, found) is None:
        raise ObservationFailure(f"acceptance_{key}_invalid")
    return found


def run(
    command: list[str], *, check: bool = True, input_text: str | None = None
) -> str:
    result = subprocess.run(
        command,
        input=input_text,
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    if check and result.returncode != 0:
        raise ObservationFailure(f"operator_command_failed:{command[0]}:{command[1]}")
    return result.stdout + ("" if result.returncode == 0 else result.stderr)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ObservationFailure as err:
        print(json.dumps({"ok": False, "reason": str(err)}, sort_keys=True))
        raise SystemExit(1)
