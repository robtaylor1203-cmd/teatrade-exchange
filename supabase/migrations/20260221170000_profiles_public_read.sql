-- Allow authenticated users to read basic (non-sensitive) profile data
-- for all users. Required for user search, trader profiles, and the
-- leaderboard. Sensitive fields (cash_balance) are protected by the
-- column-level REVOKE in the golden master migration, and the API
-- queries only SELECT the columns they need.

DROP POLICY IF EXISTS "profiles_public_read" ON profiles;

CREATE POLICY "profiles_public_read" ON profiles
    FOR SELECT TO authenticated
    USING (true);
