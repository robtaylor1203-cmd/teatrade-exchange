-- Add notification preference to follows
ALTER TABLE follows ADD COLUMN IF NOT EXISTS notify BOOLEAN NOT NULL DEFAULT true;

-- Allow users to update their own follow rows (e.g. toggle notify)
DROP POLICY IF EXISTS "follows_update" ON follows;
CREATE POLICY "follows_update" ON follows FOR UPDATE TO authenticated
    USING (follower_id = auth.uid())
    WITH CHECK (follower_id = auth.uid());
