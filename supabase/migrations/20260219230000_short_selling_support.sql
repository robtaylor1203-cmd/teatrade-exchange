-- Short Selling Support
-- =====================
-- Replaces the SELL branch in execute_trade and execute_index_trade to support
-- short positions (negative quantities in positions/index_positions tables).
--
-- Model: CFD-style margin. Both BUY and SELL debit balance as margin.
-- Positions net: BUY adds +qty, SELL adds -qty. Netting is automatic.
--   - SELL on a long = close/reduce long (credit proceeds)
--   - SELL with no position = open short (debit margin)
--   - BUY on a short = close/reduce short (credit margin + P&L)
--   - BUY with no position = open long (debit cost)

-- ═══════════════════════════════════════════════════════════════════
-- 1. TEA TRADES
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION execute_trade(
    p_user_id    UUID,
    p_tea_symbol TEXT,
    p_side       TEXT,
    p_quantity   NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tea          RECORD;
    v_profile      RECORD;
    v_position     RECORD;
    v_trade        RECORD;
    v_price        NUMERIC;
    v_total        NUMERIC;
    v_new_balance  NUMERIC;
    v_new_qty      NUMERIC;
    v_new_avg      NUMERIC;
    v_existing_qty NUMERIC;
    v_close_qty    NUMERIC;
    v_open_qty     NUMERIC;
    v_tea_id       INT;
BEGIN
    IF p_side NOT IN ('BUY', 'SELL') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid side: must be BUY or SELL');
    END IF;
    IF p_quantity <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Quantity must be greater than zero');
    END IF;

    SELECT * INTO v_tea FROM teas WHERE symbol = p_tea_symbol FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Tea not found: ' || p_tea_symbol);
    END IF;

    v_tea_id := v_tea.id;
    v_price  := v_tea.current_price;
    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'No valid market price');
    END IF;
    v_total := v_price * p_quantity;

    SELECT * INTO v_profile FROM profiles WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'User profile not found');
    END IF;

    SELECT * INTO v_position FROM positions
        WHERE user_id = p_user_id AND tea_id = v_tea_id
        FOR UPDATE;

    v_existing_qty := COALESCE(v_position.quantity, 0);

    -- ── BUY ──────────────────────────────────────────────────────────
    IF p_side = 'BUY' THEN
        IF v_existing_qty >= 0 THEN
            -- Open / extend LONG
            IF v_profile.cash_balance < v_total THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient balance. Need $' || ROUND(v_total, 2));
            END IF;
            v_new_balance := v_profile.cash_balance - v_total;

            IF FOUND THEN
                v_new_qty := v_existing_qty + p_quantity;
                v_new_avg := ((v_position.avg_entry_price * v_existing_qty) + (v_price * p_quantity)) / v_new_qty;
                UPDATE positions SET quantity = v_new_qty, avg_entry_price = v_new_avg, updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                INSERT INTO positions (user_id, tea_id, quantity, avg_entry_price)
                    VALUES (p_user_id, v_tea_id, p_quantity, v_price);
            END IF;
        ELSE
            -- Close / reduce SHORT (and possibly flip to long)
            v_close_qty := LEAST(p_quantity, ABS(v_existing_qty));
            v_open_qty  := p_quantity - v_close_qty;

            -- Return margin + P&L for the closed short portion
            v_new_balance := v_profile.cash_balance
                + (2 * v_position.avg_entry_price - v_price) * v_close_qty;

            IF v_open_qty > 0 THEN
                v_new_balance := v_new_balance - (v_price * v_open_qty);
            END IF;

            IF v_new_balance < 0 THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient balance to complete this trade');
            END IF;

            v_new_qty := v_existing_qty + p_quantity;
            IF v_new_qty = 0 THEN
                DELETE FROM positions WHERE id = v_position.id;
            ELSIF v_new_qty > 0 THEN
                UPDATE positions SET quantity = v_new_qty, avg_entry_price = v_price, updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                UPDATE positions SET quantity = v_new_qty, updated_at = NOW()
                    WHERE id = v_position.id;
            END IF;
        END IF;

    -- ── SELL ─────────────────────────────────────────────────────────
    ELSIF p_side = 'SELL' THEN
        IF v_existing_qty <= 0 THEN
            -- Open / extend SHORT
            IF v_profile.cash_balance < v_total THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient balance. Need $' || ROUND(v_total, 2));
            END IF;
            v_new_balance := v_profile.cash_balance - v_total;

            IF FOUND THEN
                v_new_qty := v_existing_qty - p_quantity;
                v_new_avg := ((v_position.avg_entry_price * ABS(v_existing_qty)) + (v_price * p_quantity)) / ABS(v_new_qty);
                UPDATE positions SET quantity = v_new_qty, avg_entry_price = v_new_avg, updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                INSERT INTO positions (user_id, tea_id, quantity, avg_entry_price)
                    VALUES (p_user_id, v_tea_id, -p_quantity, v_price);
            END IF;
        ELSE
            -- Close / reduce LONG (and possibly flip to short)
            v_close_qty := LEAST(p_quantity, v_existing_qty);
            v_open_qty  := p_quantity - v_close_qty;

            -- Credit sell proceeds for the closed long portion
            v_new_balance := v_profile.cash_balance + (v_price * v_close_qty);

            IF v_open_qty > 0 THEN
                v_new_balance := v_new_balance - (v_price * v_open_qty);
            END IF;

            IF v_new_balance < 0 THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient balance to complete this trade');
            END IF;

            v_new_qty := v_existing_qty - p_quantity;
            IF v_new_qty = 0 THEN
                DELETE FROM positions WHERE id = v_position.id;
            ELSIF v_new_qty > 0 THEN
                UPDATE positions SET quantity = v_new_qty, updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                UPDATE positions SET quantity = v_new_qty, avg_entry_price = v_price, updated_at = NOW()
                    WHERE id = v_position.id;
            END IF;
        END IF;
    END IF;

    UPDATE profiles SET cash_balance = v_new_balance WHERE id = p_user_id;

    INSERT INTO trades (user_id, tea_id, side, quantity, price, total_value)
        VALUES (p_user_id, v_tea_id, p_side, p_quantity, v_price, v_total)
        RETURNING * INTO v_trade;

    RETURN jsonb_build_object(
        'success',     true,
        'trade_id',    v_trade.id::TEXT,
        'side',        p_side,
        'symbol',      p_tea_symbol,
        'quantity',    p_quantity,
        'price',       v_price,
        'total',       v_total,
        'new_balance', v_new_balance
    );
