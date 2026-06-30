# Microsoft Teams Install

Brain uses one multi-tenant Bot Framework app for Teams. Customers install the Teams app package into their Microsoft 365 tenant, then Brain records an explicit mapping from that Azure AD tenant to a Brain tenant.

## Package

Build the uploadable package:

```bash
pnpm --filter @brain/surface-gateway teams:package
```

The package is written to `services/surface-gateway/teams-app-package.zip`.

Before uploading to Teams, replace `${TEAMS_APP_ID}` in `manifest.json` with the Bot Framework app id for the target environment. The checked-in template keeps the package deterministic and avoids hardcoding credentials or environment ids.

## Azure Bot Settings

The Bot Framework registration must be multi-tenant:

- Supported account types: `Accounts in any organizational directory`.
- Messaging endpoint: `https://<surface-gateway-host>/surfaces/teams/messages`.
- App id and secret are supplied to the gateway as `TEAMS_APP_ID` and `TEAMS_APP_PASSWORD`.
- The install and revoke endpoints require a Brain bearer JWT with `surfaces:admin`.

Admin consent URL pattern:

```text
https://login.microsoftonline.com/common/adminconsent?client_id=<TEAMS_APP_ID>&redirect_uri=https%3A%2F%2F<surface-gateway-host>%2Fsurfaces%2Fteams%2Fadmin-consent%2Fcallback&state=<brain-issued-state>
```

The callback can be handled by deployment tooling today. The gateway does not infer Brain tenant identity from this redirect. Operators must record the Brain tenant mapping through the admin endpoint below.

## Tenant Mapping

Create or refresh the mapping after a tenant admin approves the install:

```bash
curl -X POST https://<surface-gateway-host>/surfaces/teams/install \
  -H "content-type: application/json" \
  -H "authorization: Bearer $BRAIN_ADMIN_TOKEN" \
  -d '{
    "aadTenantId": "00000000-0000-0000-0000-000000000000",
    "installedBy": "admin@example.com"
  }'
```

The gateway derives the Brain tenant from the authenticated principal, never from the request body. It resolves every authenticated Teams activity by `aadTenantId`, checks that it maps to the Brain tenant carried in the Adaptive Card, and only then stores the conversation reference as `<brainTenantId>:<conversationId>`.

## Revocation

Revoke an installation:

```bash
curl -X POST https://<surface-gateway-host>/surfaces/teams/revoke \
  -H "content-type: application/json" \
  -H "authorization: Bearer $BRAIN_ADMIN_TOKEN" \
  -d '{"aadTenantId":"00000000-0000-0000-0000-000000000000"}'
```

Revoked installations fail closed for inbound Teams approvals. Outbound proactive sends also fail closed because the Bot Framework client checks for an active Brain tenant installation before loading a conversation reference.
