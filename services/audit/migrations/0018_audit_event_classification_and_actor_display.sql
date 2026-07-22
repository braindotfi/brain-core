-- Audit event classification and optional actor display metadata.

BEGIN;

ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'system_activity',
  ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'info',
  ADD COLUMN IF NOT EXISTS actor_display_name TEXT,
  ADD COLUMN IF NOT EXISTS actor_email TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audit_events_event_type_check'
  ) THEN
    ALTER TABLE audit_events
      ADD CONSTRAINT audit_events_event_type_check
      CHECK (event_type IN ('system_activity', 'assistant_activity', 'flagged'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audit_events_severity_check'
  ) THEN
    ALTER TABLE audit_events
      ADD CONSTRAINT audit_events_severity_check
      CHECK (severity IN ('info', 'warning', 'critical'));
  END IF;
END $$;

UPDATE audit_events
   SET event_type = 'assistant_activity',
       severity = 'info'
 WHERE action = 'wiki.question'
   AND event_type = 'system_activity';

COMMENT ON COLUMN audit_events.event_type IS
  'Client-facing audit classification. flagged is reserved for risk events requiring attention.';
COMMENT ON COLUMN audit_events.severity IS
  'Client-facing audit severity implied by event_type unless explicitly set by the emitter.';
COMMENT ON COLUMN audit_events.actor_display_name IS
  'Optional human-readable actor display name captured at emit time.';
COMMENT ON COLUMN audit_events.actor_email IS
  'Optional human-readable actor email captured at emit time.';

COMMIT;
