-- Upgrade active tenant policies that are exactly the previous bootstrap
-- default so evidence-backed agent proposals reach Needs Review.
--
-- Custom tenant policies are intentionally excluded: the WHERE clause matches
-- the old default policy document exactly. The old default had no signatures
-- and admitted no agent_action proposals, causing every fresh-tenant agent
-- proposal to reject with matched_rule_id = NULL. We preserve history by
-- deactivating that default and inserting version + 1 with the corrected rule.

BEGIN;

WITH docs AS (
  SELECT
    '{
      "version": 1,
      "rules": [
        {
          "id": "default-money-requires-confirmation",
          "applies_to": ["outbound_payment", "onchain_tx"],
          "when": { "agent.confidence.gte": 0.6 },
          "execute": "confirm",
          "require": "single_signer"
        },
        {
          "id": "default-non-money-confidence-floor",
          "applies_to": ["inbound_payment", "ledger_write"],
          "when": { "agent.confidence.gte": 0.6 },
          "execute": "auto"
        }
      ]
    }'::jsonb AS old_content,
    '{
      "version": 1,
      "rules": [
        {
          "id": "default-money-requires-confirmation",
          "applies_to": ["outbound_payment", "onchain_tx"],
          "when": { "agent.confidence.gte": 0.6 },
          "execute": "confirm",
          "require": "single_signer"
        },
        {
          "id": "default-agent-action-requires-review",
          "applies_to": ["agent_action"],
          "when": { "agent.confidence.gte": 0.6 },
          "execute": "confirm",
          "require": "single_signer"
        },
        {
          "id": "default-non-money-confidence-floor",
          "applies_to": ["inbound_payment", "ledger_write"],
          "when": { "agent.confidence.gte": 0.6 },
          "execute": "auto"
        }
      ]
    }'::jsonb AS new_content,
    decode('253834354481d08401efabbe4e0ed643b60d9f5a80169ed9440f05fd25401d6e', 'hex') AS new_hash
),
matched AS (
  SELECT p.*,
         docs.new_content,
         docs.new_hash,
         (
           SELECT COALESCE(MAX(p2.version), 0) + 1
             FROM policies p2
            WHERE p2.tenant_id = p.tenant_id
         ) AS next_version
    FROM policies p
    JOIN docs ON p.content = docs.old_content
   WHERE p.state = 'active'
),
deactivated AS (
  UPDATE policies p
     SET state = 'deactivated',
         deactivated_at = now()
    FROM matched m
   WHERE p.id = m.id
   RETURNING m.*
)
INSERT INTO policies
  (id, tenant_id, version, content, content_hash, signers, state,
   quorum_required, activated_at, created_by, created_at)
SELECT
  'pol_' || md5(id || ':default-agent-action-review'),
  tenant_id,
  next_version,
  new_content,
  new_hash,
  NULL,
  'active',
  quorum_required,
  now(),
  created_by,
  now()
FROM deactivated;

COMMIT;
