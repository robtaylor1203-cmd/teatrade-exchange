-- ═══════════════════════════════════════════════════════════════════════════════
-- FCA Margin Close-Out (MCO) rule + Server-Side Stop Loss / Take Profit
--
-- 1. Updates check_stop_outs(): liquidate at 50% of used margin (not $1)
-- 2. Adds stop_loss / take_profit columns to positions & index_positions
-- 3. Creates process_sl_tp() to auto-close trades when SL/TP is hit
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Schema: add SL/TP columns ────────────────────────────────────────────────

ALTER TABLE positions
    ADD COLUMN IF NOT EXISTS stop_loss    NUMERIC DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS take_profit  NUMERIC DEFAULT NULL;

ALTER TABLE index_positions
    ADD COLUMN IF NOT EXISTS stop_loss    NUMERIC DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS take_profit  NUMERIC DEFAULT NULL;

-- ══════════════════════════════════════════════════════════════════════════════
-- TASK 1: Updated check_stop_outs() — FCA MCO at 50% of used margin
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION check_stop_outs()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user            RECORD;
    v_default_bal     NUMERIC;
    v_stop_floor      NUMERIC;
    v_call_floor      NUMERIC;
    v_bal             NUMERIC;
    v_used_margin     NUMERIC;
    v_unrealized_tea  NUMERIC;
    v_unrealized_idx  NUMERIC;
    v_total_pnl       NUMERIC;
    v_equity          NUMERIC;
    v_equity_pct      NUMERIC;
    v_pos             RECORD;
    v_close_pnl       NUMERIC;
    v_spread          NUMERIC;
    v_liquidated      INT := 0;
    v_margin_calls    INT := 0;
    v_already_warned  BOOLEAN;
    v_idx_price       NUMERIC;
