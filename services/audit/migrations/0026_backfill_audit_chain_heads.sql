-- Populate authoritative heads for existing clean chains while the trigger in
-- 0025 keeps concurrently active tenants current. ON CONFLICT preserves a head
-- that the trigger advanced after this statement's snapshot was taken.

WITH event_counts AS MATERIALIZED (
  SELECT tenant_id, count(*)::bigint AS event_count
    FROM audit_events
   GROUP BY tenant_id
),
tails AS MATERIALIZED (
  SELECT event.tenant_id, event.id, event.event_hash
    FROM audit_events event
   WHERE NOT EXISTS (
     SELECT 1
       FROM audit_events successor
      WHERE successor.tenant_id = event.tenant_id
        AND successor.prev_event_hash = event.event_hash
   )
)
INSERT INTO audit_chain_heads (
  tenant_id, head_event_id, head_event_hash, sequence, updated_at
)
SELECT tail.tenant_id, tail.id, tail.event_hash, counts.event_count, clock_timestamp()
  FROM tails tail
  JOIN event_counts counts ON counts.tenant_id = tail.tenant_id
ON CONFLICT (tenant_id) DO NOTHING;
