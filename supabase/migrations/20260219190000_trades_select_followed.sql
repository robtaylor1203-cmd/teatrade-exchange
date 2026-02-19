-- Allow authenticated users to SELECT trades from users they follow.
-- Supabase Realtime respects RLS, so without this the follow-trade
-- notification channel silently drops events for other users' rows.
-- RLS policies for the same operation are OR'd, so this safely extends
-- the existing "own trades" policy.

CREATE POLICY "trades_select_followed" ON trades
    FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR EXISTS (
            SELECT 1 FROM follows
            WHERE follower_id = auth.uid()
              AND following_id = trades.user_id
        )
    );
