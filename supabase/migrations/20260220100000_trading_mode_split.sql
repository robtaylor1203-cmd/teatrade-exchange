-- ═══════════════════════════════════════════════════════════════════════════
-- TRADING MODE SPLIT: Virtual vs Real Money
-- ═══════════════════════════════════════════════════════════════════════════
-- Adds a trading_mode column ('VIRTUAL' | 'REAL') to all financial tables.
-- Splits cash_balance into virtual_balance + real_balance on profiles.
-- Updates all SECURITY DEFINER functions to accept and filter by mode.

-- ─── 1. PROFILES: Split balance ─────────────────────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS virtual_balance NUMERIC NOT NULL DEFAULT 10000 CHECK (virtual_balance >= 0);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS real_balance    NUMERIC NOT NULL DEFAULT 0     CHECK (real_balance >= 0);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS trading_mode    TEXT    NOT NULL DEFAULT 'VIRTUAL' CHECK (trading_mode IN ('VIRTUAL', 'REAL'));

-- Migrate existing cash_balance → virtual_balance
UPDATE profiles SET virtual_balance = cash_balance WHERE cash_balance > 0 AND virtual_balance = 10000;

-- Protect new columns from direct client writes
REVOKE UPDATE (virtual_balance, real_balance) ON profiles FROM authenticated;
REVOKE UPDATE (virtual_balance, real_balance) ON profiles FROM anon;

-- ─── 2. TRADES: Add mode column ─────────────────────────────────────────
ALTER TABLE trades ADD COLUMN IF NOT EXISTS trading_mode TEXT NOT NULL DEFAULT 'VIRTUAL'
    CHECK (trading_mode IN ('VIRTUAL', 'REAL'));
CREATE INDEX IF NOT EXISTS idx_trades_mode ON trades (user_id, trading_mode);

-- ─── 3. POSITIONS: Add mode column ──────────────────────────────────────
ALTER TABLE positions ADD COLUMN IF NOT EXISTS trading_mode TEXT NOT NULL DEFAULT 'VIRTUAL'
    CHECK (trading_mode IN ('VIRTUAL', 'REAL'));
DROP INDEX IF EXISTS idx_positions_user_tea;
CREATE UNIQUE INDEX idx_positions_user_tea_mode ON positions (user_id, tea_id, trading_mode);

-- ─── 4. INDEX POSITIONS: Add mode column ────────────────────────────────
ALTER TABLE index_positions ADD COLUMN IF NOT EXISTS trading_mode TEXT NOT NULL DEFAULT 'VIRTUAL'
    CHECK (trading_mode IN ('VIRTUAL', 'REAL'));
DROP INDEX IF EXISTS idx_index_positions_user_symbol;
CREATE UNIQUE INDEX idx_idx_pos_user_symbol_mode ON index_positions (user_id, index_symbol, trading_mode);

