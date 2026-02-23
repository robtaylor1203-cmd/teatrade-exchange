-- One-time purge of all simulation bot data.
-- Bots are identified by auth.users email ending in '@teatrade.sim'.

DO $$
DECLARE
    v_bot_ids UUID[];
    v_count   INT;
BEGIN
    SELECT ARRAY_AGG(id) INTO v_bot_ids
    FROM auth.users
    WHERE email LIKE '%@teatrade.sim';

    IF v_bot_ids IS NULL OR array_length(v_bot_ids, 1) IS NULL THEN
        RAISE LOG 'purge_bot_data: no bot users found, nothing to clean';
        RETURN;
    END IF;

    DELETE FROM platform_revenue   WHERE user_id = ANY(v_bot_ids);
    DELETE FROM margin_notifications WHERE user_id = ANY(v_bot_ids);
    DELETE FROM pending_orders     WHERE user_id = ANY(v_bot_ids);
    DELETE FROM trades             WHERE user_id = ANY(v_bot_ids);
    DELETE FROM positions          WHERE user_id = ANY(v_bot_ids);
    DELETE FROM index_positions    WHERE user_id = ANY(v_bot_ids);
    DELETE FROM combine_challenges WHERE user_id = ANY(v_bot_ids);
    DELETE FROM payments           WHERE user_id = ANY(v_bot_ids);
    DELETE FROM profiles           WHERE id      = ANY(v_bot_ids);

    -- Remove from auth.users (requires superuser context, which migrations have)
    DELETE FROM auth.users WHERE id = ANY(v_bot_ids);

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RAISE LOG 'purge_bot_data: removed % bot auth users and all associated data', array_length(v_bot_ids, 1);
END $$;
