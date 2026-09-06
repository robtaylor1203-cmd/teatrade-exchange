-- Add a real-subscriber breakdown to the admin finance dashboard:
-- total real users, paying (PRO) members, new signups in the last 24h/7d,
-- and a recent-signup list (email, tier, username, joined) for a personal look.
-- Bots (@teatrade.sim) are excluded everywhere.

CREATE OR REPLACE FUNCTION admin_finance()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_email    TEXT;
    v_raised   JSONB;
    v_by_month JSONB;
    v_paid     JSONB;
    v_recent   JSONB;
    v_subs     JSONB;
BEGIN
    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
    IF v_email IS DISTINCT FROM 'contact@teatrade.co.uk' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
    END IF;

    -- Funds raised (completed payments) across periods
    SELECT jsonb_build_object(
        'total_pence', COALESCE(SUM(amount_pence), 0),
        'this_month',  COALESCE(SUM(amount_pence) FILTER (WHERE created_at >= DATE_TRUNC('month', NOW())), 0),
        'last_90d',    COALESCE(SUM(amount_pence) FILTER (WHERE created_at >= NOW() - INTERVAL '90 days'), 0),
        'ytd',         COALESCE(SUM(amount_pence) FILTER (WHERE created_at >= DATE_TRUNC('year', NOW())), 0),
        'count',       COUNT(*)
    ) INTO v_raised
    FROM payments
    WHERE status = 'completed';

    -- Monthly revenue breakdown (last 12 months)
    SELECT COALESCE(jsonb_agg(mrow ORDER BY mrow->>'month' DESC), '[]'::jsonb)
    INTO v_by_month
    FROM (
        SELECT jsonb_build_object(
            'month', TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM'),
            'pence', COALESCE(SUM(amount_pence), 0),
            'count', COUNT(*)
        ) AS mrow
        FROM payments
        WHERE status = 'completed'
          AND created_at >= NOW() - INTERVAL '12 months'
        GROUP BY DATE_TRUNC('month', created_at)
    ) m;

    -- Prizes paid OUT across periods
    SELECT jsonb_build_object(
        'total_pence', COALESCE(SUM(amount_pence), 0),
        'this_month',  COALESCE(SUM(amount_pence) FILTER (WHERE paid_at >= DATE_TRUNC('month', NOW())), 0),
        'last_90d',    COALESCE(SUM(amount_pence) FILTER (WHERE paid_at >= NOW() - INTERVAL '90 days'), 0),
        'ytd',         COALESCE(SUM(amount_pence) FILTER (WHERE paid_at >= DATE_TRUNC('year', NOW())), 0),
        'count',       COUNT(*)
    ) INTO v_paid
    FROM prize_payouts;

    -- Recent payout entries (latest 20)
    SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'paid_at') DESC), '[]'::jsonb)
    INTO v_recent
    FROM (
        SELECT jsonb_build_object(
            'id', id,
            'recipient', recipient,
            'amount_pence', amount_pence,
            'reason', reason,
            'method', method,
            'paid_at', paid_at
        ) AS r
        FROM prize_payouts
        ORDER BY paid_at DESC
        LIMIT 20
    ) recent;

    -- Real subscribers (bots @teatrade.sim excluded)
    WITH real_users AS (
        SELECT au.email, au.created_at AS joined, p.tier, p.username
        FROM auth.users au
        JOIN profiles p ON p.id = au.id
        WHERE au.email NOT LIKE '%@teatrade.sim'
    )
    SELECT jsonb_build_object(
        'total',   (SELECT COUNT(*) FROM real_users),
        'pro',     (SELECT COUNT(*) FROM real_users WHERE tier = 'PRO'),
        'free',    (SELECT COUNT(*) FROM real_users WHERE tier IS DISTINCT FROM 'PRO'),
        'new_24h', (SELECT COUNT(*) FROM real_users WHERE joined >= NOW() - INTERVAL '24 hours'),
        'new_7d',  (SELECT COUNT(*) FROM real_users WHERE joined >= NOW() - INTERVAL '7 days'),
        'recent',  (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'email', email, 'tier', tier, 'username', username, 'joined', joined
                   ) ORDER BY joined DESC), '[]'::jsonb)
            FROM (SELECT * FROM real_users ORDER BY joined DESC LIMIT 100) r
        )
    ) INTO v_subs;

    RETURN jsonb_build_object(
        'success', true,
        'generated_at', NOW(),
        'currency', 'GBP',
        'raised', v_raised,
        'by_month', v_by_month,
        'paid_out', v_paid,
        'recent_payouts', v_recent,
        'subscribers', v_subs
    );
END;
$$;
GRANT EXECUTE ON FUNCTION admin_finance() TO authenticated;
