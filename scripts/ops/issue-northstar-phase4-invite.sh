#!/usr/bin/env bash
set -euo pipefail

readonly tenant_id="tnt_01M0DBPNXG0TRB0SV1WTMB6F6J"
readonly recipient_email="braindotfi+test5@gmail.com"

payload="$({
  docker exec brain-prod-postgres psql -X -qAt -v ON_ERROR_STOP=1 -U brain -d brain -c "
    BEGIN TRANSACTION READ ONLY;
    SET LOCAL statement_timeout = '5s';
    SET LOCAL lock_timeout = '1s';
    WITH matching AS (
      SELECT i.member_id,
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
        FROM member_invites i
        JOIN members m
          ON m.tenant_id = i.tenant_id
         AND m.id = i.member_id
       WHERE i.tenant_id = '$tenant_id'
         AND lower(btrim(m.email)) = '$recipient_email'
       ORDER BY i.created_at DESC
    )
    SELECT json_build_object(
      'tenant_id', '$tenant_id',
      'email', '$recipient_email',
      'server_now', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
      'record_count', COUNT(*),
      'invites', COALESCE(
        json_agg(
          json_build_object(
            'member_id', member_id,
            'created_at', created_at,
            'expires_at', expires_at,
            'consumed_at', consumed_at,
            'revoked_at', revoked_at,
            'member_status', member_status,
            'member_active', member_active,
            'state', state
          ) ORDER BY created_at DESC
        ) FILTER (WHERE member_id IS NOT NULL),
        '[]'::json
      )
    )::text
    FROM matching;
    COMMIT;"
} | tr -d '\r' | sed '/^$/d')"

if [[ "$(printf '%s\n' "$payload" | wc -l | tr -d ' ')" != "1" ]]; then
  echo "northstar_invite_status_failed=unexpected_query_shape" >&2
  exit 1
fi

printf '%s' "$payload" | docker exec -i brain-prod-api node -e '
let text = "";
process.stdin.on("data", (chunk) => text += chunk);
process.stdin.on("end", () => {
  const value = JSON.parse(text);
  const valid = value.tenant_id === "tnt_01M0DBPNXG0TRB0SV1WTMB6F6J" &&
    value.email === "braindotfi+test5@gmail.com" &&
    Number.isInteger(value.record_count) && Array.isArray(value.invites);
  process.exit(valid ? 0 : 1);
});
'

printf '%s' "$payload" | base64 | tr -d '\n'
printf '\n%s\n' "northstar_invite_status_completed"
