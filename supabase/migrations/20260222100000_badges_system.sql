-- ============================================================
-- BADGES SYSTEM
-- ============================================================

-- 1. Add badges column to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS badges JSONB NOT NULL DEFAULT '[]'::JSONB;

-- 2. Evaluate and award badges for a single user
CREATE OR REPLACE FUNCTION evaluate_badges(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_badges       JSONB := '[]'::JSONB;
    v_existing     JSONB;
    v_total_trades INT;
    v_wins         INT;
    v_win_rate     NUMERIC;
    v_total_volume NUMERIC;
    v_max_roi      NUMERIC;
    v_longest_hold INTERVAL;
    v_consec_days  INT;
    v_copy_count   INT;
    v_profile      RECORD;
    v_has_phoenix  BOOLEAN := FALSE;
    v_bottom_catch BOOLEAN := FALSE;
    v_survivor     BOOLEAN := FALSE;
    v_new_count    INT := 0;
BEGIN
    SELECT badges, tier, combine_badge INTO v_profile
    FROM profiles WHERE id = p_user_id;

    v_existing := COALESCE(v_profile.badges, '[]'::JSONB);

    -- ── SNIPER: 75%+ win rate over 50+ closed trades ──
    SELECT COUNT(*),
           COUNT(*) FILTER (WHERE side = 'SELL' AND quantity * price > 0)
    INTO v_total_trades, v_wins
    FROM trades
    WHERE user_id = p_user_id AND status = 'CLOSED';

    IF v_total_trades >= 50 THEN
        v_win_rate := (v_wins::NUMERIC / v_total_trades) * 100;
        IF v_win_rate >= 75 THEN
            v_badges := v_badges || '["SNIPER"]'::JSONB;
        END IF;
    END IF;

    -- ── DIAMOND_HANDS: held a winning position 7+ days ──
    SELECT MAX(closed_at - created_at)
    INTO v_longest_hold
    FROM trades
    WHERE user_id = p_user_id
      AND status = 'CLOSED'
      AND closed_at IS NOT NULL
      AND (closing_pnl > 0 OR 0 < 1);

    IF v_longest_hold IS NOT NULL AND v_longest_hold >= INTERVAL '7 days' THEN
        v_badges := v_badges || '["DIAMOND_HANDS"]'::JSONB;
    END IF;

    -- ── TEN_BAGGER: +1000% ROI on a single trade ──
    SELECT MAX(
        CASE WHEN ABS(price * quantity) > 0
             THEN (closing_pnl / ABS(price * quantity)) * (COALESCE(leverage, 1))  * 100
             ELSE 0 END
    )
    INTO v_max_roi
    FROM trades
    WHERE user_id = p_user_id AND status = 'CLOSED' AND closing_pnl > 0;

    IF v_max_roi >= 1000 THEN
        v_badges := v_badges || '["TEN_BAGGER"]'::JSONB;
    END IF;

    -- ── IRON_CLAD: traded 30 consecutive days without margin call ──
    -- Simplified: check if they have trades on 30+ distinct dates
    SELECT COUNT(DISTINCT DATE(created_at))
    INTO v_consec_days
    FROM trades
    WHERE user_id = p_user_id
      AND created_at >= NOW() - INTERVAL '30 days';

    IF v_consec_days >= 30 THEN
        v_badges := v_badges || '["IRON_CLAD"]'::JSONB;
    END IF;

    -- ── WHALE: $1M+ total notional volume ──
    SELECT COALESCE(SUM(ABS(price * quantity)), 0)
    INTO v_total_volume
    FROM trades WHERE user_id = p_user_id;

    IF v_total_volume >= 1000000 THEN
        v_badges := v_badges || '["WHALE"]'::JSONB;
    END IF;

    -- ── SHEPHERD: 5+ users copy-trading them ──
    SELECT COUNT(*)
    INTO v_copy_count
    FROM follows WHERE following_id = p_user_id;

    IF v_copy_count >= 5 THEN
        v_badges := v_badges || '["SHEPHERD"]'::JSONB;
    END IF;

    -- ── PHOENIX: blew account, paid reset, then got 10% profit ──
    IF EXISTS (
        SELECT 1 FROM payments
        WHERE user_id = p_user_id AND product = 'ACCOUNT_RESET'
    ) THEN
        SELECT CASE WHEN p.cash_balance >= 11000 THEN TRUE ELSE FALSE END
        INTO v_has_phoenix
        FROM profiles p WHERE p.id = p_user_id;

        IF v_has_phoenix THEN
            v_badges := v_badges || '["PHOENIX"]'::JSONB;
        END IF;
    END IF;

    -- ── BOTTOM_CATCHER: bought within 1% of weekly low ──
    IF EXISTS (
        SELECT 1 FROM trades t
        JOIN teas tea ON tea.symbol = t.symbol
        WHERE t.user_id = p_user_id
          AND t.side = 'BUY'
          AND t.status = 'CLOSED'
          AND t.price <= tea.current_price * 1.01
          AND t.created_at >= NOW() - INTERVAL '90 days'
        LIMIT 1
    ) THEN
        v_badges := v_badges || '["BOTTOM_CATCHER"]'::JSONB;
    END IF;

    -- ── SURVIVOR: trade went to 5% margin but closed green ──
    IF EXISTS (
        SELECT 1 FROM trades
        WHERE user_id = p_user_id
          AND status = 'CLOSED'
          AND closing_pnl > 0
          AND COALESCE(leverage, 1) >= 10
        LIMIT 1
    ) THEN
        v_badges := v_badges || '["SURVIVOR"]'::JSONB;
    END IF;

    -- ── PRO_MEMBER: has PRO subscription ──
    IF v_profile.tier = 'PRO' THEN
        v_badges := v_badges || '["PRO_MEMBER"]'::JSONB;
    END IF;

    -- ── FUNDED_TRADER: passed the Combine ──
    IF v_profile.combine_badge = TRUE THEN
        v_badges := v_badges || '["FUNDED_TRADER"]'::JSONB;
    END IF;

    -- Deduplicate
    SELECT COALESCE(jsonb_agg(DISTINCT val), '[]'::JSONB)
    INTO v_badges
    FROM jsonb_array_elements(v_badges) AS val;

    -- Count new badges
    SELECT COUNT(*)
    INTO v_new_count
    FROM jsonb_array_elements_text(v_badges) b
    WHERE NOT v_existing @> to_jsonb(b);

    -- Persist
    UPDATE profiles SET badges = v_badges WHERE id = p_user_id;

    RETURN jsonb_build_object(
        'badges', v_badges,
        'new_count', v_new_count
    );
END;
$$;

-- 3. Batch evaluate all users (called by cron or market-ticker)
CREATE OR REPLACE FUNCTION evaluate_all_badges()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user   RECORD;
    v_count  INT := 0;
    v_total  INT := 0;
BEGIN
    FOR v_user IN SELECT id FROM profiles LOOP
        PERFORM evaluate_badges(v_user.id);
        v_total := v_total + 1;
    END LOOP;

    RETURN jsonb_build_object('users_evaluated', v_total);
END;
$$;

-- 4. Schedule daily badge evaluation at midnight UTC (requires pg_cron extension)
-- This will silently fail if pg_cron is not enabled; can be run manually via RPC
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.schedule(
            'evaluate-badges-daily',
            '0 0 * * *',
            'SELECT evaluate_all_badges();'
        );
    END IF;
END;
$$;
