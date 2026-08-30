# Slack app manifests

`manifest.yaml` is the staging app manifest. Its provider callbacks use
`staging-api.brain.fi`, where staging Caddy routes `/surfaces/*` to the surface
gateway.

`manifest.production.yaml` is kept separate so a staging callback change cannot
alter a production Slack app. Its `surface.brain.fi` origin is reserved but is
not deployable until that production hostname and proxy route exist. Do not use
the production manifest for the staging smoke test.

Both manifests intentionally request only `chat:write` and
`chat:write.public`. The only subscribed event is `app_uninstalled`.
