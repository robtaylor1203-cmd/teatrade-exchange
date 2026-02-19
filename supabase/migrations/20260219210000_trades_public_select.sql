-- Allow all authenticated users to read all trades.
-- Trade data is public on a trading platform (visible in trade tape,
-- leaderboards, and follow notifications). Write operations remain
-- restricted to own rows via existing INSERT/UPDATE policies.
-- Drop the more restrictive followed-only policy in favour of this.
DROP POLICY IF EXISTS "trades_select_followed" ON trades;
DROP POLICY IF EXISTS "Enable read access for authenticated users" ON trades;
DROP POLICY IF EXISTS "trades_select" ON trades;
DROP POLICY IF EXISTS "Users can view own trades" ON trades;

CREATE POLICY "trades_select_public" ON trades
    FOR SELECT TO authenticated
    USING (true);
