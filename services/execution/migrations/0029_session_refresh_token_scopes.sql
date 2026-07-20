BEGIN;

ALTER TABLE session_refresh_tokens
  ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT ARRAY[
    'ledger:read',
    'ledger:write',
    'wiki:read',
    'raw:read',
    'policy:read',
    'execution:read',
    'execution:admin',
    'payment_intent:approve',
    'audit:read'
  ]::TEXT[];

COMMENT ON COLUMN session_refresh_tokens.scopes IS
  'Literal scopes granted to refresh-derived member sessions. Reduced-scope sessions persist the narrowed set so refresh cannot widen privilege.';

COMMIT;
