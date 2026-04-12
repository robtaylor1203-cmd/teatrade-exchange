-- ============================================
-- MIN TRADING DAYS FIX: 4 → 5
-- Paste this entire block into Supabase SQL Editor and click Run
-- ============================================

-- FUNCTION 1: check_evaluation_pass
CREATE OR REPLACE FUNCTION check_evaluation_pass(p_funded_account_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_account     RECORD;
    v_equity      NUMERIC;
    v_profit      NUMERIC;
    v_consistency NUMERIC;
BEGIN
    SELECT * INTO v_account FROM funded_accounts
        WHERE id = p_funded_account_id AND account_status = 'evaluation'
        FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('passed', false, 'reason', 'Account not in evaluation');
    END IF;

    v_equity := calculate_floating_equity(v_account.user_id);
    v_profit := v_equity - v_account.initial_balance;

    IF v_profit <= 0 THEN
        RETURN jsonb_build_object('passed', false, 'reason', 'Not profitable',
            'equity', v_equity, 'target', v_account.initial_balance * 1.08);
    END IF;

    IF v_equity < v_account.initial_balance * 1.08 THEN
        RETURN jsonb_build_object('passed', false, 'reason', 'Profit target not met',
            'equity', v_equity, 'target', v_account.initial_balance * 1.08,
            'current_pct', ROUND((v_profit / v_account.initial_balance) * 100, 2));
    END IF;

    IF v_account.active_trading_days < 5 THEN
        RETURN jsonb_build_object('passed', false, 'reason', 'Minimum trading days not met',
            'active_days', v_account.active_trading_days, 'required', 5);
    END IF;

    IF v_profit > 0 AND v_account.best_trading_day_profit > 0 THEN
        v_consistency := (v_account.best_trading_day_profit / v_profit) * 100;
        IF v_consistency > 50 THEN
            RETURN jsonb_build_object('passed', false, 'reason', 'Consistency rule failed',
                'best_day_profit', v_account.best_trading_day_profit,
                'total_profit', v_profit,
                'consistency_pct', ROUND(v_consistency, 2),
                'max_allowed_pct', 50);
        END IF;
    END IF;

    UPDATE funded_accounts SET
        account_status = 'funded',
        passed_evaluation_at = NOW(),
        updated_at = NOW()
    WHERE id = p_funded_account_id;

    UPDATE profiles SET account_status = 'FUNDED' WHERE id = v_account.user_id;

    INSERT INTO account_audit_logs (user_id, funded_account_id, event_type, details)
    VALUES (v_account.user_id, p_funded_account_id, 'evaluation_passed',
        jsonb_build_object(
            'equity', v_equity,
            'profit', v_profit,
            'profit_pct', ROUND((v_profit / v_account.initial_balance) * 100, 2),
            'active_days', v_account.active_trading_days,
            'best_day_profit', v_account.best_trading_day_profit
        ));

    RETURN jsonb_build_object('passed', true, 'equity', v_equity, 'profit', v_profit);
END;
$$;

-- FUNCTION 2: request_reward_payout (only the min days check changed)
-- Find the line: IF v_account.active_trading_days < 4 THEN
-- It should now be: IF v_account.active_trading_days < 5 THEN
-- Since we need to replace the whole function, here it is:

CREATE OR REPLACE FUNCTION request_reward_payout(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_account       RECORD;
    v_equity        NUMERIC;
    v_profit        NUMERIC;
    v_payout        NUMERIC;
    v_house_share   NUMERIC;
    v_open_count    INT;
    v_pending_count INT;
    v_cycle_start   TIMESTAMPTZ;
    v_consistency   NUMERIC;
    v_best_day      NUMERIC;
BEGIN
    SELECT * INTO v_account FROM funded_accounts
        WHERE user_id = p_user_id AND account_status = 'funded'
        ORDER BY created_at DESC LIMIT 1
        FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No active funded account found. You must pass the evaluation first.';
    END IF;

    v_cycle_start := COALESCE(v_account.last_payout_date, v_account.first_trade_date, v_account.created_at);
    IF NOW() < v_cycle_start + INTERVAL '14 days' THEN
        RAISE EXCEPTION 'Payout not available yet. Next payout eligible on %. (14-day cycle)',
            TO_CHAR(v_cycle_start + INTERVAL '14 days', 'DD Mon YYYY HH24:MI');
    END IF;

    SELECT COUNT(*) INTO v_open_count
        FROM positions
        WHERE user_id = p_user_id AND trading_mode = 'VIRTUAL' AND quantity != 0;

    SELECT COUNT(*) INTO v_open_count
        FROM (
            SELECT 1 FROM positions WHERE user_id = p_user_id AND trading_mode = 'VIRTUAL' AND quantity != 0
            UNION ALL
            SELECT 1 FROM index_positions WHERE user_id = p_user_id AND trading_mode = 'VIRTUAL' AND quantity != 0
        ) open_pos;

    IF v_open_count > 0 THEN
        RAISE EXCEPTION 'Account must be flat. Close all positions before requesting a performance reward. Open positions: %', v_open_count;
    END IF;

    SELECT COUNT(*) INTO v_pending_count
        FROM pending_orders WHERE user_id = p_user_id AND status = 'PENDING';
    IF v_pending_count > 0 THEN
        RAISE EXCEPTION 'Cancel all pending orders before requesting a performance reward. Pending orders: %', v_pending_count;
    END IF;

    v_equity := (SELECT virtual_balance FROM profiles WHERE id = p_user_id);
    v_profit := v_equity - v_account.initial_balance;

    IF v_profit <= 0 THEN
        RAISE EXCEPTION 'Account is not profitable. Current balance: $%, Initial: $%. No reward to claim.',
            ROUND(v_equity, 2), ROUND(v_account.initial_balance, 2);
    END IF;

    IF v_account.active_trading_days < 5 THEN
        RAISE EXCEPTION 'Minimum 5 active trading days required. Current: % days.', v_account.active_trading_days;
    END IF;

    v_best_day := v_account.best_trading_day_profit;
    IF v_profit > 0 AND v_best_day > 0 THEN
        v_consistency := (v_best_day / v_profit) * 100;
        IF v_consistency > 50 THEN
            RAISE EXCEPTION 'Consistency rule: Your best trading day ($%) accounts for % of total profit. Maximum allowed is 50%%.',
                ROUND(v_best_day, 2), ROUND(v_consistency, 1) || '%';
        END IF;
    ELSE
        v_consistency := 0;
    END IF;

    v_payout     := ROUND(v_profit * 0.80, 2);
    v_house_share := ROUND(v_profit * 0.20, 2);

    UPDATE profiles
    SET virtual_balance = v_account.initial_balance,
        cash_balance    = v_account.initial_balance
    WHERE id = p_user_id;

    UPDATE funded_accounts
    SET current_balance         = v_account.initial_balance,
        total_payouts           = COALESCE(total_payouts, 0) + v_payout,
        last_payout_date        = NOW(),
        active_trading_days     = 0,
        best_trading_day_profit = 0,
        updated_at              = NOW()
    WHERE id = v_account.id;

    INSERT INTO account_audit_logs (user_id, funded_account_id, event_type, details)
    VALUES (p_user_id, v_account.id, 'payout_processed',
        jsonb_build_object(
            'equity_before', v_equity,
            'profit', v_profit,
            'payout_amount', v_payout,
            'house_share', v_house_share,
            'split', '80/20',
            'balance_reset_to', v_account.initial_balance,
            'active_days', v_account.active_trading_days,
            'consistency_pct', ROUND(v_consistency, 2),
            'next_payout_eligible', NOW() + INTERVAL '14 days'
        ));

    RETURN jsonb_build_object(
        'success', true,
        'gross_profit', v_profit,
        'payout_amount', v_payout,
        'house_share', v_house_share,
        'new_balance', v_account.initial_balance,
        'next_payout_eligible', NOW() + INTERVAL '14 days'
    );
END;
$$;