-- ─── 5. PENDING ORDERS: Add mode column ─────────────────────────────────
ALTER TABLE pending_orders ADD COLUMN IF NOT EXISTS trading_mode TEXT NOT NULL DEFAULT 'VIRTUAL'
    CHECK (trading_mode IN ('VIRTUAL', 'REAL'));

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. EXECUTE_TRADE — now mode-aware
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION execute_trade(
    p_user_id    UUID,
    p_tea_symbol TEXT,
    p_side       TEXT,
    p_quantity   NUMERIC,
    p_mode       TEXT DEFAULT 'VIRTUAL'
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
    v_bal          NUMERIC;
    v_new_balance  NUMERIC;
    v_new_qty      NUMERIC;
    v_new_avg      NUMERIC;
    v_existing_qty NUMERIC;
    v_close_qty    NUMERIC;
    v_open_qty     NUMERIC;
    v_tea_id       INT;
    v_bal_col      TEXT;
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

    v_bal := CASE WHEN p_mode = 'REAL' THEN v_profile.real_balance ELSE v_profile.virtual_balance END;

    SELECT * INTO v_position FROM positions
        WHERE user_id = p_user_id AND tea_id = v_tea_id AND trading_mode = p_mode
        FOR UPDATE;

    v_existing_qty := COALESCE(v_position.quantity, 0);

    -- ── BUY ──────────────────────────────────────────────────────────
    IF p_side = 'BUY' THEN
        IF v_existing_qty >= 0 THEN
            IF v_bal < v_total THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient balance. Need $' || ROUND(v_total, 2));
            END IF;
            v_new_balance := v_bal - v_total;

            IF FOUND THEN
                v_new_qty := v_existing_qty + p_quantity;
                v_new_avg := ((v_position.avg_entry_price * v_existing_qty) + (v_price * p_quantity)) / v_new_qty;
                UPDATE positions SET quantity = v_new_qty, avg_entry_price = v_new_avg, updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                INSERT INTO positions (user_id, tea_id, quantity, avg_entry_price, trading_mode)
                    VALUES (p_user_id, v_tea_id, p_quantity, v_price, p_mode);
            END IF;
        ELSE
            v_close_qty := LEAST(p_quantity, ABS(v_existing_qty));
            v_open_qty  := p_quantity - v_close_qty;
            v_new_balance := v_bal + (2 * v_position.avg_entry_price - v_price) * v_close_qty;
            IF v_open_qty > 0 THEN v_new_balance := v_new_balance - (v_price * v_open_qty); END IF;
            IF v_new_balance < 0 THEN
                RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance to complete this trade');
            END IF;
            v_new_qty := v_existing_qty + p_quantity;
            IF v_new_qty = 0 THEN
                DELETE FROM positions WHERE id = v_position.id;
            ELSIF v_new_qty > 0 THEN
                UPDATE positions SET quantity = v_new_qty, avg_entry_price = v_price, updated_at = NOW() WHERE id = v_position.id;
            ELSE
                UPDATE positions SET quantity = v_new_qty, updated_at = NOW() WHERE id = v_position.id;
            END IF;
        END IF;

    -- ── SELL ─────────────────────────────────────────────────────────
    ELSIF p_side = 'SELL' THEN
        IF v_existing_qty <= 0 THEN
            IF v_bal < v_total THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient balance. Need $' || ROUND(v_total, 2));
            END IF;
            v_new_balance := v_bal - v_total;

            IF FOUND THEN
                v_new_qty := v_existing_qty - p_quantity;
                v_new_avg := ((v_position.avg_entry_price * ABS(v_existing_qty)) + (v_price * p_quantity)) / ABS(v_new_qty);
                UPDATE positions SET quantity = v_new_qty, avg_entry_price = v_new_avg, updated_at = NOW() WHERE id = v_position.id;
            ELSE
                INSERT INTO positions (user_id, tea_id, quantity, avg_entry_price, trading_mode)
                    VALUES (p_user_id, v_tea_id, -p_quantity, v_price, p_mode);
            END IF;
        ELSE
            v_close_qty := LEAST(p_quantity, v_existing_qty);
            v_open_qty  := p_quantity - v_close_qty;
            v_new_balance := v_bal + (v_price * v_close_qty);
            IF v_open_qty > 0 THEN v_new_balance := v_new_balance - (v_price * v_open_qty); END IF;
            IF v_new_balance < 0 THEN
                RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance to complete this trade');
            END IF;
            v_new_qty := v_existing_qty - p_quantity;
            IF v_new_qty = 0 THEN
                DELETE FROM positions WHERE id = v_position.id;
            ELSIF v_new_qty > 0 THEN
                UPDATE positions SET quantity = v_new_qty, updated_at = NOW() WHERE id = v_position.id;
            ELSE
                UPDATE positions SET quantity = v_new_qty, avg_entry_price = v_price, updated_at = NOW() WHERE id = v_position.id;
            END IF;
        END IF;
    END IF;

    IF p_mode = 'REAL' THEN
        UPDATE profiles SET real_balance = v_new_balance WHERE id = p_user_id;
    ELSE
        UPDATE profiles SET virtual_balance = v_new_balance WHERE id = p_user_id;
    END IF;

    INSERT INTO trades (user_id, tea_id, side, quantity, price, total_value, trading_mode)
        VALUES (p_user_id, v_tea_id, p_side, p_quantity, v_price, v_total, p_mode)
        RETURNING * INTO v_trade;

    RETURN jsonb_build_object(
        'success', true, 'trade_id', v_trade.id::TEXT, 'side', p_side,
        'symbol', p_tea_symbol, 'quantity', p_quantity, 'price', v_price,
        'total', v_total, 'new_balance', v_new_balance, 'mode', p_mode
    );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. EXECUTE_INDEX_TRADE — now mode-aware
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION execute_index_trade(
    p_user_id      UUID,
    p_index_symbol TEXT,
    p_side         TEXT,
    p_quantity     NUMERIC,
    p_price        NUMERIC,
    p_mode         TEXT DEFAULT 'VIRTUAL'
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
    v_bal          NUMERIC;
    v_new_balance  NUMERIC;
    v_new_qty      NUMERIC;
    v_new_avg      NUMERIC;
    v_existing_qty NUMERIC;
    v_close_qty    NUMERIC;
    v_open_qty     NUMERIC;
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

    IF NOT EXISTS (SELECT 1 FROM indexes WHERE symbol = p_index_symbol) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Index not found: ' || p_index_symbol);
    END IF;

    v_total := p_price * p_quantity;

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
            IF v_bal < v_total THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient balance. Need $' || ROUND(v_total, 2));
            END IF;
            v_new_balance := v_bal - v_total;
            IF FOUND THEN
                v_new_qty := v_existing_qty + p_quantity;
                v_new_avg := ((v_position.avg_entry_price * v_existing_qty) + (p_price * p_quantity)) / v_new_qty;
                UPDATE index_positions SET quantity = v_new_qty, avg_entry_price = v_new_avg, updated_at = NOW() WHERE id = v_position.id;
            ELSE
                INSERT INTO index_positions (user_id, index_symbol, quantity, avg_entry_price, trading_mode)
                    VALUES (p_user_id, p_index_symbol, p_quantity, p_price, p_mode);
            END IF;
        ELSE
            v_close_qty := LEAST(p_quantity, ABS(v_existing_qty));
            v_open_qty  := p_quantity - v_close_qty;
            v_new_balance := v_bal + (2 * v_position.avg_entry_price - p_price) * v_close_qty;
            IF v_open_qty > 0 THEN v_new_balance := v_new_balance - (p_price * v_open_qty); END IF;
            IF v_new_balance < 0 THEN
                RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance to complete this trade');
            END IF;
            v_new_qty := v_existing_qty + p_quantity;
            IF v_new_qty = 0 THEN DELETE FROM index_positions WHERE id = v_position.id;
            ELSIF v_new_qty > 0 THEN UPDATE index_positions SET quantity = v_new_qty, avg_entry_price = p_price, updated_at = NOW() WHERE id = v_position.id;
            ELSE UPDATE index_positions SET quantity = v_new_qty, updated_at = NOW() WHERE id = v_position.id;
            END IF;
        END IF;

    -- ── SELL ─────────────────────────────────────────────────────────
    ELSIF p_side = 'SELL' THEN
        IF v_existing_qty <= 0 THEN
            IF v_bal < v_total THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient balance. Need $' || ROUND(v_total, 2));
            END IF;
            v_new_balance := v_bal - v_total;
            IF FOUND THEN
                v_new_qty := v_existing_qty - p_quantity;
                v_new_avg := ((v_position.avg_entry_price * ABS(v_existing_qty)) + (p_price * p_quantity)) / ABS(v_new_qty);
                UPDATE index_positions SET quantity = v_new_qty, avg_entry_price = v_new_avg, updated_at = NOW() WHERE id = v_position.id;
            ELSE
                INSERT INTO index_positions (user_id, index_symbol, quantity, avg_entry_price, trading_mode)
                    VALUES (p_user_id, p_index_symbol, -p_quantity, p_price, p_mode);
            END IF;
        ELSE
            v_close_qty := LEAST(p_quantity, v_existing_qty);
            v_open_qty  := p_quantity - v_close_qty;
            v_new_balance := v_bal + (p_price * v_close_qty);
            IF v_open_qty > 0 THEN v_new_balance := v_new_balance - (p_price * v_open_qty); END IF;
            IF v_new_balance < 0 THEN
                RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance to complete this trade');
            END IF;
            v_new_qty := v_existing_qty - p_quantity;
            IF v_new_qty = 0 THEN DELETE FROM index_positions WHERE id = v_position.id;
            ELSIF v_new_qty > 0 THEN UPDATE index_positions SET quantity = v_new_qty, updated_at = NOW() WHERE id = v_position.id;
            ELSE UPDATE index_positions SET quantity = v_new_qty, avg_entry_price = p_price, updated_at = NOW() WHERE id = v_position.id;
            END IF;
        END IF;
    END IF;

    IF p_mode = 'REAL' THEN
        UPDATE profiles SET real_balance = v_new_balance WHERE id = p_user_id;
    ELSE
        UPDATE profiles SET virtual_balance = v_new_balance WHERE id = p_user_id;
    END IF;

    INSERT INTO trades (user_id, tea_id, index_symbol, side, quantity, price, total_value, trading_mode)
        VALUES (p_user_id, NULL, p_index_symbol, p_side, p_quantity, p_price, v_total, p_mode)
        RETURNING * INTO v_trade;

    RETURN jsonb_build_object(
        'success', true, 'trade_id', v_trade.id::TEXT, 'side', p_side,
        'symbol', p_index_symbol, 'quantity', p_quantity, 'price', p_price,
        'total', v_total, 'new_balance', v_new_balance, 'mode', p_mode
    );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. RESET_ACCOUNT — now mode-aware
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION reset_account(
    p_user_id         UUID,
    p_default_balance NUMERIC DEFAULT 10000,
    p_mode            TEXT DEFAULT 'VIRTUAL'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_user_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Profile not found');
    END IF;

    DELETE FROM positions WHERE user_id = p_user_id AND trading_mode = p_mode;
    DELETE FROM index_positions WHERE user_id = p_user_id AND trading_mode = p_mode;
    DELETE FROM trades WHERE user_id = p_user_id AND trading_mode = p_mode;

    IF p_mode = 'REAL' THEN
        UPDATE profiles SET real_balance = p_default_balance WHERE id = p_user_id;
    ELSE
        UPDATE profiles SET virtual_balance = p_default_balance WHERE id = p_user_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'new_balance', p_default_balance, 'mode', p_mode);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. PLACE_ORDER — now mode-aware
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION place_order(
    p_user_id       UUID,
    p_symbol        TEXT,
    p_is_index      BOOLEAN,
    p_side          TEXT,
    p_order_type    TEXT,
    p_quantity      NUMERIC,
    p_target_price  NUMERIC,
    p_expires_hours INT DEFAULT NULL,
    p_mode          TEXT DEFAULT 'VIRTUAL'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile       RECORD;
    v_bal           NUMERIC;
    v_margin        NUMERIC;
    v_new_balance   NUMERIC;
    v_order         RECORD;
    v_expires_at    TIMESTAMPTZ;
BEGIN
    IF p_side NOT IN ('BUY', 'SELL') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Side must be BUY or SELL');
    END IF;
    IF p_order_type NOT IN ('LIMIT', 'STOP') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Order type must be LIMIT or STOP');
    END IF;
    IF p_quantity <= 0 THEN RETURN jsonb_build_object('success', false, 'error', 'Quantity must be positive'); END IF;
    IF p_target_price <= 0 THEN RETURN jsonb_build_object('success', false, 'error', 'Price must be positive'); END IF;

    SELECT * INTO v_profile FROM profiles WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Profile not found'); END IF;

    v_bal := CASE WHEN p_mode = 'REAL' THEN v_profile.real_balance ELSE v_profile.virtual_balance END;

    v_margin := 0;
    IF p_side = 'BUY' THEN
        v_margin := p_quantity * p_target_price;
        IF v_bal < v_margin THEN
            RETURN jsonb_build_object('success', false, 'error',
                'Insufficient balance. Need $' || ROUND(v_margin, 2) || ' (have $' || ROUND(v_bal, 2) || ')');
        END IF;
        v_new_balance := v_bal - v_margin;
        IF p_mode = 'REAL' THEN
            UPDATE profiles SET real_balance = v_new_balance WHERE id = p_user_id;
        ELSE
            UPDATE profiles SET virtual_balance = v_new_balance WHERE id = p_user_id;
        END IF;
    END IF;

    IF p_expires_hours IS NOT NULL AND p_expires_hours > 0 THEN
        v_expires_at := NOW() + (p_expires_hours || ' hours')::INTERVAL;
    END IF;

    INSERT INTO pending_orders (user_id, symbol, is_index, side, order_type, quantity, target_price, margin_reserved, expires_at, trading_mode)
        VALUES (p_user_id, p_symbol, p_is_index, p_side, p_order_type, p_quantity, p_target_price, v_margin, v_expires_at, p_mode)
        RETURNING * INTO v_order;

    RETURN jsonb_build_object(
        'success', true, 'order_id', v_order.id::TEXT,
        'margin_reserved', v_margin, 'new_balance', COALESCE(v_new_balance, v_bal)
    );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. CANCEL_ORDER — now mode-aware (mode inferred from the order itself)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION cancel_order(
    p_user_id   UUID,
    p_order_id  UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_order   RECORD;
    v_profile RECORD;
    v_new_bal NUMERIC;
BEGIN
    SELECT * INTO v_order FROM pending_orders WHERE id = p_order_id AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Order not found'); END IF;
    IF v_order.status <> 'PENDING' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Order is already ' || v_order.status);
    END IF;

    UPDATE pending_orders SET status = 'CANCELLED' WHERE id = p_order_id;

    IF v_order.margin_reserved > 0 THEN
        SELECT * INTO v_profile FROM profiles WHERE id = p_user_id FOR UPDATE;
        IF COALESCE(v_order.trading_mode, 'VIRTUAL') = 'REAL' THEN
            v_new_bal := v_profile.real_balance + v_order.margin_reserved;
            UPDATE profiles SET real_balance = v_new_bal WHERE id = p_user_id;
        ELSE
            v_new_bal := v_profile.virtual_balance + v_order.margin_reserved;
            UPDATE profiles SET virtual_balance = v_new_bal WHERE id = p_user_id;
        END IF;
    ELSE
        SELECT CASE WHEN COALESCE(v_order.trading_mode, 'VIRTUAL') = 'REAL' THEN real_balance ELSE virtual_balance END
            INTO v_new_bal FROM profiles WHERE id = p_user_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'refunded', v_order.margin_reserved, 'new_balance', v_new_bal);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. CLOSE_PAIR_TRADE — now mode-aware
-- ═══════════════════════════════════════════════════════════════════════════
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
    v_mode         TEXT;
BEGIN
    IF p_exit_ratio IS NULL OR p_exit_ratio <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid exit ratio');
    END IF;

    SELECT * INTO v_trade FROM trades WHERE id::TEXT = p_trade_id AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Trade not found'); END IF;
    IF NOT COALESCE(v_trade.is_pair_trade, false) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Not a pair trade');
    END IF;

    v_mode      := COALESCE(v_trade.trading_mode, 'VIRTUAL');
    v_margin    := v_trade.quantity;
    v_leverage  := COALESCE(v_trade.leverage, 1);
    v_direction := CASE WHEN v_trade.side = 'BUY' THEN 1 ELSE -1 END;
    v_ratio_change := (p_exit_ratio - v_trade.price) / v_trade.price;
    v_pnl        := v_margin * v_ratio_change * v_leverage * v_direction;
    v_return_amt := v_margin + v_pnl;

    SELECT * INTO v_profile FROM profiles WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'User profile not found'); END IF;

    IF v_mode = 'REAL' THEN
        v_new_balance := v_profile.real_balance + v_return_amt;
        UPDATE profiles SET real_balance = v_new_balance WHERE id = p_user_id;
    ELSE
        v_new_balance := v_profile.virtual_balance + v_return_amt;
        UPDATE profiles SET virtual_balance = v_new_balance WHERE id = p_user_id;
    END IF;

    INSERT INTO trades (user_id, tea_id, index_symbol, side, quantity, price, total_value, pair_id, leverage, is_pair_trade, trading_mode)
        VALUES (p_user_id, v_trade.tea_id, v_trade.index_symbol,
                CASE WHEN v_trade.side = 'BUY' THEN 'SELL' ELSE 'BUY' END,
                v_margin, p_exit_ratio, v_return_amt, v_trade.pair_id, v_leverage, true, v_mode)
        RETURNING * INTO v_close_trade;

    RETURN jsonb_build_object(
        'success', true, 'trade_id', v_close_trade.id::TEXT, 'pnl', v_pnl,
        'return_amount', v_return_amt, 'new_balance', v_new_balance,
        'entry_ratio', v_trade.price, 'exit_ratio', p_exit_ratio,
        'margin', v_margin, 'leverage', v_leverage
    );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. Backward compatibility: keep cash_balance as a computed alias
-- ═══════════════════════════════════════════════════════════════════════════
-- The old cash_balance column still exists. Keep it in sync with virtual_balance
-- so any code that hasn't migrated yet still works.
CREATE OR REPLACE FUNCTION sync_cash_balance()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    NEW.cash_balance := NEW.virtual_balance;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_cash_balance ON profiles;
CREATE TRIGGER trg_sync_cash_balance
    BEFORE INSERT OR UPDATE OF virtual_balance ON profiles
    FOR EACH ROW EXECUTE FUNCTION sync_cash_balance();

-- Initial sync
UPDATE profiles SET cash_balance = virtual_balance WHERE cash_balance <> virtual_balance;