BEGIN
    v_default_bal := 10000;

    SELECT value INTO v_spread FROM platform_config WHERE key = 'spread_pct';
    v_spread := COALESCE(v_spread, 0.01);

    FOR v_user IN
        SELECT DISTINCT user_id, trading_mode FROM (
            SELECT user_id, trading_mode FROM positions WHERE quantity != 0
            UNION
            SELECT user_id, trading_mode FROM index_positions WHERE quantity != 0
        ) AS active_users
    LOOP
        SELECT CASE WHEN v_user.trading_mode = 'REAL' THEN real_balance ELSE virtual_balance END
            INTO v_bal FROM profiles WHERE id = v_user.user_id;

        SELECT COALESCE(SUM(margin_used), 0) INTO v_used_margin
            FROM (
                SELECT margin_used FROM positions
                    WHERE user_id = v_user.user_id AND trading_mode = v_user.trading_mode AND quantity != 0
                UNION ALL
                SELECT margin_used FROM index_positions
                    WHERE user_id = v_user.user_id AND trading_mode = v_user.trading_mode AND quantity != 0
            ) AS margins;

        IF v_used_margin <= 0 THEN CONTINUE; END IF;

        -- FCA MCO: liquidate at 50% of used margin; warn at 80%
        v_stop_floor := v_used_margin * 0.5;
        v_call_floor := v_used_margin * 0.8;

        SELECT COALESCE(SUM(
            CASE WHEN p.quantity > 0
                THEN (t.current_price * (1 - v_spread/2) - p.avg_entry_price) * p.quantity
                ELSE (p.avg_entry_price - t.current_price * (1 + v_spread/2)) * ABS(p.quantity)
            END
        ), 0) INTO v_unrealized_tea
        FROM positions p JOIN teas t ON t.id = p.tea_id
        WHERE p.user_id = v_user.user_id AND p.trading_mode = v_user.trading_mode AND p.quantity != 0;

        v_unrealized_idx := 0;
        FOR v_pos IN
            SELECT ip.*, i.teas AS idx_teas, i.multiplier
            FROM index_positions ip
            JOIN indexes i ON i.symbol = ip.index_symbol
            WHERE ip.user_id = v_user.user_id AND ip.trading_mode = v_user.trading_mode AND ip.quantity != 0
        LOOP
            SELECT AVG(t.current_price) * COALESCE(v_pos.multiplier, 1)
                INTO v_idx_price
            FROM teas t
            WHERE t.symbol = ANY(v_pos.idx_teas)
              AND t.current_price > 0;

            IF v_idx_price IS NOT NULL THEN
                IF v_pos.quantity > 0 THEN
                    v_unrealized_idx := v_unrealized_idx +
                        (v_idx_price * (1 - v_spread/2) - v_pos.avg_entry_price) * v_pos.quantity;
                ELSE
                    v_unrealized_idx := v_unrealized_idx +
                        (v_pos.avg_entry_price - v_idx_price * (1 + v_spread/2)) * ABS(v_pos.quantity);
                END IF;
            END IF;
        END LOOP;

        v_total_pnl := v_unrealized_tea + v_unrealized_idx;
        v_equity    := v_bal + v_total_pnl;
        v_equity_pct := CASE WHEN v_used_margin > 0 THEN (v_equity / v_used_margin) * 100 ELSE 100 END;

        IF v_equity <= v_stop_floor THEN
            FOR v_pos IN
                SELECT p.*, t.current_price, t.symbol AS tea_symbol
                FROM positions p JOIN teas t ON t.id = p.tea_id
                WHERE p.user_id = v_user.user_id AND p.trading_mode = v_user.trading_mode AND p.quantity != 0
            LOOP
                IF v_pos.quantity > 0 THEN
                    v_close_pnl := (v_pos.current_price * (1 - v_spread/2) - v_pos.avg_entry_price) * v_pos.quantity;
                ELSE
                    v_close_pnl := (v_pos.avg_entry_price - v_pos.current_price * (1 + v_spread/2)) * ABS(v_pos.quantity);
                END IF;

                v_bal := v_bal + v_pos.margin_used + v_close_pnl;

                INSERT INTO trades (user_id, tea_id, side, quantity, price, total_value, trading_mode)
                    VALUES (v_pos.user_id, v_pos.tea_id,
                            CASE WHEN v_pos.quantity > 0 THEN 'SELL' ELSE 'BUY' END,
                            ABS(v_pos.quantity), v_pos.current_price,
                            ABS(v_pos.quantity) * v_pos.current_price, v_user.trading_mode);

                INSERT INTO platform_revenue (revenue_type, user_id, amount, symbol)
                    VALUES ('stop_out', v_pos.user_id, GREATEST(-v_close_pnl, 0), v_pos.tea_symbol);

                DELETE FROM positions WHERE id = v_pos.id;
            END LOOP;

            FOR v_pos IN
                SELECT ip.*, i.teas AS idx_teas, i.multiplier
                FROM index_positions ip
                JOIN indexes i ON i.symbol = ip.index_symbol
                WHERE ip.user_id = v_user.user_id AND ip.trading_mode = v_user.trading_mode AND ip.quantity != 0
            LOOP
                SELECT AVG(t.current_price) * COALESCE(v_pos.multiplier, 1)
                    INTO v_idx_price
                FROM teas t
                WHERE t.symbol = ANY(v_pos.idx_teas)
                  AND t.current_price > 0;

                v_idx_price := COALESCE(v_idx_price, v_pos.avg_entry_price);

                IF v_pos.quantity > 0 THEN
                    v_close_pnl := (v_idx_price * (1 - v_spread/2) - v_pos.avg_entry_price) * v_pos.quantity;
                ELSE
                    v_close_pnl := (v_pos.avg_entry_price - v_idx_price * (1 + v_spread/2)) * ABS(v_pos.quantity);
                END IF;

                v_bal := v_bal + v_pos.margin_used + v_close_pnl;

                INSERT INTO trades (user_id, tea_id, index_symbol, side, quantity, price, total_value, trading_mode)
                    VALUES (v_pos.user_id, NULL, v_pos.index_symbol,
                            CASE WHEN v_pos.quantity > 0 THEN 'SELL' ELSE 'BUY' END,
                            ABS(v_pos.quantity), v_idx_price,
                            ABS(v_pos.quantity) * v_idx_price, v_user.trading_mode);

                INSERT INTO platform_revenue (revenue_type, user_id, amount, symbol)
                    VALUES ('stop_out', v_pos.user_id, GREATEST(-v_close_pnl, 0), v_pos.index_symbol);

                DELETE FROM index_positions WHERE id = v_pos.id;
            END LOOP;

            v_bal := GREATEST(v_bal, 0);

            IF v_user.trading_mode = 'REAL' THEN
                UPDATE profiles SET real_balance = v_bal WHERE id = v_user.user_id;
            ELSE
                UPDATE profiles SET virtual_balance = v_bal, cash_balance = v_bal WHERE id = v_user.user_id;
            END IF;

            IF v_bal < 1 THEN
                UPDATE profiles
                SET account_status = 'LOCKED',
                    next_free_reset_at = date_trunc('month', NOW() + INTERVAL '1 month')
                WHERE id = v_user.user_id AND account_status != 'COMBINE';
            END IF;

            INSERT INTO margin_notifications (user_id, type, trading_mode, equity, used_margin, margin_level, message)
                VALUES (v_user.user_id, 'STOP_OUT', v_user.trading_mode,
                        v_equity, v_used_margin, v_equity_pct,
                        'All positions liquidated — equity fell below 50% of margin ($'
                        || ROUND(v_stop_floor, 2) || '). Account equity: $' || ROUND(v_equity, 2));

            v_liquidated := v_liquidated + 1;

        ELSIF v_equity <= v_call_floor THEN
            SELECT EXISTS (
                SELECT 1 FROM margin_notifications
                WHERE user_id = v_user.user_id
                  AND trading_mode = v_user.trading_mode
                  AND type = 'MARGIN_CALL'
                  AND created_at > NOW() - INTERVAL '1 hour'
            ) INTO v_already_warned;

            IF NOT v_already_warned THEN
                INSERT INTO margin_notifications (user_id, type, trading_mode, equity, used_margin, margin_level, message)
                    VALUES (v_user.user_id, 'MARGIN_CALL', v_user.trading_mode,
                            v_equity, v_used_margin, v_equity_pct,
                            'Margin warning — equity at $' || ROUND(v_equity, 2)
                            || ' (' || ROUND(v_equity_pct, 1) || '% of margin). Close positions to avoid liquidation.');

                v_margin_calls := v_margin_calls + 1;
            END IF;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'users_liquidated', v_liquidated,
        'margin_calls_sent', v_margin_calls
    );
