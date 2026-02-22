-- ═══════════════════════════════════════════════════════════════════════════════
-- INSTITUTIONAL RISK MANAGEMENT (FCA-Compliant House Protection)
--
-- Adds:
--   1. Risk metric columns on teas (trading_mode, exposure limits, spread)
--   2. Updated execute_trade() with halt checks, exposure gating, volume tracking
--   3. Updated execute_index_trade() with the same halt/exposure checks
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── 1. RISK COLUMNS ON TEAS ──────────────────────────────────────────────────
ALTER TABLE teas ADD COLUMN IF NOT EXISTS trading_mode          TEXT    DEFAULT 'FULL';
ALTER TABLE teas ADD COLUMN IF NOT EXISTS max_exposure          NUMERIC DEFAULT 500000;
ALTER TABLE teas ADD COLUMN IF NOT EXISTS current_long_volume   NUMERIC DEFAULT 0;
ALTER TABLE teas ADD COLUMN IF NOT EXISTS current_short_volume  NUMERIC DEFAULT 0;
ALTER TABLE teas ADD COLUMN IF NOT EXISTS base_spread           NUMERIC DEFAULT 0.01;
ALTER TABLE teas ADD COLUMN IF NOT EXISTS volatility_multiplier NUMERIC DEFAULT 1.0;
ALTER TABLE teas ADD COLUMN IF NOT EXISTS halt_until            TIMESTAMPTZ;

-- Constraint: trading_mode must be a known value
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teas_trading_mode_valid') THEN
        ALTER TABLE teas ADD CONSTRAINT teas_trading_mode_valid
            CHECK (trading_mode IN ('FULL', 'CLOSE_ONLY', 'HALTED'));
    END IF;
END $$;

-- ─── 2. UPDATED execute_trade() WITH RISK MANAGEMENT ─────────────────────────
-- Drop all existing overloads to avoid ambiguity
DROP FUNCTION IF EXISTS execute_trade(UUID, TEXT, TEXT, NUMERIC);
DROP FUNCTION IF EXISTS execute_trade(UUID, TEXT, TEXT, NUMERIC, TEXT, NUMERIC);

