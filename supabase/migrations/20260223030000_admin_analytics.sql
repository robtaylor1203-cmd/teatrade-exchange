-- Admin Analytics: server-side function gated to admin email.
-- Returns a comprehensive JSONB report of users, trades, P&L, and top traders.

CREATE OR REPLACE FUNCTION admin_analytics()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_email TEXT;
    v_users JSONB;
    v_trades JSONB;
    v_revenue JSONB;
    v_top_traders JSONB;
BEGIN
    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
    IF v_email IS DISTINCT FROM 'contact@teatrade.co.uk' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
    END IF;

    -- User statistics
    SELECT jsonb_build_object(
        'total',       COUNT(*),
        'last_7d',     COUNT(*) FILTER (WHERE au.created_at >= NOW() - INTERVAL '7 days'),
        'last_30d',    COUNT(*) FILTER (WHERE au.created_at >= NOW() - INTERVAL '30 days'),
        'last_365d',   COUNT(*) FILTER (WHERE au.created_at >= NOW() - INTERVAL '365 days'),
        'tier_free',   COUNT(*) FILTER (WHERE p.tier = 'FREE'),
        'tier_pro',    COUNT(*) FILTER (WHERE p.tier = 'PRO'),
        'status_active',  COUNT(*) FILTER (WHERE p.account_status = 'ACTIVE'),
        'status_locked',  COUNT(*) FILTER (WHERE p.account_status = 'LOCKED'),
        'status_combine', COUNT(*) FILTER (WHERE p.account_status = 'COMBINE'),
        'with_badge',     COUNT(*) FILTER (WHERE p.combine_badge = TRUE)
    ) INTO v_users
    FROM profiles p
    JOIN auth.users au ON au.id = p.id;

    -- Trade statistics
    SELECT jsonb_build_object(
        'total_count',       COUNT(*),
        'total_notional',    COALESCE(SUM(total_value), 0),
        'buy_count',         COUNT(*) FILTER (WHERE side = 'BUY'),
        'sell_count',        COUNT(*) FILTER (WHERE side = 'SELL'),
        'today_count',       COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE),
        'today_notional',    COALESCE(SUM(total_value) FILTER (WHERE created_at >= CURRENT_DATE), 0),
        'week_count',        COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('week', NOW())),
        'week_notional',     COALESCE(SUM(total_value) FILTER (WHERE created_at >= DATE_TRUNC('week', NOW())), 0),
        'month_count',       COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('month', NOW())),
        'month_notional',    COALESCE(SUM(total_value) FILTER (WHERE created_at >= DATE_TRUNC('month', NOW())), 0),
        'avg_leverage',      COALESCE(ROUND(AVG(leverage), 1), 0),
        'unique_traders',    COUNT(DISTINCT user_id)
    ) INTO v_trades
    FROM trades;

    -- Platform revenue (spreads, swaps, stop-outs)
    SELECT jsonb_build_object(
        'total',       COALESCE(SUM(amount), 0),
        'spread',      COALESCE(SUM(amount) FILTER (WHERE revenue_type = 'spread'), 0),
        'swap',        COALESCE(SUM(amount) FILTER (WHERE revenue_type = 'swap'), 0),
        'stop_out',    COALESCE(SUM(amount) FILTER (WHERE revenue_type = 'stop_out'), 0),
        'today',       COALESCE(SUM(amount) FILTER (WHERE created_at >= CURRENT_DATE), 0),
        'this_week',   COALESCE(SUM(amount) FILTER (WHERE created_at >= DATE_TRUNC('week', NOW())), 0),
        'this_month',  COALESCE(SUM(amount) FILTER (WHERE created_at >= DATE_TRUNC('month', NOW())), 0)
    ) INTO v_revenue
    FROM platform_revenue;

    -- Top 5 traders by net balance (virtual_balance - starting 10k = net gain/loss)
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    INTO v_top_traders
    FROM (
        SELECT
            p.username,
            p.virtual_balance,
            ROUND(p.virtual_balance - 10000, 2) AS net_pnl,
            p.tier,
            p.account_status,
            (SELECT COUNT(*) FROM trades tr WHERE tr.user_id = p.id) AS trade_count
        FROM profiles p
        WHERE p.username IS NOT NULL
        ORDER BY p.virtual_balance DESC
        LIMIT 5
    ) t;

    RETURN jsonb_build_object(
        'success',      true,
        'generated_at', NOW(),
        'users',        v_users,
        'trades',       v_trades,
        'revenue',      v_revenue,
        'top_traders',  v_top_traders
    );
END;
$$;
