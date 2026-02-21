-- Add profiles table to Realtime publication so balance updates
-- are pushed to the frontend via the existing subscription.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'profiles'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE profiles;
    END IF;
END $$;

ALTER TABLE profiles REPLICA IDENTITY FULL;
