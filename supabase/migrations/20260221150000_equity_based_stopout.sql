-- ═══════════════════════════════════════════════════════════════════════════════
-- EQUITY-BASED STOP-OUT (2% buffer, 15% margin call)
--
-- Replaces the old position-health-based liquidation with an equity/margin
-- ratio check, matching Trading212-style deep-stop behaviour.
--
-- Liquidation:  equity / total_used_margin <= 2%
-- Margin call:  equity / total_used_margin <= 15%
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION check_stop_outs()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user            RECORD;
    v_stop_level      NUMERIC;
    v_call_level      NUMERIC;
    v_bal             NUMERIC;
    v_used_margin     NUMERIC;
    v_unrealized_tea  NUMERIC;
    v_unrealized_idx  NUMERIC;
    v_total_pnl       NUMERIC;
    v_equity          NUMERIC;
    v_margin_level    NUMERIC;
    v_pos             RECORD;
    v_close_pnl       NUMERIC;
    v_spread          NUMERIC;
    v_liquidated      INT := 0;
    v_margin_calls    INT := 0;
    v_already_warned  BOOLEAN;
    v_idx_price       NUMERIC;
BEGIN
    SELECT value INTO v_stop_level FROM platform_config WHERE key = 'stop_out_level';
    v_stop_level := COALESCE(v_stop_level, 0.02);

    SELECT value INTO v_call_level FROM platform_config WHERE key = 'margin_call_level';
    v_call_level := COALESCE(v_call_level, 0.15);

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

        -- Unrealized P&L: tea positions
        SELECT COALESCE(SUM(
            CASE WHEN p.quantity > 0
                THEN (t.current_price * (1 - v_spread/2) - p.avg_entry_price) * p.quantity
                ELSE (p.avg_entry_price - t.current_price * (1 + v_spread/2)) * ABS(p.quantity)
            END
        ), 0) INTO v_unrealized_tea
        FROM positions p JOIN teas t ON t.id = p.tea_id
        WHERE p.user_id = v_user.user_id AND p.trading_mode = v_user.trading_mode AND p.quantity != 0;

        -- Unrealized P&L: index positions
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

        -- Equity / Used Margin ratio — the core liquidation metric.
        -- At 100% the account is fully covered; at 2% the buffer triggers close-out.
        v_margin_level := v_equity / v_used_margin;

        IF v_equity <= 0 THEN
            v_margin_level := 0;
        END IF;

        -- ── STOP-OUT (equity/margin <= 2%) ─────────────────────────────
        IF v_margin_level <= v_stop_level THEN
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
                UPDATE profiles SET virtual_balance = v_bal WHERE id = v_user.user_id;
            END IF;

            INSERT INTO margin_notifications (user_id, type, trading_mode, equity, used_margin, margin_level, message)
                VALUES (v_user.user_id, 'STOP_OUT', v_user.trading_mode,
                        v_equity, v_used_margin, v_margin_level * 100,
                        'All positions liquidated — equity fell to '
                        || ROUND(v_margin_level * 100, 1) || '% of used margin (threshold: '
                        || ROUND(v_stop_level * 100) || '%).');

            v_liquidated := v_liquidated + 1;

        -- ── MARGIN CALL (equity/margin <= 15%) ─────────────────────────
        ELSIF v_margin_level <= v_call_level THEN
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
                            v_equity, v_used_margin, v_margin_level * 100,
                            'Equity at ' || ROUND(v_margin_level * 100, 1)
                            || '% of used margin. Close positions or deposit funds to avoid '
                            || 'liquidation at ' || ROUND(v_stop_level * 100) || '%.');

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
