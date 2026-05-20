-- Maps Plaid item_id → Brain tenant so webhook tenant resolution works
-- without a bearer JWT. Owner: services/raw.

BEGIN;

CREATE TABLE IF NOT EXISTS raw_plaid_items (
  item_id    TEXT        NOT NULL PRIMARY KEY,
  tenant_id  TEXT        NOT NULL,
  source_id  TEXT        NOT NULL,
  active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raw_plaid_items_tenant
  ON raw_plaid_items (tenant_id);

COMMIT;
