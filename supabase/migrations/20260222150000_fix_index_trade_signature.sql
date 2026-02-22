-- Fix execute_index_trade to accept p_mode and p_leverage parameters
-- that the Edge Function already passes.

DROP FUNCTION IF EXISTS execute_index_trade(UUID, TEXT, TEXT, NUMERIC, NUMERIC);
DROP FUNCTION IF EXISTS execute_index_trade(UUID, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, NUMERIC);

CREATE OR REPLACE FUNCTION execute_index_trade(
    p_user_id      UUID,
    p_index_symbol TEXT,
    p_side         TEXT,
    p_quantity     NUMERIC,
    p_price        NUMERIC,
    p_mode         TEXT DEFAULT 'VIRTUAL',
    p_leverage     NUMERIC DEFAULT 1
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile      RECORD;
    v_position     RECORD;
    v_trade        RECORD;
    v_spread       NUMERIC;
    v_exec_price   NUMERIC;
    v_spread_cost  NUMERIC;
    v_total        NUMERIC;
    v_margin       NUMERIC;
    v_new_balance  NUMERIC;
    v_new_qty      NUMERIC;
    v_new_avg      NUMERIC;
    v_balance_col  TEXT;
    v_lev          NUMERIC;
BEGIN
    IF p_side NOT IN ('BUY', 'SELL') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid side: must be BUY or SELL');
    END IF;
    IF p_quantity <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Quantity must be greater than zero');
    END IF;
    IF p_price IS NULL OR p_price <= 0 OR p_price != p_price OR p_price > 1e15 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid price');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM indexes WHERE symbol = p_index_symbol) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Index not found: ' || p_index_symbol);
    END IF;

    v_lev := GREATEST(1, LEAST(25, COALESCE(p_leverage, 1)));

    -- Symmetric spread (1% default)
    v_spread := 0.01;
    IF p_side = 'BUY' THEN
        v_exec_price := p_price * (1.0 + v_spread / 2.0);
    ELSE
        v_exec_price := p_price * (1.0 - v_spread / 2.0);
    END IF;
    v_spread_cost := ABS(v_exec_price - p_price) * p_quantity;

    v_total  := v_exec_price * p_quantity;
    v_margin := v_total / v_lev;

    -- Lock user profile
    SELECT * INTO v_profile FROM profiles WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'User profile not found');
    END IF;

    -- ── BUY ─────────────────────────────────────────────────────────
    IF p_side = 'BUY' THEN
        IF v_profile.cash_balance < v_margin THEN
            RETURN jsonb_build_object('success', false, 'error',
                'Insufficient balance. Need $' || ROUND(v_margin, 2) || ' margin (' || v_lev || 'x leverage)');
        END IF;

        v_new_balance := v_profile.cash_balance - v_margin;
        UPDATE profiles SET cash_balance = v_new_balance WHERE id = p_user_id;

        SELECT * INTO v_position FROM index_positions
            WHERE user_id = p_user_id AND index_symbol = p_index_symbol
            FOR UPDATE;

        IF FOUND THEN
            v_new_qty := v_position.quantity + p_quantity;
            v_new_avg := ((v_position.avg_entry_price * v_position.quantity) + (v_exec_price * p_quantity)) / v_new_qty;
            UPDATE index_positions
                SET quantity = v_new_qty, avg_entry_price = v_new_avg, updated_at = NOW()
                WHERE id = v_position.id;
        ELSE
            INSERT INTO index_positions (user_id, index_symbol, quantity, avg_entry_price)
                VALUES (p_user_id, p_index_symbol, p_quantity, v_exec_price);
        END IF;

    -- ── SELL ────────────────────────────────────────────────────────
    ELSIF p_side = 'SELL' THEN
        SELECT * INTO v_position FROM index_positions
            WHERE user_id = p_user_id AND index_symbol = p_index_symbol
            FOR UPDATE;

        IF NOT FOUND OR v_position.quantity < p_quantity THEN
            RETURN jsonb_build_object('success', false, 'error',
                'Insufficient index holdings. Have ' || COALESCE(v_position.quantity, 0) || ' kg');
        END IF;

        v_new_balance := v_profile.cash_balance + v_total;
        UPDATE profiles SET cash_balance = v_new_balance WHERE id = p_user_id;

        v_new_qty := v_position.quantity - p_quantity;
        IF v_new_qty <= 0 THEN
            DELETE FROM index_positions WHERE id = v_position.id;
        ELSE
            UPDATE index_positions
                SET quantity = v_new_qty, updated_at = NOW()
                WHERE id = v_position.id;
        END IF;
    END IF;

    -- ── RECORD TRADE ────────────────────────────────────────────────
    INSERT INTO trades (user_id, tea_id, index_symbol, side, quantity, price, total_value, leverage)
        VALUES (p_user_id, NULL, p_index_symbol, p_side, p_quantity, v_exec_price, v_total, v_lev)
        RETURNING * INTO v_trade;

    RETURN jsonb_build_object(
        'success',          true,
        'trade_id',         v_trade.id::TEXT,
        'side',             p_side,
        'symbol',           p_index_symbol,
        'quantity',         p_quantity,
        'price',            v_exec_price,
        'mid_price',        p_price,
        'spread',           v_spread,
        'spread_cost',      v_spread_cost,
        'total',            v_total,
        'margin',           v_margin,
        'leverage',         v_lev,
        'new_balance',      v_new_balance,
        'execution_price',  v_exec_price
    );
END;
$$;
