-- ============================================================
-- TECHNICAL AUDIT FIXES
-- 1. execute_index_trade: calculate price server-side (was trusting client p_price)
-- 2. fill_pending_orders: fix no-op margin logic on failed fills
-- 3. anchor_price_audit: restrict RLS to authenticated users
-- ============================================================

-- ── 1. CRITICAL: execute_index_trade must calculate price server-side ──

CREATE OR REPLACE FUNCTION execute_index_trade(
    p_user_id       UUID,
    p_index_symbol  TEXT,
    p_side          TEXT,
    p_quantity      NUMERIC,
    p_price         NUMERIC DEFAULT 0,
    p_leverage      INT DEFAULT 1,
    p_mode          TEXT DEFAULT 'VIRTUAL'
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
    v_bal          NUMERIC;
    v_server_price NUMERIC;
    v_spread       NUMERIC;
    v_exec_price   NUMERIC;
    v_notional     NUMERIC;
    v_margin_req   NUMERIC;
    v_spread_cost  NUMERIC;
    v_new_balance  NUMERIC;
    v_existing_qty NUMERIC;
    v_close_qty    NUMERIC;
    v_open_qty     NUMERIC;
    v_close_pnl    NUMERIC;
    v_close_margin NUMERIC;
    v_new_qty      NUMERIC;
    v_new_avg      NUMERIC;
    v_new_margin   NUMERIC;
    v_new_leverage NUMERIC;
    v_new_status   TEXT;
BEGIN
    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Quantity must be positive');
    END IF;
    IF p_leverage < 1 OR p_leverage > 25 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Leverage must be between 1 and 25');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM indexes WHERE symbol = p_index_symbol) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Index not found: ' || p_index_symbol);
    END IF;

    -- SERVER-SIDE PRICE: always calculate from component teas, never trust client
    SELECT AVG(t.current_price) * COALESCE(MAX(i.multiplier), 1)
        INTO v_server_price
    FROM indexes i, unnest(i.teas) AS tea_sym
    JOIN teas t ON t.symbol = tea_sym
    WHERE i.symbol = p_index_symbol AND t.current_price > 0;

    IF v_server_price IS NULL OR v_server_price <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Cannot determine index price — no live tea data');
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
            v_exec_price := v_server_price * (1 + v_spread / 2);
            v_notional   := v_exec_price * p_quantity;
            v_margin_req := v_notional / p_leverage;
            v_spread_cost := (v_exec_price - v_server_price) * p_quantity;

            IF v_bal < v_margin_req THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient margin. Need $' || ROUND(v_margin_req, 2) || ' (have $' || ROUND(v_bal, 2) || ')');
            END IF;
            v_new_balance := v_bal - v_margin_req;

            IF FOUND THEN
                v_new_qty    := v_existing_qty + p_quantity;
                v_new_avg    := ((v_position.avg_entry_price * v_existing_qty) + (v_exec_price * p_quantity)) / v_new_qty;
                v_new_margin := v_position.margin_used + v_margin_req;
                v_new_leverage := v_new_qty * v_new_avg / NULLIF(v_new_margin, 0);
                UPDATE index_positions SET quantity = v_new_qty, avg_entry_price = v_new_avg,
                    margin_used = v_new_margin, leverage = COALESCE(v_new_leverage, 1), updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                INSERT INTO index_positions (user_id, index_symbol, quantity, avg_entry_price, leverage, margin_used, trading_mode)
                    VALUES (p_user_id, p_index_symbol, p_quantity, v_exec_price, p_leverage, v_margin_req, p_mode);
            END IF;

        ELSE
            v_exec_price := v_server_price * (1 + v_spread / 2);
            v_spread_cost := (v_exec_price - v_server_price) * p_quantity;
            v_close_qty := LEAST(p_quantity, ABS(v_existing_qty));
            v_open_qty  := p_quantity - v_close_qty;
            v_close_pnl    := (v_position.avg_entry_price - v_exec_price) * v_close_qty;
            v_close_margin := v_position.margin_used * (v_close_qty / ABS(v_existing_qty));
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
                    margin_used = v_position.margin_used - v_close_margin, updated_at = NOW()
                    WHERE id = v_position.id;
            END IF;
        END IF;

    -- ── SELL ─────────────────────────────────────────────────────────
    ELSIF p_side = 'SELL' THEN
        IF v_existing_qty <= 0 THEN
            v_exec_price := v_server_price * (1 - v_spread / 2);
            v_notional   := v_exec_price * p_quantity;
            v_margin_req := v_notional / p_leverage;
            v_spread_cost := (v_server_price - v_exec_price) * p_quantity;

            IF v_bal < v_margin_req THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient margin. Need $' || ROUND(v_margin_req, 2) || ' (have $' || ROUND(v_bal, 2) || ')');
            END IF;
            v_new_balance := v_bal - v_margin_req;

            IF FOUND THEN
                v_new_qty    := v_existing_qty - p_quantity;
                v_new_avg    := ((v_position.avg_entry_price * ABS(v_existing_qty)) + (v_exec_price * p_quantity)) / ABS(v_new_qty);
                v_new_margin := v_position.margin_used + v_margin_req;
                v_new_leverage := ABS(v_new_qty) * v_new_avg / NULLIF(v_new_margin, 0);
                UPDATE index_positions SET quantity = v_new_qty, avg_entry_price = v_new_avg,
                    margin_used = v_new_margin, leverage = COALESCE(v_new_leverage, 1), updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                INSERT INTO index_positions (user_id, index_symbol, quantity, avg_entry_price, leverage, margin_used, trading_mode)
                    VALUES (p_user_id, p_index_symbol, -p_quantity, v_exec_price, p_leverage, v_margin_req, p_mode);
            END IF;

        ELSE
            v_exec_price := v_server_price * (1 - v_spread / 2);
            v_spread_cost := (v_server_price - v_exec_price) * p_quantity;
            v_close_qty := LEAST(p_quantity, v_existing_qty);
            v_open_qty  := p_quantity - v_close_qty;
            v_close_pnl    := (v_exec_price - v_position.avg_entry_price) * v_close_qty;
            v_close_margin := v_position.margin_used * (v_close_qty / v_existing_qty);
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
                    margin_used = v_position.margin_used - v_close_margin, updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                UPDATE index_positions SET quantity = v_new_qty, avg_entry_price = v_exec_price,
                    leverage = p_leverage, margin_used = v_exec_price * ABS(v_new_qty) / p_leverage, updated_at = NOW()
                    WHERE id = v_position.id;
            END IF;
        END IF;
    END IF;

    IF p_mode = 'REAL' THEN
        UPDATE profiles SET real_balance = v_new_balance WHERE id = p_user_id;
    ELSE
        UPDATE profiles
        SET virtual_balance = v_new_balance,
            cash_balance    = v_new_balance
        WHERE id = p_user_id;
    END IF;

    INSERT INTO trades (user_id, tea_id, index_symbol, side, quantity, price, total_value, leverage, trading_mode)
        VALUES (p_user_id, NULL, p_index_symbol, p_side, p_quantity, v_exec_price,
                v_exec_price * p_quantity, p_leverage, p_mode)
        RETURNING * INTO v_trade;

    v_spread_cost := COALESCE(v_spread_cost, 0);
    IF v_spread_cost > 0 THEN
        INSERT INTO platform_revenue (revenue_type, trade_id, user_id, amount, symbol)
            VALUES ('SPREAD', v_trade.id, p_user_id, v_spread_cost, p_index_symbol);
    END IF;

    v_new_status := CASE
        WHEN v_new_balance <= 1 THEN 'LOCKED'
        ELSE COALESCE(v_profile.account_status, 'ACTIVE')
    END;
    IF v_new_status IS DISTINCT FROM v_profile.account_status THEN
        UPDATE profiles SET account_status = v_new_status WHERE id = p_user_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'trade_id', v_trade.id::TEXT,
        'execution_price', v_exec_price,
        'server_price', v_server_price,
        'spread_cost', v_spread_cost,
        'quantity', p_quantity,
        'market_price', v_server_price,
        'new_balance', v_new_balance
    );
