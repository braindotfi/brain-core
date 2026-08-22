#!/usr/bin/env bash
set -euo pipefail

readonly tenant_id="tnt_01M0DBPNXG0TRB0SV1WTMB6F6J"
readonly exact_email="braindotfi+test5@gmail.com"
readonly base_email="braindotfi@gmail.com"

db_payload="$({
  docker exec brain-prod-postgres psql -X -qAt -v ON_ERROR_STOP=1 -U brain -d brain -c "
    BEGIN TRANSACTION READ ONLY;
    SET LOCAL statement_timeout = '5s';
    SET LOCAL lock_timeout = '1s';
    WITH matching AS (
      SELECT m.email,
             i.member_id,
             i.created_at,
             i.expires_at,
             i.consumed_at,
             i.revoked_at,
             m.status AS member_status,
             m.active AS member_active,
             CASE
               WHEN i.consumed_at IS NOT NULL THEN 'invite_consumed'
               WHEN i.revoked_at IS NOT NULL THEN 'invite_revoked'
               WHEN m.status <> 'invited' THEN 'invite_revoked'
               WHEN i.expires_at <= now() THEN 'invite_expired'
               ELSE 'valid'
             END AS state
        FROM members m
        LEFT JOIN member_invites i
          ON i.tenant_id = m.tenant_id
         AND i.member_id = m.id
       WHERE m.tenant_id = '$tenant_id'
         AND lower(btrim(m.email)) IN ('$exact_email', '$base_email')
       ORDER BY i.created_at DESC NULLS LAST
    )
    SELECT json_build_object(
      'server_now', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
      'database', current_database(),
      'database_user', current_user,
      'database_in_recovery', pg_is_in_recovery(),
      'tenant_id', '$tenant_id',
      'tenant_exists', EXISTS (SELECT 1 FROM tenants WHERE id = '$tenant_id'),
      'exact_email', '$exact_email',
      'exact_member_count', (SELECT COUNT(*) FROM members WHERE tenant_id = '$tenant_id' AND lower(btrim(email)) = '$exact_email'),
      'base_email_member_count', (SELECT COUNT(*) FROM members WHERE tenant_id = '$tenant_id' AND lower(btrim(email)) = '$base_email'),
      'matching_rows', COALESCE(
        (SELECT json_agg(json_build_object(
          'email', email,
          'member_id', member_id,
          'created_at', created_at,
          'expires_at', expires_at,
          'consumed_at', consumed_at,
          'revoked_at', revoked_at,
          'member_status', member_status,
          'member_active', member_active,
          'state', state
        ) ORDER BY created_at DESC NULLS LAST) FROM matching),
        '[]'::json
      )
    )::text;
    COMMIT;"
} | tr -d '\r' | sed '/^$/d')"

runtime_payload="$(docker exec brain-prod-api node -e '
const value = { git_sha: process.env.GIT_SHA ?? null, node_env: process.env.NODE_ENV ?? null };
const raw = process.env.BRAIN_RESOLVER_DB_URL;
if (raw) {
  const url = new URL(raw);
  value.resolver_database = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || null,
    database: url.pathname.replace(/^\//, ""),
  };
} else {
  value.resolver_database = null;
}
process.stdout.write(JSON.stringify(value));
')"

logs_payload="$(docker logs --since 6h brain-prod-api 2>&1 | docker exec -i brain-prod-api node -e '
let text = "";
process.stdin.on("data", (chunk) => text += chunk);
process.stdin.on("end", () => {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.includes("/invites/consume") && !line.includes("/invites/pending")) continue;
    try {
      const value = JSON.parse(line);
      const url = value.req?.url ?? value.url ?? null;
      if (typeof url !== "string" || (!url.includes("/invites/consume") && !url.includes("/invites/pending"))) continue;
      rows.push({
        time: value.time ?? value.timestamp ?? null,
        request_id: value.reqId ?? value.requestId ?? value.req?.id ?? null,
        method: value.req?.method ?? value.method ?? null,
        url,
        status_code: value.res?.statusCode ?? value.statusCode ?? null,
        response_time_ms: value.responseTime ?? null,
        message: value.msg ?? value.message ?? null,
      });
    } catch {}
  }
  process.stdout.write(JSON.stringify(rows.slice(-100)));
});
')"

printf '%s' "$db_payload" | base64 | tr -d '\n'
printf '\n'
printf '%s' "$runtime_payload" | base64 | tr -d '\n'
printf '\n'
printf '%s' "$logs_payload" | base64 | tr -d '\n'
printf '\n%s\n' "test5_production_invite_diagnostic_completed"
