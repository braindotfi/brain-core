# Skills Specification Guidance

- Export only the 11 launch agents listed in `generate.ts`.
- Keep output public-safe: no handlers, policy templates, logic, credentials, or
  tenant data.
- Preserve the JSON shape consumed by `brain-skills/scripts/check-drift.mjs`.
- Reference `BRAIN_SKILLS_PUSH_TOKEN` by name only; never embed a token.
- Publication must open or update a PR in `brain-skills`, never push to its
  default branch.
