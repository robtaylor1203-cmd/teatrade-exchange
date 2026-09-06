-- Lightweight admin FINANCE dashboard function.
-- Reads only the small `payments` table (completed Stripe payments), so it
-- stays fast even when the heavier admin_analytics() is slow under load.
-- Gated to the admin email.

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

    -- Monthly breakdown (last 12 months)
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

    RETURN jsonb_build_object(
        'success', true,
        'generated_at', NOW(),
        'currency', 'GBP',
        'raised', v_raised,
        'by_month', v_by_month,
        -- Prize payouts are paid manually for now, so tracked as 0 here.
        -- (We can wire an automated prize ledger later.)
        'paid_out', jsonb_build_object('total_pence', 0, 'count', 0)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION admin_finance() TO authenticated;
