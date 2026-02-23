-- Remove test account tea_trader_123 and any remaining bot data.
-- Cleans all associated records across every table.

DO $$
DECLARE
    v_test_id UUID;
    v_bot_ids UUID[];
BEGIN
    -- 1. Remove tea_trader_123 test account
    SELECT id INTO v_test_id FROM profiles WHERE username = 'tea_trader_123';

    IF v_test_id IS NOT NULL THEN
        DELETE FROM platform_revenue    WHERE user_id = v_test_id;
        DELETE FROM margin_notifications WHERE user_id = v_test_id;
        DELETE FROM pending_orders      WHERE user_id = v_test_id;
        DELETE FROM trades              WHERE user_id = v_test_id;
        DELETE FROM positions           WHERE user_id = v_test_id;
        DELETE FROM index_positions     WHERE user_id = v_test_id;
        DELETE FROM combine_challenges  WHERE user_id = v_test_id;
        DELETE FROM payments            WHERE user_id = v_test_id;
        DELETE FROM profiles            WHERE id      = v_test_id;
        DELETE FROM auth.users          WHERE id      = v_test_id;
        RAISE LOG 'purge_test: removed tea_trader_123 (%)' , v_test_id;
    END IF;

    -- 2. Catch any remaining @teatrade.sim bot accounts
    SELECT ARRAY_AGG(id) INTO v_bot_ids
    FROM auth.users
    WHERE email LIKE '%@teatrade.sim';

    IF v_bot_ids IS NOT NULL AND array_length(v_bot_ids, 1) > 0 THEN
        DELETE FROM platform_revenue    WHERE user_id = ANY(v_bot_ids);
        DELETE FROM margin_notifications WHERE user_id = ANY(v_bot_ids);
        DELETE FROM pending_orders      WHERE user_id = ANY(v_bot_ids);
        DELETE FROM trades              WHERE user_id = ANY(v_bot_ids);
        DELETE FROM positions           WHERE user_id = ANY(v_bot_ids);
        DELETE FROM index_positions     WHERE user_id = ANY(v_bot_ids);
        DELETE FROM combine_challenges  WHERE user_id = ANY(v_bot_ids);
        DELETE FROM payments            WHERE user_id = ANY(v_bot_ids);
        DELETE FROM profiles            WHERE id      = ANY(v_bot_ids);
        DELETE FROM auth.users          WHERE id      = ANY(v_bot_ids);
        RAISE LOG 'purge_test: removed % remaining bot accounts', array_length(v_bot_ids, 1);
    END IF;
END $$;
