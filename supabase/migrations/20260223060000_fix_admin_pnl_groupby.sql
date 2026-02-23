-- Fix: i.multiplier must be in GROUP BY or aggregate
-- Wraps multiplier in MAX() since there's only one index row per symbol anyway.

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
    v_pnl JSONB;
    v_fee_total NUMERIC;
    v_user_count INT;
    v_total_cash NUMERIC;
    v_tea_unrealized NUMERIC;
    v_idx_unrealized NUMERIC;
    v_total_equity NUMERIC;
    v_starting_capital NUMERIC;
    v_counterparty NUMERIC;
BEGIN
    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
    IF v_email IS DISTINCT FROM 'contact@teatrade.co.uk' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
    END IF;

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

    SELECT COALESCE(SUM(amount), 0) INTO v_fee_total FROM platform_revenue;

    -- ── PLATFORM NET P&L ──────────────────────────────────────────────
    SELECT COUNT(*), COALESCE(SUM(virtual_balance), 0)
        INTO v_user_count, v_total_cash
    FROM profiles;

    v_starting_capital := v_user_count * 10000.0;

    SELECT COALESCE(SUM(
        CASE WHEN pos.quantity > 0
             THEN (t.current_price - pos.avg_entry_price) * pos.quantity
             ELSE (pos.avg_entry_price - t.current_price) * ABS(pos.quantity)
        END
    ), 0) INTO v_tea_unrealized
    FROM positions pos
    JOIN teas t ON t.id = pos.tea_id;

    SELECT COALESCE(SUM(
        CASE WHEN ip.quantity > 0
             THEN (idx_price.price - ip.avg_entry_price) * ip.quantity
             ELSE (ip.avg_entry_price - idx_price.price) * ABS(ip.quantity)
        END
    ), 0) INTO v_idx_unrealized
    FROM index_positions ip
    CROSS JOIN LATERAL (
        SELECT AVG(t.current_price) * COALESCE(MAX(i.multiplier), 1) AS price
        FROM indexes i, unnest(i.teas) AS tea_sym
        JOIN teas t ON t.symbol = tea_sym
        WHERE i.symbol = ip.index_symbol AND t.current_price > 0
    ) idx_price;

    v_total_equity := v_total_cash + v_tea_unrealized + v_idx_unrealized
        + COALESCE((SELECT SUM(margin_used) FROM positions), 0)
        + COALESCE((SELECT SUM(margin_used) FROM index_positions), 0);

    v_counterparty := v_starting_capital - v_total_equity;

    v_pnl := jsonb_build_object(
        'fee_revenue',       ROUND(v_fee_total, 2),
        'counterparty_pnl',  ROUND(v_counterparty, 2),
        'net_pnl',           ROUND(v_fee_total + v_counterparty, 2),
        'total_user_equity', ROUND(v_total_equity, 2),
        'starting_capital',  ROUND(v_starting_capital, 2),
        'user_count',        v_user_count,
        'open_tea_pnl',      ROUND(v_tea_unrealized, 2),
        'open_index_pnl',    ROUND(v_idx_unrealized, 2)
    );

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
        'pnl',          v_pnl,
        'top_traders',  v_top_traders
    );
END;
$$;