END;
$$;


-- ═══════════════════════════════════════════════════════════════════
-- 2. INDEX TRADES
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION execute_index_trade(
    p_user_id      UUID,
    p_index_symbol TEXT,
    p_side         TEXT,
    p_quantity     NUMERIC,
    p_price        NUMERIC
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
    v_total        NUMERIC;
    v_new_balance  NUMERIC;
    v_new_qty      NUMERIC;
    v_new_avg      NUMERIC;
    v_existing_qty NUMERIC;
    v_close_qty    NUMERIC;
    v_open_qty     NUMERIC;
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

    v_total := p_price * p_quantity;

    SELECT * INTO v_profile FROM profiles WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'User profile not found');
    END IF;

    SELECT * INTO v_position FROM index_positions
        WHERE user_id = p_user_id AND index_symbol = p_index_symbol
        FOR UPDATE;

    v_existing_qty := COALESCE(v_position.quantity, 0);

    -- ── BUY ──────────────────────────────────────────────────────────
    IF p_side = 'BUY' THEN
        IF v_existing_qty >= 0 THEN
            IF v_profile.cash_balance < v_total THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient balance. Need $' || ROUND(v_total, 2));
            END IF;
            v_new_balance := v_profile.cash_balance - v_total;

            IF FOUND THEN
                v_new_qty := v_existing_qty + p_quantity;
                v_new_avg := ((v_position.avg_entry_price * v_existing_qty) + (p_price * p_quantity)) / v_new_qty;
                UPDATE index_positions SET quantity = v_new_qty, avg_entry_price = v_new_avg, updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                INSERT INTO index_positions (user_id, index_symbol, quantity, avg_entry_price)
                    VALUES (p_user_id, p_index_symbol, p_quantity, p_price);
            END IF;
        ELSE
            v_close_qty := LEAST(p_quantity, ABS(v_existing_qty));
            v_open_qty  := p_quantity - v_close_qty;

            v_new_balance := v_profile.cash_balance
                + (2 * v_position.avg_entry_price - p_price) * v_close_qty;

            IF v_open_qty > 0 THEN
                v_new_balance := v_new_balance - (p_price * v_open_qty);
            END IF;

            IF v_new_balance < 0 THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient balance to complete this trade');
            END IF;

            v_new_qty := v_existing_qty + p_quantity;
            IF v_new_qty = 0 THEN
                DELETE FROM index_positions WHERE id = v_position.id;
            ELSIF v_new_qty > 0 THEN
                UPDATE index_positions SET quantity = v_new_qty, avg_entry_price = p_price, updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                UPDATE index_positions SET quantity = v_new_qty, updated_at = NOW()
                    WHERE id = v_position.id;
            END IF;
        END IF;

    -- ── SELL ─────────────────────────────────────────────────────────
    ELSIF p_side = 'SELL' THEN
        IF v_existing_qty <= 0 THEN
            IF v_profile.cash_balance < v_total THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient balance. Need $' || ROUND(v_total, 2));
            END IF;
            v_new_balance := v_profile.cash_balance - v_total;

            IF FOUND THEN
                v_new_qty := v_existing_qty - p_quantity;
                v_new_avg := ((v_position.avg_entry_price * ABS(v_existing_qty)) + (p_price * p_quantity)) / ABS(v_new_qty);
                UPDATE index_positions SET quantity = v_new_qty, avg_entry_price = v_new_avg, updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                INSERT INTO index_positions (user_id, index_symbol, quantity, avg_entry_price)
                    VALUES (p_user_id, p_index_symbol, -p_quantity, p_price);
            END IF;
        ELSE
            v_close_qty := LEAST(p_quantity, v_existing_qty);
            v_open_qty  := p_quantity - v_close_qty;

            v_new_balance := v_profile.cash_balance + (p_price * v_close_qty);

            IF v_open_qty > 0 THEN
                v_new_balance := v_new_balance - (p_price * v_open_qty);
            END IF;

            IF v_new_balance < 0 THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient balance to complete this trade');
            END IF;

            v_new_qty := v_existing_qty - p_quantity;
            IF v_new_qty = 0 THEN
                DELETE FROM index_positions WHERE id = v_position.id;
            ELSIF v_new_qty > 0 THEN
                UPDATE index_positions SET quantity = v_new_qty, updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                UPDATE index_positions SET quantity = v_new_qty, avg_entry_price = p_price, updated_at = NOW()
                    WHERE id = v_position.id;
            END IF;
        END IF;
    END IF;

    UPDATE profiles SET cash_balance = v_new_balance WHERE id = p_user_id;

    INSERT INTO trades (user_id, tea_id, index_symbol, side, quantity, price, total_value)
        VALUES (p_user_id, NULL, p_index_symbol, p_side, p_quantity, p_price, v_total)
        RETURNING * INTO v_trade;

    RETURN jsonb_build_object(
        'success',     true,
        'trade_id',    v_trade.id::TEXT,
        'side',        p_side,
        'symbol',      p_index_symbol,
        'quantity',    p_quantity,
        'price',       p_price,
        'total',       v_total,
        'new_balance', v_new_balance
    );
END;
$$;
