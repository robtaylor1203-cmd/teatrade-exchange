-- Recreate leaderboard view with correct return_pct calculation.
-- Also seed bot profiles with varied virtual_balance so the leaderboard looks alive.

-- 1. Drop and recreate the view
DROP VIEW IF EXISTS leaderboard;

CREATE VIEW leaderboard AS
SELECT
    p.id,
    p.username,
    p.tier,
    p.combine_badge,
    p.badges,
    p.showcase_badge,
    p.avatar_url,
    p.follower_count,
    p.following_count,
    p.created_at,
    COALESCE(p.virtual_balance, 10000) AS total_value,
    ROUND(((COALESCE(p.virtual_balance, 10000) - 10000.0) / 10000.0) * 100, 1) AS return_pct,
    ROW_NUMBER() OVER (ORDER BY COALESCE(p.virtual_balance, 10000) DESC) AS rank
FROM profiles p
WHERE p.username IS NOT NULL;

-- Grant access so the existing RLS-free view is readable
GRANT SELECT ON leaderboard TO authenticated, anon;

-- 2. Give existing bot accounts realistic varied balances
--    Bots only set cash_balance on creation; virtual_balance stayed at default.
--    Randomise them so the leaderboard has life.
DO $$
DECLARE
    v_bot RECORD;
    v_new_bal NUMERIC;
BEGIN
    FOR v_bot IN
        SELECT p.id, p.username
        FROM profiles p
        JOIN auth.users u ON u.id = p.id
        WHERE u.email LIKE '%@teatrade.sim'
    LOOP
        v_new_bal := 10000 + ROUND((RANDOM() * 8000 - 3000)::NUMERIC, 2);
        UPDATE profiles
        SET virtual_balance = v_new_bal
        WHERE id = v_bot.id;
    END LOOP;
END $$;
