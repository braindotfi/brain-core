-- Fail closed immediately before adding the uniqueness indexes. The production
-- preflight was clean before this change; this migration proves that remains
-- true after the online head bootstrap and before constraint installation.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM audit_events
     WHERE prev_event_hash IS NOT NULL
     GROUP BY tenant_id, prev_event_hash
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'audit chain constraint preflight found multiple successors';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM audit_events event
     WHERE event.prev_event_hash IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM audit_events predecessor
          WHERE predecessor.tenant_id = event.tenant_id
            AND predecessor.event_hash = event.prev_event_hash
       )
  ) THEN
    RAISE EXCEPTION 'audit chain constraint preflight found a missing predecessor';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM audit_events
     GROUP BY tenant_id
    HAVING count(*) FILTER (WHERE prev_event_hash IS NULL) <> 1
  ) THEN
    RAISE EXCEPTION 'audit chain constraint preflight found an invalid genesis count';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (
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
        SELECT counts.tenant_id,
               counts.event_count,
               head.sequence AS head_sequence,
               head.tenant_id IS NOT NULL AS head_exists,
               tail.tenant_id IS NOT NULL AS head_is_tail
          FROM event_counts counts
          LEFT JOIN audit_chain_heads head ON head.tenant_id = counts.tenant_id
          LEFT JOIN tails tail
            ON tail.tenant_id = head.tenant_id
           AND tail.id = head.head_event_id
           AND tail.event_hash = head.head_event_hash
      ) state
     WHERE state.head_exists IS NOT TRUE
        OR state.head_is_tail IS NOT TRUE
        OR state.head_sequence <> state.event_count
  ) THEN
    RAISE EXCEPTION 'audit chain constraint preflight found an invalid authoritative head';
  END IF;
END;
$$;
