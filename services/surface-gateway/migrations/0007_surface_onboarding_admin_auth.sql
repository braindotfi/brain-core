BEGIN;

COMMENT ON POLICY tenant_isolation ON surface_slack_installations IS
  'Tenant-scoped calls set app.tenant_id. Slack lifecycle webhooks set app.slack_team_id so app_uninstalled can read and revoke by Slack team id without a Brain bearer token.';

COMMENT ON POLICY tenant_isolation_update ON surface_slack_installations IS
  'Tenant-scoped calls set app.tenant_id. Slack lifecycle webhooks set app.slack_team_id so app_uninstalled can revoke by Slack team id through RLS.';

COMMIT;
