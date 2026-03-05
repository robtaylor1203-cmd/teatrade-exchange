-- Update execute_index_trade to support HALTED trading modes for index constituents.
-- If any tea within the index is currently halted, the entire index trade fails.

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
    v_notional     NUMERIC;
    v_margin_req   NUMERIC;
    v_spread_cost  NUMERIC;
    v_bal          NUMERIC;
    v_new_balance  NUMERIC;
    v_new_qty      NUMERIC;
    v_new_avg      NUMERIC;
    v_new_margin   NUMERIC;
    v_new_leverage NUMERIC;
    v_existing_qty NUMERIC;
    v_close_qty    NUMERIC;
    v_open_qty     NUMERIC;
    v_close_pnl    NUMERIC;
    v_close_margin NUMERIC;
    v_halted_tea   TEXT;
BEGIN
    IF p_mode NOT IN ('VIRTUAL', 'REAL') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid trading mode');
    END IF;
    IF p_side NOT IN ('BUY', 'SELL') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid side: must be BUY or SELL');
    END IF;
    IF p_quantity <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Quantity must be greater than zero');
    END IF;
    IF p_price IS NULL OR p_price <= 0 OR p_price != p_price OR p_price > 1e15 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid price');
    END IF;
    IF p_leverage < 1 OR p_leverage > 25 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Leverage must be between 1 and 25');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM indexes WHERE symbol = p_index_symbol) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Index not found: ' || p_index_symbol);
    END IF;

    -- ── AUTO-RECOVER EXPIRED HALTS ───────────────────────────────────
    -- Recover any tea that had a halt time that has now expired
    UPDATE teas SET trading_mode = 'FULL', halt_until = NULL 
    WHERE trading_mode = 'HALTED' AND halt_until IS NOT NULL AND halt_until <= NOW();

    -- ── HALT CHECK FOR INDEX CONSTITUENTS ────────────────────────────
    -- Check if any of the underlying teas in this index are still halted
    SELECT t.symbol INTO v_halted_tea
    FROM teas t
    JOIN indexes i ON t.symbol = ANY(i.teas)
    WHERE i.symbol = p_index_symbol AND t.trading_mode = 'HALTED'
    LIMIT 1;

    IF v_halted_tea IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Halted: Index contains halted tea ' || v_halted_tea || ' due to live auction.');
    END IF;

    SELECT value INTO v_spread FROM platform_config WHERE key = 'spread_pct';
    v_spread := COALESCE(v_spread, 0.01);

    SELECT * INTO v_profile FROM profiles WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'User profile not found');
    END IF;
    v_bal := CASE WHEN p_mode = 'REAL' THEN v_profile.real_balance ELSE v_profile.virtual_balance END;

    SELECT * INTO v_position FROM index_positions
        WHERE user_id = p_user_id AND index_symbol = p_index_symbol AND trading_mode = p_mode
        FOR UPDATE;

    v_existing_qty := COALESCE(v_position.quantity, 0);

    -- ── BUY ──────────────────────────────────────────────────────────
    IF p_side = 'BUY' THEN
        IF v_existing_qty >= 0 THEN
            -- Opening or adding to a LONG position
            v_exec_price := p_price * (1 + v_spread / 2);
            v_notional   := v_exec_price * p_quantity;
            v_margin_req := v_notional / p_leverage;
            v_spread_cost := (v_exec_price - p_price) * p_quantity;

            IF v_bal < v_margin_req THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient margin. Need $' || ROUND(v_margin_req, 2) || ' (have $' || ROUND(v_bal, 2) || ')');
            END IF;
            v_new_balance := v_bal - v_margin_req;

            IF FOUND THEN
                v_new_qty    := v_existing_qty + p_quantity;
                v_new_avg    := ((v_position.avg_entry_price * v_existing_qty) + (v_exec_price * p_quantity)) / v_new_qty;
                v_new_margin := COALESCE(v_position.margin_used, 0) + v_margin_req;
                v_new_leverage := v_new_qty * v_new_avg / NULLIF(v_new_margin, 0);
                UPDATE index_positions SET quantity = v_new_qty, avg_entry_price = v_new_avg,
                    margin_used = v_new_margin, leverage = COALESCE(v_new_leverage, 1), updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                INSERT INTO index_positions (user_id, index_symbol, quantity, avg_entry_price, leverage, margin_used, trading_mode)
                    VALUES (p_user_id, p_index_symbol, p_quantity, v_exec_price, p_leverage, v_margin_req, p_mode);
            END IF;

        ELSE
            -- Closing (covering) a SHORT position, possibly flipping to long
            v_exec_price := p_price * (1 + v_spread / 2);
            v_spread_cost := (v_exec_price - p_price) * p_quantity;
            v_close_qty := LEAST(p_quantity, ABS(v_existing_qty));
            v_open_qty  := p_quantity - v_close_qty;
            v_close_pnl    := (v_position.avg_entry_price - v_exec_price) * v_close_qty;
            v_close_margin := COALESCE(v_position.margin_used, 0) * (v_close_qty / ABS(v_existing_qty));
            v_new_balance  := v_bal + v_close_margin + v_close_pnl;
            IF v_open_qty > 0 THEN
                v_margin_req := v_exec_price * v_open_qty / p_leverage;
                v_new_balance := v_new_balance - v_margin_req;
            END IF;
            IF v_new_balance < 0 THEN
                RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance to complete this trade');
            END IF;
            v_new_qty := v_existing_qty + p_quantity;
            IF v_new_qty = 0 THEN
                DELETE FROM index_positions WHERE id = v_position.id;
            ELSIF v_new_qty > 0 THEN
                UPDATE index_positions SET quantity = v_new_qty, avg_entry_price = v_exec_price,
                    leverage = p_leverage, margin_used = v_exec_price * v_new_qty / p_leverage, updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                UPDATE index_positions SET quantity = v_new_qty,
                    margin_used = COALESCE(v_position.margin_used, 0) - v_close_margin, updated_at = NOW()
                    WHERE id = v_position.id;
            END IF;
        END IF;

    -- ── SELL ─────────────────────────────────────────────────────────
    ELSIF p_side = 'SELL' THEN
        IF v_existing_qty <= 0 THEN
            -- Opening or adding to a SHORT position
            v_exec_price := p_price * (1 - v_spread / 2);
            v_notional   := v_exec_price * p_quantity;
            v_margin_req := v_notional / p_leverage;
            v_spread_cost := (p_price - v_exec_price) * p_quantity;

            IF v_bal < v_margin_req THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient margin. Need $' || ROUND(v_margin_req, 2) || ' (have $' || ROUND(v_bal, 2) || ')');
            END IF;
            v_new_balance := v_bal - v_margin_req;

            IF FOUND THEN
                v_new_qty    := v_existing_qty - p_quantity;
                v_new_avg    := ((v_position.avg_entry_price * ABS(v_existing_qty)) + (v_exec_price * p_quantity)) / ABS(v_new_qty);
                v_new_margin := COALESCE(v_position.margin_used, 0) + v_margin_req;
                v_new_leverage := ABS(v_new_qty) * v_new_avg / NULLIF(v_new_margin, 0);
                UPDATE index_positions SET quantity = v_new_qty, avg_entry_price = v_new_avg,
                    margin_used = v_new_margin, leverage = COALESCE(v_new_leverage, 1), updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                INSERT INTO index_positions (user_id, index_symbol, quantity, avg_entry_price, leverage, margin_used, trading_mode)
                    VALUES (p_user_id, p_index_symbol, -p_quantity, v_exec_price, p_leverage, v_margin_req, p_mode);
            END IF;

        ELSE
            -- Closing a LONG position, possibly flipping to short
            v_exec_price := p_price * (1 - v_spread / 2);
            v_spread_cost := (p_price - v_exec_price) * p_quantity;
            v_close_qty := LEAST(p_quantity, v_existing_qty);
            v_open_qty  := p_quantity - v_close_qty;
            v_close_pnl    := (v_exec_price - v_position.avg_entry_price) * v_close_qty;
            v_close_margin := COALESCE(v_position.margin_used, 0) * (v_close_qty / v_existing_qty);
            v_new_balance  := v_bal + v_close_margin + v_close_pnl;
            IF v_open_qty > 0 THEN
                v_margin_req := v_exec_price * v_open_qty / p_leverage;
                v_new_balance := v_new_balance - v_margin_req;
            END IF;
            IF v_new_balance < 0 THEN
                RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance to complete this trade');
            END IF;
            v_new_qty := v_existing_qty - p_quantity;
            IF v_new_qty = 0 THEN
                DELETE FROM index_positions WHERE id = v_position.id;
            ELSIF v_new_qty > 0 THEN
                UPDATE index_positions SET quantity = v_new_qty,
                    margin_used = COALESCE(v_position.margin_used, 0) - v_close_margin, updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                UPDATE index_positions SET quantity = v_new_qty, avg_entry_price = v_exec_price,
                    leverage = p_leverage, margin_used = v_exec_price * ABS(v_new_qty) / p_leverage, updated_at = NOW()
                    WHERE id = v_position.id;
            END IF;
        END IF;
    END IF;

    -- Update the correct balance column
    IF p_mode = 'REAL' THEN
        UPDATE profiles SET real_balance = v_new_balance WHERE id = p_user_id;
    ELSE
        UPDATE profiles SET virtual_balance = v_new_balance, cash_balance = v_new_balance WHERE id = p_user_id;
    END IF;

    INSERT INTO trades (user_id, tea_id, index_symbol, side, quantity, price, total_value, leverage, trading_mode)
        VALUES (p_user_id, NULL, p_index_symbol, p_side, p_quantity, v_exec_price,
                v_exec_price * p_quantity, p_leverage, p_mode)
        RETURNING * INTO v_trade;

    v_spread_cost := COALESCE(v_spread_cost, 0);
    IF v_spread_cost > 0 THEN
        INSERT INTO platform_revenue (revenue_type, trade_id, user_id, amount, symbol)
            VALUES ('spread', v_trade.id, p_user_id, v_spread_cost, p_index_symbol);
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'trade_id', v_trade.id::TEXT,
        'side', p_side,
        'symbol', p_index_symbol,
        'quantity', p_quantity,
        'market_price', p_price,
        'execution_price', v_exec_price,
        'price', v_exec_price,
        'total', v_exec_price * p_quantity,
        'spread_cost', v_spread_cost,
        'margin_used', COALESCE(v_margin_req, v_close_margin),
        'leverage', p_leverage,
        'new_balance', v_new_balance,
        'mode', p_mode
    );
END;
$$;