END;
$$;


-- ── 2. FIX: fill_pending_orders margin logic on failed fills ──

CREATE OR REPLACE FUNCTION fill_pending_orders()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_order          RECORD;
    v_current_price  NUMERIC;
    v_trade_result   JSONB;
    v_filled_count   INT := 0;
BEGIN
    FOR v_order IN
        SELECT po.*, t.current_price AS tea_price
        FROM pending_orders po
        LEFT JOIN teas t ON t.symbol = po.symbol
        WHERE po.status = 'PENDING'
          AND (po.expires_at IS NULL OR po.expires_at > NOW())
        ORDER BY po.created_at ASC
        FOR UPDATE OF po
    LOOP
        IF v_order.is_index THEN
            SELECT AVG(t.current_price) * COALESCE(MAX(i.multiplier), 1)
                INTO v_current_price
            FROM indexes i, unnest(i.teas) AS tea_sym
            JOIN teas t ON t.symbol = tea_sym
            WHERE i.symbol = v_order.symbol AND t.current_price > 0;
        ELSE
            v_current_price := v_order.tea_price;
        END IF;

        IF v_current_price IS NULL OR v_current_price <= 0 THEN CONTINUE; END IF;

        IF (v_order.order_type = 'LIMIT' AND v_order.side = 'BUY'  AND v_current_price <= v_order.target_price)
        OR (v_order.order_type = 'LIMIT' AND v_order.side = 'SELL' AND v_current_price >= v_order.target_price)
        OR (v_order.order_type = 'STOP'  AND v_order.side = 'BUY'  AND v_current_price >= v_order.target_price)
        OR (v_order.order_type = 'STOP'  AND v_order.side = 'SELL' AND v_current_price <= v_order.target_price)
        THEN
            IF v_order.is_index THEN
                SELECT execute_index_trade(v_order.user_id, v_order.symbol, v_order.side, v_order.quantity, v_current_price) INTO v_trade_result;
            ELSE
                -- Refund reserved margin so execute_trade can re-deduct at market price
                IF v_order.side = 'BUY' AND v_order.margin_reserved > 0 THEN
                    UPDATE profiles SET cash_balance = cash_balance + v_order.margin_reserved WHERE id = v_order.user_id;
                END IF;
                SELECT execute_trade(v_order.user_id, v_order.symbol, v_order.side, v_order.quantity) INTO v_trade_result;
            END IF;

            IF (v_trade_result->>'success')::boolean THEN
                UPDATE pending_orders
                SET status = 'FILLED', filled_at = NOW(), fill_price = v_current_price
                WHERE id = v_order.id;
                v_filled_count := v_filled_count + 1;
            ELSE
                -- Trade failed: re-reserve margin that was refunded above
                IF v_order.side = 'BUY' AND v_order.margin_reserved > 0 AND NOT v_order.is_index THEN
                    UPDATE profiles SET cash_balance = cash_balance - v_order.margin_reserved WHERE id = v_order.user_id;
                END IF;
            END IF;
        END IF;
    END LOOP;

    -- Expire overdue orders and refund margin
    FOR v_order IN
        SELECT * FROM pending_orders
        WHERE status = 'PENDING' AND expires_at IS NOT NULL AND expires_at <= NOW()
        FOR UPDATE
    LOOP
        UPDATE pending_orders SET status = 'EXPIRED' WHERE id = v_order.id;
        IF v_order.margin_reserved > 0 THEN
            UPDATE profiles SET cash_balance = cash_balance + v_order.margin_reserved WHERE id = v_order.user_id;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('filled', v_filled_count);
END;
$$;


-- ── 3. Restrict anchor_price_audit RLS to authenticated users ──

DROP POLICY IF EXISTS "Anchor audit read" ON anchor_price_audit;
CREATE POLICY "Anchor audit read" ON anchor_price_audit
    FOR SELECT TO authenticated
    USING (true);
