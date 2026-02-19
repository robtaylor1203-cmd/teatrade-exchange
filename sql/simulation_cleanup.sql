-- ============================================================
-- TeaTrade Exchange — Simulation Cleanup Function
-- ============================================================
-- Run this ONCE in the Supabase SQL Editor to register the function.
-- After that, wipe any simulation at any time with:
--
--     SELECT cleanup_simulation_bots();
--
-- The function deletes ALL data for users whose email ends in
-- @teatrade.sim — real user data is never touched.
-- ============================================================

CREATE OR REPLACE FUNCTION cleanup_simulation_bots()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_ids  UUID[];
    v_bot_count INT := 0;
    v_trades    INT := 0;
    v_positions INT := 0;
BEGIN
    -- Collect all sim bot user IDs
    SELECT ARRAY_AGG(id)
    INTO   v_user_ids
    FROM   auth.users
    WHERE  email LIKE '%@teatrade.sim';

    IF v_user_ids IS NULL OR array_length(v_user_ids, 1) IS NULL THEN
        RETURN 'No simulation bots found — platform is already clean.';
    END IF;

    v_bot_count := array_length(v_user_ids, 1);

    -- Delete trades
    DELETE FROM trades   WHERE user_id = ANY(v_user_ids);
    GET DIAGNOSTICS v_trades = ROW_COUNT;

    -- Delete positions
    DELETE FROM positions WHERE user_id = ANY(v_user_ids);
    GET DIAGNOSTICS v_positions = ROW_COUNT;

    -- Delete profiles
    DELETE FROM profiles  WHERE id = ANY(v_user_ids);

    -- Delete auth users (cascade handles anything remaining)
    DELETE FROM auth.users WHERE id = ANY(v_user_ids);

    RETURN format(
        'Cleaned up %s simulation bots | %s trades removed | %s positions removed',
        v_bot_count, v_trades, v_positions
    );
END;
$$;

-- Grant execute to service role only (not accessible from browser)
REVOKE EXECUTE ON FUNCTION cleanup_simulation_bots() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION cleanup_simulation_bots() TO service_role;
