#!/bin/sh
# Turn one env var per role password into the `-v name=value` args db-roles.sql
# expects, then run it.
#
# Connection settings come from the standard PG* env vars (PGHOST, PGUSER,
# PGDATABASE, PGPASSWORD, PGSSLMODE), set by the Container App Job.
#
# Idempotent: db-roles.sql is safe to re-run.
#
# MUST run AFTER migrations. The grant loops only see tables that already
# exist, so running this against an unmigrated database silently produces roles
# with no grants on the canonical/ledger tables.

set -eu

# psql var name in db-roles.sql <- env var is the same name, uppercased.
ROLE_VARS="
brain_app_password
brain_privileged_password
brain_wiki_reader_password
brain_mcp_reader_password
brain_raw_worker_password
brain_canonical_projector_password
brain_ledger_projector_password
brain_execution_worker_password
brain_audit_verifier_password
brain_audit_publisher_password
brain_resolver_password
brain_tenant_deletion_password
brain_surface_gateway_password
brain_surface_audit_writer_password
brain_auth_password
brain_auth_audit_writer_password
"

set -- -v ON_ERROR_STOP=1

missing=""
for var_name in $ROLE_VARS; do
  env_name=$(echo "$var_name" | tr '[:lower:]' '[:upper:]')
  value=$(printenv "$env_name" || true)

  if [ -z "$value" ]; then
    missing="$missing $env_name"
    continue
  fi

  set -- "$@" -v "$var_name=$value"
done

if [ -n "$missing" ]; then
  echo "db-roles: missing required password env vars:$missing" >&2
  exit 1
fi

echo "db-roles: applying to ${PGHOST:-?}/${PGDATABASE:-?} as ${PGUSER:-?}"
exec psql "$@" -f /db-roles.sql
