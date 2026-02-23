-- Monthly $1,000 credit for locked/blown accounts.
-- Runs on the 1st of every month at 00:05 UTC.
-- Only applies to accounts with account_status = 'LOCKED'.

CREATE OR REPLACE FUNCTION grant_monthly_bailout()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INT := 0;
BEGIN
    UPDATE profiles
    SET virtual_balance = virtual_balance + 1000,
        cash_balance    = cash_balance + 1000,
        account_status  = 'ACTIVE'
    WHERE account_status = 'LOCKED'
      AND next_free_reset_at IS NOT NULL
      AND next_free_reset_at <= NOW();

    GET DIAGNOSTICS v_count = ROW_COUNT;

    IF v_count > 0 THEN
        RAISE LOG 'grant_monthly_bailout: credited $1,000 to % locked accounts', v_count;
    END IF;
END;
$$;

-- Schedule: 1st of every month at 00:05 UTC
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        -- Remove stale schedule if exists
        PERFORM cron.unschedule('monthly-bailout-locked-accounts');
    END IF;
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.schedule(
            'monthly-bailout-locked-accounts',
            '5 0 1 * *',
            'SELECT grant_monthly_bailout()'
        );
    END IF;
END $$;
