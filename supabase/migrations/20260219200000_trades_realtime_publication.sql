-- Ensure trades table is in the supabase_realtime publication
-- so postgres_changes events are broadcast to subscribers.
-- This is idempotent — if already added, Postgres will raise a notice but not error.
DO $$
BEGIN
    -- Check if trades is already in the publication
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'trades'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE trades;
    END IF;
END $$;

-- Also ensure RLS is enabled (required for Realtime to filter by policy)
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;

-- Ensure the replica identity includes full row data for Realtime payloads
ALTER TABLE trades REPLICA IDENTITY FULL;
