-- Fix open_pair_trade to accept p_mode parameter that the Edge Function passes.

DROP FUNCTION IF EXISTS open_pair_trade(UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, INT, TEXT);
DROP FUNCTION IF EXISTS open_pair_trade(UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, INT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION open_pair_trade(
    p_user_id       UUID,
    p_side          TEXT,
    p_amount        NUMERIC,
    p_ratio         NUMERIC,
    p_leverage      NUMERIC,
    p_pair_id       TEXT,
    p_tea_id        INT,
    p_index_symbol  TEXT,
    p_mode          TEXT DEFAULT 'VIRTUAL'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile     RECORD;
    v_trade       RECORD;
    v_new_balance NUMERIC;
    v_total_value NUMERIC;
    v_db_side     TEXT;
BEGIN
    IF p_side NOT IN ('LONG', 'SHORT') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid side: must be LONG or SHORT');
    END IF;
    IF p_amount < 10 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Minimum position size is $10');
    END IF;
    IF p_ratio IS NULL OR p_ratio <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid ratio');
    END IF;
    IF p_leverage IS NULL OR p_leverage < 1 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid leverage');
    END IF;

    v_db_side := CASE WHEN p_side = 'LONG' THEN 'BUY' ELSE 'SELL' END;
    v_total_value := p_amount * p_leverage;

    SELECT * INTO v_profile FROM profiles WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'User profile not found');
    END IF;

    IF v_profile.cash_balance < p_amount THEN
        RETURN jsonb_build_object('success', false, 'error',
            'Insufficient balance. Need $' || ROUND(p_amount, 2));
    END IF;

    v_new_balance := v_profile.cash_balance - p_amount;
    UPDATE profiles SET cash_balance = v_new_balance WHERE id = p_user_id;

    INSERT INTO trades (user_id, tea_id, index_symbol, side, quantity, price, total_value, pair_id, leverage, is_pair_trade)
        VALUES (p_user_id, p_tea_id, p_index_symbol, v_db_side, p_amount, p_ratio, v_total_value, p_pair_id::uuid, p_leverage, true)
        RETURNING * INTO v_trade;

    RETURN jsonb_build_object(
        'success',     true,
        'trade_id',    v_trade.id::TEXT,
        'new_balance', v_new_balance,
        'margin',      p_amount,
        'exposure',    v_total_value
    );
END;
$$;
