-- ══════════════════════════════════════════════════════════════════════
-- execute_trade_secure: Atomic, race-condition-proof trade execution
-- with Fill-or-Kill slippage protection.
--
-- Key differences from execute_trade:
--   1. RAISE EXCEPTION on every failure → guarantees full rollback
--   2. Profile row locked FIRST (SELECT ... FOR UPDATE) to prevent
--      double-spending across concurrent requests
--   3. Slippage guard: rejects if market price moved beyond tolerance
--      since the client last saw it (Fill or Kill)
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION execute_trade_secure(
    p_user_id            UUID,
    p_tea_symbol         TEXT,
    p_side               TEXT,
    p_quantity           NUMERIC,
    p_mode               TEXT     DEFAULT 'VIRTUAL',
    p_leverage           NUMERIC  DEFAULT 1,
    p_expected_price     NUMERIC  DEFAULT NULL,
    p_slippage_tolerance NUMERIC  DEFAULT 0.05
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
    v_tea_id       INT;
BEGIN
    -- ── INPUT VALIDATION ──────────────────────────────────────────────
    IF p_mode NOT IN ('VIRTUAL', 'REAL') THEN
        RAISE EXCEPTION 'Invalid trading mode: %', p_mode;
    END IF;
    IF p_side NOT IN ('BUY', 'SELL') THEN
        RAISE EXCEPTION 'Invalid side: must be BUY or SELL';
    END IF;
    IF p_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be greater than zero';
    END IF;
    IF p_leverage < 1 OR p_leverage > 25 THEN
        RAISE EXCEPTION 'Leverage must be between 1 and 25';
    END IF;

    -- ── LOCK PROFILE ROW FIRST (prevents double-spending) ────────────
    SELECT * INTO v_profile FROM profiles WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User profile not found';
    END IF;
    v_bal := CASE WHEN p_mode = 'REAL' THEN v_profile.real_balance ELSE v_profile.virtual_balance END;

    -- ── LOCK TEA ROW (prevents stale price reads) ────────────────────
    SELECT * INTO v_tea FROM teas WHERE symbol = p_tea_symbol FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tea not found: %', p_tea_symbol;
    END IF;
    v_tea_id := v_tea.id;

    -- ── RISK CHECKS ──────────────────────────────────────────────────
    IF v_tea.trading_mode = 'HALTED' THEN
        IF v_tea.halt_until IS NOT NULL AND v_tea.halt_until <= NOW() THEN
            UPDATE teas SET trading_mode = 'FULL', halt_until = NULL WHERE id = v_tea.id;
            v_tea.trading_mode := 'FULL';
        ELSE
            RAISE EXCEPTION 'Market halted for % due to extreme volatility. Please wait.', p_tea_symbol;
        END IF;
    END IF;

    IF v_tea.trading_mode = 'CLOSE_ONLY' AND p_side = 'BUY' THEN
        RAISE EXCEPTION 'Maximum platform exposure reached for %. Only closing trades are allowed.', p_tea_symbol;
    END IF;

    IF p_side = 'BUY'
       AND (COALESCE(v_tea.current_long_volume, 0) + p_quantity) > COALESCE(v_tea.max_exposure, 500000) THEN
        RAISE EXCEPTION 'Maximum platform exposure reached for %. Only closing trades are allowed.', p_tea_symbol;
    END IF;

    -- ── MARKET PRICE ─────────────────────────────────────────────────
    v_price := v_tea.current_price;
    IF v_price IS NULL OR v_price <= 0 THEN
        RAISE EXCEPTION 'No valid market price for %', p_tea_symbol;
    END IF;

    -- ── FILL OR KILL: SLIPPAGE PROTECTION ────────────────────────────
    IF p_expected_price IS NOT NULL AND p_expected_price > 0 THEN
        IF ABS(v_price - p_expected_price) > p_slippage_tolerance THEN
            RAISE EXCEPTION 'Price moved beyond tolerance. Expected $% but market is $% (tolerance: $%). Execution rejected to protect client.',
                ROUND(p_expected_price, 4), ROUND(v_price, 4), ROUND(p_slippage_tolerance, 4);
        END IF;
    END IF;

    v_spread := COALESCE(v_tea.base_spread, 0.01) * COALESCE(v_tea.volatility_multiplier, 1.0);

    -- ── LOCK POSITION ROW ────────────────────────────────────────────
    SELECT * INTO v_position FROM positions
        WHERE user_id = p_user_id AND tea_id = v_tea_id AND trading_mode = p_mode
        FOR UPDATE;

    v_existing_qty := COALESCE(v_position.quantity, 0);

    -- ══════════════════════════════════════════════════════════════════
    -- BUY
    -- ══════════════════════════════════════════════════════════════════
    IF p_side = 'BUY' THEN
        IF v_existing_qty >= 0 THEN
            -- Opening or extending a LONG position
            v_exec_price := v_price * (1 + v_spread / 2);
            v_notional   := v_exec_price * p_quantity;
            v_margin_req := v_notional / p_leverage;
            v_spread_cost := (v_exec_price - v_price) * p_quantity;

            IF v_bal < v_margin_req THEN
                RAISE EXCEPTION 'Insufficient margin. Need $% but have $%',
                    ROUND(v_margin_req, 2), ROUND(v_bal, 2);
            END IF;
            v_new_balance := v_bal - v_margin_req;

            IF FOUND THEN
                v_new_qty    := v_existing_qty + p_quantity;
                v_new_avg    := ((v_position.avg_entry_price * v_existing_qty) + (v_exec_price * p_quantity)) / v_new_qty;
                v_new_margin := COALESCE(v_position.margin_used, 0) + v_margin_req;
                v_new_leverage := v_new_qty * v_new_avg / NULLIF(v_new_margin, 0);
                UPDATE positions SET quantity = v_new_qty, avg_entry_price = v_new_avg,
                    margin_used = v_new_margin, leverage = COALESCE(v_new_leverage, 1), updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                INSERT INTO positions (user_id, tea_id, quantity, avg_entry_price, leverage, margin_used, trading_mode)
                    VALUES (p_user_id, v_tea_id, p_quantity, v_exec_price, p_leverage, v_margin_req, p_mode);
            END IF;

            UPDATE teas SET current_long_volume = COALESCE(current_long_volume, 0) + p_quantity
                WHERE id = v_tea_id;

        ELSE
            -- Closing a SHORT position, possibly flipping to long
            v_exec_price := v_price * (1 + v_spread / 2);
            v_spread_cost := (v_exec_price - v_price) * p_quantity;
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
                RAISE EXCEPTION 'Insufficient balance to complete this trade';
            END IF;
            v_new_qty := v_existing_qty + p_quantity;
            IF v_new_qty = 0 THEN
                DELETE FROM positions WHERE id = v_position.id;
            ELSIF v_new_qty > 0 THEN
                UPDATE positions SET quantity = v_new_qty, avg_entry_price = v_exec_price,
                    leverage = p_leverage, margin_used = v_exec_price * v_new_qty / p_leverage, updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                UPDATE positions SET quantity = v_new_qty,
                    margin_used = COALESCE(v_position.margin_used, 0) - v_close_margin, updated_at = NOW()
                    WHERE id = v_position.id;
            END IF;

            UPDATE teas SET current_short_volume = GREATEST(0, COALESCE(current_short_volume, 0) - v_close_qty)
                WHERE id = v_tea_id;
        END IF;

    -- ══════════════════════════════════════════════════════════════════
    -- SELL
    -- ══════════════════════════════════════════════════════════════════
    ELSIF p_side = 'SELL' THEN
        IF v_existing_qty <= 0 THEN
            -- Opening or extending a SHORT position
            v_exec_price := v_price * (1 - v_spread / 2);
            v_notional   := v_exec_price * p_quantity;
            v_margin_req := v_notional / p_leverage;
            v_spread_cost := (v_price - v_exec_price) * p_quantity;

            IF v_bal < v_margin_req THEN
                RAISE EXCEPTION 'Insufficient margin. Need $% but have $%',
                    ROUND(v_margin_req, 2), ROUND(v_bal, 2);
            END IF;
            v_new_balance := v_bal - v_margin_req;

            IF FOUND THEN
                v_new_qty    := v_existing_qty - p_quantity;
                v_new_avg    := ((v_position.avg_entry_price * ABS(v_existing_qty)) + (v_exec_price * p_quantity)) / ABS(v_new_qty);
                v_new_margin := COALESCE(v_position.margin_used, 0) + v_margin_req;
                v_new_leverage := ABS(v_new_qty) * v_new_avg / NULLIF(v_new_margin, 0);
                UPDATE positions SET quantity = v_new_qty, avg_entry_price = v_new_avg,
                    margin_used = v_new_margin, leverage = COALESCE(v_new_leverage, 1), updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                INSERT INTO positions (user_id, tea_id, quantity, avg_entry_price, leverage, margin_used, trading_mode)
                    VALUES (p_user_id, v_tea_id, -p_quantity, v_exec_price, p_leverage, v_margin_req, p_mode);
            END IF;

            UPDATE teas SET current_short_volume = COALESCE(current_short_volume, 0) + p_quantity
                WHERE id = v_tea_id;

        ELSE
            -- Closing a LONG position, possibly flipping to short
            v_exec_price := v_price * (1 - v_spread / 2);
            v_spread_cost := (v_price - v_exec_price) * p_quantity;
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
                RAISE EXCEPTION 'Insufficient balance to complete this trade';
            END IF;
            v_new_qty := v_existing_qty - p_quantity;
            IF v_new_qty = 0 THEN
                DELETE FROM positions WHERE id = v_position.id;
            ELSIF v_new_qty > 0 THEN
                UPDATE positions SET quantity = v_new_qty,
                    margin_used = COALESCE(v_position.margin_used, 0) - v_close_margin, updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                UPDATE positions SET quantity = v_new_qty, avg_entry_price = v_exec_price,
                    leverage = p_leverage, margin_used = v_exec_price * ABS(v_new_qty) / p_leverage, updated_at = NOW()
                    WHERE id = v_position.id;
            END IF;

            UPDATE teas SET current_long_volume = GREATEST(0, COALESCE(current_long_volume, 0) - v_close_qty)
                WHERE id = v_tea_id;
        END IF;
    END IF;

    -- ── UPDATE BALANCE ───────────────────────────────────────────────
    IF p_mode = 'REAL' THEN
        UPDATE profiles SET real_balance = v_new_balance WHERE id = p_user_id;
    ELSE
        UPDATE profiles SET virtual_balance = v_new_balance, cash_balance = v_new_balance WHERE id = p_user_id;
    END IF;

    -- ── LOG TRADE ────────────────────────────────────────────────────
    INSERT INTO trades (user_id, tea_id, side, quantity, price, total_value, leverage, trading_mode)
        VALUES (p_user_id, v_tea_id, p_side, p_quantity, v_exec_price,
                v_exec_price * p_quantity, p_leverage, p_mode)
        RETURNING * INTO v_trade;

    -- ── LOG SPREAD REVENUE ───────────────────────────────────────────
    v_spread_cost := COALESCE(v_spread_cost, 0);
    IF v_spread_cost > 0 THEN
        INSERT INTO platform_revenue (revenue_type, trade_id, user_id, amount, symbol)
            VALUES ('spread', v_trade.id, p_user_id, v_spread_cost, p_tea_symbol);
    END IF;

    -- ── SUCCESS ──────────────────────────────────────────────────────
    RETURN jsonb_build_object(
        'success', true,
        'trade_id', v_trade.id::TEXT,
        'side', p_side,
        'symbol', p_tea_symbol,
        'quantity', p_quantity,
        'market_price', v_price,
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
