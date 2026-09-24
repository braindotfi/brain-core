ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS sent_message_id TEXT,
  ADD COLUMN IF NOT EXISTS sent_thread_id TEXT,
  ADD COLUMN IF NOT EXISTS delivery_status TEXT
    CHECK (
      delivery_status IS NULL OR delivery_status IN (
        'pending',
        'sent',
        'delivered',
        'opened',
        'replied',
        'bounced'
      )
    ),
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