END;
$$;

-- ══════════════════════════════════════════════════════════════════════════════
-- TASK 2: Server-side Stop Loss / Take Profit processor
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION process_sl_tp()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_pos         RECORD;
    v_market_price NUMERIC;
    v_close_pnl   NUMERIC;
    v_bal         NUMERIC;
    v_spread      NUMERIC;
    v_exit_price  NUMERIC;
    v_closed      INT := 0;
    v_idx_price   NUMERIC;
BEGIN
    SELECT value INTO v_spread FROM platform_config WHERE key = 'spread_pct';
    v_spread := COALESCE(v_spread, 0.01);

    -- ── Tea positions with SL or TP set ──────────────────────────────────────
    FOR v_pos IN
        SELECT p.*, t.current_price, t.symbol AS tea_symbol
        FROM positions p
        JOIN teas t ON t.id = p.tea_id
        WHERE p.quantity != 0
          AND (p.stop_loss IS NOT NULL OR p.take_profit IS NOT NULL)
    LOOP
        v_market_price := v_pos.current_price;
        v_exit_price := NULL;

        IF v_pos.quantity > 0 THEN
            -- LONG: SL triggers when price drops to or below SL
            IF v_pos.stop_loss IS NOT NULL AND v_market_price <= v_pos.stop_loss THEN
                v_exit_price := v_pos.stop_loss;
            END IF;
            -- LONG: TP triggers when price rises to or above TP
            IF v_pos.take_profit IS NOT NULL AND v_market_price >= v_pos.take_profit THEN
                v_exit_price := v_pos.take_profit;
            END IF;
        ELSE
            -- SHORT: SL triggers when price rises to or above SL
            IF v_pos.stop_loss IS NOT NULL AND v_market_price >= v_pos.stop_loss THEN
                v_exit_price := v_pos.stop_loss;
            END IF;
            -- SHORT: TP triggers when price drops to or below TP
            IF v_pos.take_profit IS NOT NULL AND v_market_price <= v_pos.take_profit THEN
                v_exit_price := v_pos.take_profit;
            END IF;
        END IF;

        IF v_exit_price IS NOT NULL THEN
            IF v_pos.quantity > 0 THEN
                v_close_pnl := (v_exit_price * (1 - v_spread/2) - v_pos.avg_entry_price) * v_pos.quantity;
            ELSE
                v_close_pnl := (v_pos.avg_entry_price - v_exit_price * (1 + v_spread/2)) * ABS(v_pos.quantity);
            END IF;

            SELECT CASE WHEN v_pos.trading_mode = 'REAL' THEN real_balance ELSE virtual_balance END
                INTO v_bal FROM profiles WHERE id = v_pos.user_id;

            v_bal := GREATEST(v_bal + v_pos.margin_used + v_close_pnl, 0);

            INSERT INTO trades (user_id, tea_id, side, quantity, price, total_value, trading_mode)
                VALUES (v_pos.user_id, v_pos.tea_id,
                        CASE WHEN v_pos.quantity > 0 THEN 'SELL' ELSE 'BUY' END,
                        ABS(v_pos.quantity), v_exit_price,
                        ABS(v_pos.quantity) * v_exit_price, v_pos.trading_mode);

            IF v_pos.trading_mode = 'REAL' THEN
                UPDATE profiles SET real_balance = v_bal WHERE id = v_pos.user_id;
            ELSE
                UPDATE profiles SET virtual_balance = v_bal, cash_balance = v_bal WHERE id = v_pos.user_id;
            END IF;

            INSERT INTO platform_revenue (revenue_type, user_id, amount, symbol)
                VALUES (CASE WHEN v_close_pnl < 0 THEN 'sl_close' ELSE 'tp_close' END,
                        v_pos.user_id, GREATEST(-v_close_pnl, 0), v_pos.tea_symbol);

            DELETE FROM positions WHERE id = v_pos.id;
            v_closed := v_closed + 1;
        END IF;
    END LOOP;

    -- ── Index positions with SL or TP set ────────────────────────────────────
    FOR v_pos IN
        SELECT ip.*, i.teas AS idx_teas, i.multiplier
        FROM index_positions ip
        JOIN indexes i ON i.symbol = ip.index_symbol
        WHERE ip.quantity != 0
          AND (ip.stop_loss IS NOT NULL OR ip.take_profit IS NOT NULL)
    LOOP
        SELECT AVG(t.current_price) * COALESCE(v_pos.multiplier, 1)
            INTO v_idx_price
        FROM teas t
        WHERE t.symbol = ANY(v_pos.idx_teas)
          AND t.current_price > 0;

        IF v_idx_price IS NULL THEN CONTINUE; END IF;

        v_exit_price := NULL;

        IF v_pos.quantity > 0 THEN
            IF v_pos.stop_loss IS NOT NULL AND v_idx_price <= v_pos.stop_loss THEN
                v_exit_price := v_pos.stop_loss;
            END IF;
            IF v_pos.take_profit IS NOT NULL AND v_idx_price >= v_pos.take_profit THEN
                v_exit_price := v_pos.take_profit;
            END IF;
        ELSE
            IF v_pos.stop_loss IS NOT NULL AND v_idx_price >= v_pos.stop_loss THEN
                v_exit_price := v_pos.stop_loss;
            END IF;
            IF v_pos.take_profit IS NOT NULL AND v_idx_price <= v_pos.take_profit THEN
                v_exit_price := v_pos.take_profit;
            END IF;
        END IF;

        IF v_exit_price IS NOT NULL THEN
            IF v_pos.quantity > 0 THEN
                v_close_pnl := (v_exit_price * (1 - v_spread/2) - v_pos.avg_entry_price) * v_pos.quantity;
            ELSE
                v_close_pnl := (v_pos.avg_entry_price - v_exit_price * (1 + v_spread/2)) * ABS(v_pos.quantity);
            END IF;

            SELECT CASE WHEN v_pos.trading_mode = 'REAL' THEN real_balance ELSE virtual_balance END
                INTO v_bal FROM profiles WHERE id = v_pos.user_id;

            v_bal := GREATEST(v_bal + v_pos.margin_used + v_close_pnl, 0);

            INSERT INTO trades (user_id, tea_id, index_symbol, side, quantity, price, total_value, trading_mode)
                VALUES (v_pos.user_id, NULL, v_pos.index_symbol,
                        CASE WHEN v_pos.quantity > 0 THEN 'SELL' ELSE 'BUY' END,
                        ABS(v_pos.quantity), v_exit_price,
                        ABS(v_pos.quantity) * v_exit_price, v_pos.trading_mode);

            IF v_pos.trading_mode = 'REAL' THEN
                UPDATE profiles SET real_balance = v_bal WHERE id = v_pos.user_id;
            ELSE
                UPDATE profiles SET virtual_balance = v_bal, cash_balance = v_bal WHERE id = v_pos.user_id;
            END IF;

            INSERT INTO platform_revenue (revenue_type, user_id, amount, symbol)
                VALUES (CASE WHEN v_close_pnl < 0 THEN 'sl_close' ELSE 'tp_close' END,
                        v_pos.user_id, GREATEST(-v_close_pnl, 0), v_pos.index_symbol);

            DELETE FROM index_positions WHERE id = v_pos.id;
            v_closed := v_closed + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'closed', v_closed);
END;
$$;