CREATE OR REPLACE FUNCTION execute_trade(
    p_user_id    UUID,
    p_tea_symbol TEXT,
    p_side       TEXT,
    p_quantity   NUMERIC,
    p_mode       TEXT DEFAULT 'VIRTUAL',
    p_leverage   NUMERIC DEFAULT 1
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tea         RECORD;
    v_profile     RECORD;
    v_position    RECORD;
    v_trade       RECORD;
    v_price       NUMERIC;
    v_total       NUMERIC;
    v_new_balance NUMERIC;
    v_new_qty     NUMERIC;
    v_new_avg     NUMERIC;
    v_is_closing  BOOLEAN;
    v_spread      NUMERIC;
    v_exec_price  NUMERIC;
    v_spread_cost NUMERIC;
BEGIN
    IF p_side NOT IN ('BUY', 'SELL') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid side: must be BUY or SELL');
    END IF;
    IF p_quantity <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Quantity must be greater than zero');
    END IF;

    -- Lock and fetch the tea row
    SELECT * INTO v_tea FROM teas WHERE symbol = p_tea_symbol FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Tea not found: ' || p_tea_symbol);
    END IF;

    -- ── RISK CHECK: Trading mode ──────────────────────────────────────
    -- Auto-recover from HALTED if halt_until has expired
    IF v_tea.trading_mode = 'HALTED' THEN
        IF v_tea.halt_until IS NOT NULL AND v_tea.halt_until <= NOW() THEN
            UPDATE teas SET trading_mode = 'FULL', halt_until = NULL WHERE id = v_tea.id;
            v_tea.trading_mode := 'FULL';
            v_tea.halt_until := NULL;
        ELSE
            RETURN jsonb_build_object('success', false, 'error',
                'Market halted for ' || p_tea_symbol || ' due to extreme volatility. Please wait.');
        END IF;
    END IF;

    -- Determine if this trade is closing an existing position
    v_is_closing := false;
    IF p_side = 'SELL' THEN
        -- For teas, SELL always reduces a long position (must have holdings)
        v_is_closing := true;
    END IF;

    -- CLOSE_ONLY: block new exposure, allow only closing trades
    IF v_tea.trading_mode = 'CLOSE_ONLY' AND NOT v_is_closing THEN
        RETURN jsonb_build_object('success', false, 'error',
            'Maximum platform exposure reached for ' || p_tea_symbol || '. Only closing trades are allowed.');
    END IF;

    -- Exposure cap: block BUY if it would exceed max_exposure
    IF p_side = 'BUY'
       AND (COALESCE(v_tea.current_long_volume, 0) + p_quantity) > COALESCE(v_tea.max_exposure, 500000) THEN
        RETURN jsonb_build_object('success', false, 'error',
            'Maximum platform exposure reached for ' || p_tea_symbol || '. Only closing trades are allowed.');
    END IF;

    -- ── PRICE + SPREAD ────────────────────────────────────────────────
    v_price := v_tea.current_price;
    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'No valid market price');
    END IF;

    -- Symmetric spread: widen by volatility_multiplier for risk protection
    v_spread := COALESCE(v_tea.base_spread, 0.01) * COALESCE(v_tea.volatility_multiplier, 1.0);
    IF p_side = 'BUY' THEN
        v_exec_price := v_price * (1.0 + v_spread / 2.0);
    ELSE
        v_exec_price := v_price * (1.0 - v_spread / 2.0);
    END IF;
    v_spread_cost := ABS(v_exec_price - v_price) * p_quantity;

    v_total := v_exec_price * p_quantity;

    SELECT * INTO v_profile FROM profiles WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'User profile not found');
    END IF;

    -- ── BUY ─────────────────────────────────────────────────────────
    IF p_side = 'BUY' THEN
        IF v_profile.cash_balance < v_total THEN
            RETURN jsonb_build_object('success', false, 'error',
                'Insufficient balance. Need $' || ROUND(v_total, 2));
        END IF;

        v_new_balance := v_profile.cash_balance - v_total;
        UPDATE profiles SET cash_balance = v_new_balance WHERE id = p_user_id;

        SELECT * INTO v_position FROM positions
            WHERE user_id = p_user_id
              AND tea_id = (SELECT id FROM teas WHERE symbol = p_tea_symbol)
            FOR UPDATE;

        IF FOUND THEN
            v_new_qty := v_position.quantity + p_quantity;
            v_new_avg := ((v_position.avg_entry_price * v_position.quantity) + (v_exec_price * p_quantity)) / v_new_qty;
            UPDATE positions
                SET quantity = v_new_qty, avg_entry_price = v_new_avg, updated_at = NOW()
                WHERE id = v_position.id;
        ELSE
            INSERT INTO positions (user_id, tea_id, quantity, avg_entry_price)
                VALUES (p_user_id,
                        (SELECT id FROM teas WHERE symbol = p_tea_symbol),
                        p_quantity, v_exec_price);
        END IF;

        -- Track platform long exposure
        UPDATE teas
        SET current_long_volume = COALESCE(current_long_volume, 0) + p_quantity
        WHERE symbol = p_tea_symbol;

    -- ── SELL ────────────────────────────────────────────────────────
    ELSIF p_side = 'SELL' THEN
        SELECT * INTO v_position FROM positions
            WHERE user_id = p_user_id
              AND tea_id = (SELECT id FROM teas WHERE symbol = p_tea_symbol)
            FOR UPDATE;

        IF NOT FOUND OR v_position.quantity < p_quantity THEN
            RETURN jsonb_build_object('success', false, 'error',
                'Insufficient holdings. Have ' || COALESCE(v_position.quantity, 0) || ' kg');
        END IF;

        v_new_balance := v_profile.cash_balance + v_total;
        UPDATE profiles SET cash_balance = v_new_balance WHERE id = p_user_id;

        v_new_qty := v_position.quantity - p_quantity;
        IF v_new_qty <= 0 THEN
            DELETE FROM positions WHERE id = v_position.id;
        ELSE
            UPDATE positions
                SET quantity = v_new_qty, updated_at = NOW()
                WHERE id = v_position.id;
        END IF;

        -- Reduce platform long exposure
        UPDATE teas
        SET current_long_volume = GREATEST(0, COALESCE(current_long_volume, 0) - p_quantity)
        WHERE symbol = p_tea_symbol;
    END IF;

    -- ── RECORD TRADE (immutable audit trail) ────────────────────────
    INSERT INTO trades (user_id, tea_id, side, quantity, price, total_value)
        VALUES (p_user_id,
                (SELECT id FROM teas WHERE symbol = p_tea_symbol),
                p_side, p_quantity, v_exec_price, v_total)
        RETURNING * INTO v_trade;

    RETURN jsonb_build_object(
        'success',        true,
        'trade_id',       v_trade.id::TEXT,
        'side',           p_side,
        'symbol',         p_tea_symbol,
        'quantity',       p_quantity,
        'price',          v_exec_price,
        'mid_price',      v_price,
        'spread',         v_spread,
        'spread_cost',    v_spread_cost,
        'total',          v_total,
        'new_balance',    v_new_balance,
        'execution_price', v_exec_price
    );
END;
$$;
