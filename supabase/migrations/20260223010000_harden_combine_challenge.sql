-- Harden TeaTrade Combine: 50% profit target, reliable daily reset,
-- cash_balance sync on failure/expiry, and last_equity_reset_date tracking.

-- 1. Add tracking column for reliable daily equity resets
ALTER TABLE combine_challenges
    ADD COLUMN IF NOT EXISTS last_equity_reset_date DATE;

-- Backfill any active challenges
UPDATE combine_challenges
SET last_equity_reset_date = CURRENT_DATE
WHERE status = 'ACTIVE' AND last_equity_reset_date IS NULL;

-- 2. Update default profit target from 8% to 50%
ALTER TABLE combine_challenges
    ALTER COLUMN target_profit_pct SET DEFAULT 50.0;

-- 3. Recreate check_combine_rules() with all hardening fixes
CREATE OR REPLACE FUNCTION check_combine_rules(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_challenge    RECORD;
    v_bal          NUMERIC;
    v_unrealized   NUMERIC;
    v_equity       NUMERIC;
    v_spread       NUMERIC := 0.01;
    v_pos          RECORD;
    v_idx_price    NUMERIC;
    v_target       NUMERIC;
    v_dd_floor     NUMERIC;
    v_today        DATE := CURRENT_DATE;
BEGIN
    SELECT * INTO v_challenge FROM combine_challenges
        WHERE user_id = p_user_id AND status = 'ACTIVE'
        ORDER BY started_at DESC LIMIT 1;

    IF v_challenge IS NULL THEN
        RETURN jsonb_build_object('active', false);
    END IF;

    -- Check expiry first
    IF NOW() > v_challenge.expires_at THEN
        UPDATE combine_challenges SET status = 'EXPIRED', completed_at = NOW() WHERE id = v_challenge.id;
        UPDATE profiles
        SET account_status = 'ACTIVE',
            virtual_balance = 10000,
            cash_balance = 10000
        WHERE id = p_user_id;
        DELETE FROM positions WHERE user_id = p_user_id AND trading_mode = 'VIRTUAL';
        DELETE FROM index_positions WHERE user_id = p_user_id AND trading_mode = 'VIRTUAL';
        RETURN jsonb_build_object('active', false, 'result', 'EXPIRED');
    END IF;

    -- Calculate live equity (cash + unrealised P/L at exit prices)
    SELECT virtual_balance INTO v_bal FROM profiles WHERE id = p_user_id;

    SELECT COALESCE(SUM(
        CASE WHEN p.quantity > 0
            THEN (t.current_price * (1 - v_spread/2) - p.avg_entry_price) * p.quantity
            ELSE (p.avg_entry_price - t.current_price * (1 + v_spread/2)) * ABS(p.quantity)
        END
    ), 0) INTO v_unrealized
    FROM positions p JOIN teas t ON t.id = p.tea_id
    WHERE p.user_id = p_user_id AND p.trading_mode = 'VIRTUAL' AND p.quantity != 0;

    FOR v_pos IN
        SELECT ip.*, i.teas AS idx_teas, i.multiplier
        FROM index_positions ip JOIN indexes i ON i.symbol = ip.index_symbol
        WHERE ip.user_id = p_user_id AND ip.trading_mode = 'VIRTUAL' AND ip.quantity != 0
    LOOP
        SELECT AVG(t.current_price) * COALESCE(v_pos.multiplier, 1)
            INTO v_idx_price FROM teas t
            WHERE t.symbol = ANY(v_pos.idx_teas) AND t.current_price > 0;
        IF v_idx_price IS NOT NULL THEN
            IF v_pos.quantity > 0 THEN
                v_unrealized := v_unrealized + (v_idx_price * (1 - v_spread/2) - v_pos.avg_entry_price) * v_pos.quantity;
            ELSE
                v_unrealized := v_unrealized + (v_pos.avg_entry_price - v_idx_price * (1 + v_spread/2)) * ABS(v_pos.quantity);
            END IF;
        END IF;
    END LOOP;

    v_equity := v_bal + v_unrealized;

    -- Daily equity reset: use date tracking instead of narrow time window.
    -- On each new UTC day, snapshot equity as the drawdown baseline.
    IF v_challenge.last_equity_reset_date IS NULL OR v_challenge.last_equity_reset_date < v_today THEN
        UPDATE combine_challenges
        SET daily_start_equity = v_equity,
            last_equity_reset_date = v_today
        WHERE id = v_challenge.id;
        v_challenge.daily_start_equity := v_equity;
    END IF;

    -- Update peak
    IF v_equity > v_challenge.peak_equity THEN
        UPDATE combine_challenges SET peak_equity = v_equity WHERE id = v_challenge.id;
    END IF;

    v_target   := v_challenge.start_balance * (1 + v_challenge.target_profit_pct / 100);
    v_dd_floor := v_challenge.daily_start_equity * (1 - v_challenge.max_daily_drawdown_pct / 100);

    -- Check daily drawdown breach
    IF v_equity < v_dd_floor THEN
        UPDATE combine_challenges SET status = 'FAILED', completed_at = NOW() WHERE id = v_challenge.id;
        UPDATE profiles
        SET account_status = 'ACTIVE',
            virtual_balance = 10000,
            cash_balance = 10000
        WHERE id = p_user_id;
        DELETE FROM positions WHERE user_id = p_user_id AND trading_mode = 'VIRTUAL';
        DELETE FROM index_positions WHERE user_id = p_user_id AND trading_mode = 'VIRTUAL';
        RETURN jsonb_build_object('active', false, 'result', 'FAILED', 'reason', 'daily_drawdown');
    END IF;

    -- Check victory (50% profit target on new challenges)
    IF v_equity >= v_target THEN
        UPDATE combine_challenges SET status = 'PASSED', completed_at = NOW() WHERE id = v_challenge.id;
        UPDATE profiles SET account_status = 'ACTIVE', combine_badge = TRUE WHERE id = p_user_id;
        RETURN jsonb_build_object('active', false, 'result', 'PASSED', 'equity', v_equity);
    END IF;

    RETURN jsonb_build_object(
        'active',             true,
        'equity',             v_equity,
        'target',             v_target,
        'daily_start_equity', v_challenge.daily_start_equity,
        'dd_floor',           v_dd_floor,
        'days_remaining',     EXTRACT(DAY FROM v_challenge.expires_at - NOW()),
        'peak_equity',        GREATEST(v_challenge.peak_equity, v_equity)
    );
END;
$$;
