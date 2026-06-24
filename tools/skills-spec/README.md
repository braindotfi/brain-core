# Brain Skills Specification

`generate.ts` projects the 11 public launch agents from the private
`internalAgentCatalog` into the public-safe JSON consumed by
`braindotfi/brain-skills`.

The output contains identity and routing metadata only: category, risk,
authority, default-action presence, capabilities, confidence, triggers, intent
patterns, readable scopes, and required evidence. It does not emit handlers,
policy templates, implementation logic, credentials, or tenant data.
The generator fails on missing or duplicate launch keys.

Run locally:

```bash
pnpm tsx tools/skills-spec/generate.ts > /tmp/brain-agents.json
```

## CI publication

`.github/workflows/skills-spec.yml` regenerates the specification when internal
agent definitions change. If the public specification differs, the workflow
opens or updates `automation/skills-spec` in `braindotfi/brain-skills`.

A repository administrator must provision the `BRAIN_SKILLS_PUSH_TOKEN` Actions
secret in `brain-core`. It must be a narrowly scoped GitHub token allowed to
push a branch and open a pull request in `braindotfi/brain-skills`. The token
must never be written to source, logs, generated JSON, or artifacts.
