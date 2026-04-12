-- Remove monthly bailout cron job and share bonus function.
-- These gave away free money ($1,000) that we no longer want.

-- 1. Unschedule the monthly bailout cron job
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.unschedule('monthly-bailout-locked-accounts');
    END IF;
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;

-- 2. Drop the monthly bailout function
DROP FUNCTION IF EXISTS grant_monthly_bailout();

-- 3. Drop the share bonus function
DROP FUNCTION IF EXISTS credit_share_bonus(UUID);

-- 4. Remove the FREE_BAILOUT path from reset_account
CREATE OR REPLACE FUNCTION reset_account(
    p_user_id         UUID,
    p_default_balance NUMERIC DEFAULT 10000,
    p_mode            TEXT DEFAULT 'VIRTUAL',
    p_source          TEXT DEFAULT 'PAID_RESET'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_new_balance NUMERIC;
    v_new_status  TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_user_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Profile not found');
    END IF;

    CASE p_source
        WHEN 'PAID_RESET' THEN
            v_new_balance := COALESCE(p_default_balance, 10000);
            v_new_status  := 'ACTIVE';
        WHEN 'COMBINE_START' THEN
            v_new_balance := 50000;
            v_new_status  := 'COMBINE';
        ELSE
            v_new_balance := COALESCE(p_default_balance, 10000);
            v_new_status  := 'ACTIVE';
    END CASE;

    DELETE FROM positions WHERE user_id = p_user_id AND trading_mode = p_mode;
    DELETE FROM index_positions WHERE user_id = p_user_id AND trading_mode = p_mode;
    DELETE FROM trades WHERE user_id = p_user_id AND trading_mode = p_mode;

    UPDATE pending_orders
       SET status = 'CANCELLED'
     WHERE user_id = p_user_id AND status = 'PENDING';

    IF p_mode = 'REAL' THEN
        UPDATE profiles
        SET real_balance       = v_new_balance,
            account_status     = v_new_status,
            next_free_reset_at = NULL
        WHERE id = p_user_id;
    ELSE
        UPDATE profiles
        SET virtual_balance    = v_new_balance,
            cash_balance       = v_new_balance,
            account_status     = v_new_status,
            next_free_reset_at = NULL
        WHERE id = p_user_id;
    END IF;

    RETURN jsonb_build_object(
        'success',     true,
        'new_balance', v_new_balance,
        'mode',        p_mode,
        'source',      p_source,
        'status',      v_new_status
    );
END;
$$;
