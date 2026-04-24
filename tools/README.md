# tools/

Dev scripts, migration runners, backfill utilities. Populated as the build
progresses.

Current contents:

- `postgres-init/` — SQL run on first Postgres container boot (extensions etc.)

Planned (per stages that introduce them):

- `migrate/` — stage-2+ schema migration runner
- `seed/` — stage-9 synthetic data generator for the Wiki-compounding E2E test
