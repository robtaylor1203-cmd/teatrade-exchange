-- ============================================
-- MIN TRADING DAYS FIX: 4 → 5
-- Paste this entire block into Supabase SQL Editor and click Run
-- ============================================

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
