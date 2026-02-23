-- Restore close_pair_trade function that was accidentally dropped
-- by 20260220110000_drop_old_function_signatures.sql

CREATE OR REPLACE FUNCTION close_pair_trade(
    p_user_id    UUID,
    p_trade_id   TEXT,
    p_exit_ratio NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_trade        RECORD;
    v_profile      RECORD;
    v_close_trade  RECORD;
    v_margin       NUMERIC;
    v_pnl          NUMERIC;
    v_direction    INT;
    v_ratio_change NUMERIC;
    v_return_amt   NUMERIC;
    v_new_balance  NUMERIC;
    v_leverage     NUMERIC;
BEGIN
    IF p_exit_ratio IS NULL OR p_exit_ratio <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid exit ratio');
    END IF;

    SELECT * INTO v_trade FROM trades
        WHERE id::TEXT = p_trade_id AND user_id = p_user_id
        FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Trade not found');
    END IF;

    IF NOT COALESCE(v_trade.is_pair_trade, false) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Not a pair trade');
    END IF;

    v_margin := v_trade.quantity;
    v_leverage := COALESCE(v_trade.leverage, 1);
    v_direction := CASE WHEN v_trade.side = 'BUY' THEN 1 ELSE -1 END;
    v_ratio_change := (p_exit_ratio - v_trade.price) / v_trade.price;
    v_pnl := v_margin * v_ratio_change * v_leverage * v_direction;
    v_return_amt := v_margin + v_pnl;

    SELECT * INTO v_profile FROM profiles WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'User profile not found');
    END IF;

    v_new_balance := v_profile.cash_balance + v_return_amt;
    UPDATE profiles SET cash_balance = v_new_balance WHERE id = p_user_id;

    INSERT INTO trades (user_id, tea_id, index_symbol, side, quantity, price, total_value, pair_id, leverage, is_pair_trade)
        VALUES (
            p_user_id,
            v_trade.tea_id,
            v_trade.index_symbol,
            CASE WHEN v_trade.side = 'BUY' THEN 'SELL' ELSE 'BUY' END,
            v_margin,
            p_exit_ratio,
            v_return_amt,
            v_trade.pair_id,
            v_leverage,
            true
        )
        RETURNING * INTO v_close_trade;

    RETURN jsonb_build_object(
        'success',      true,
        'trade_id',     v_close_trade.id::TEXT,
        'pnl',          v_pnl,
        'return_amount', v_return_amt,
        'new_balance',  v_new_balance,
        'entry_ratio',  v_trade.price,
        'exit_ratio',   p_exit_ratio,
        'margin',       v_margin,
        'leverage',     v_leverage
    );
END;
$$;
