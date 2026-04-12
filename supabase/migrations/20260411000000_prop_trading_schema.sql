-- ═══════════════════════════════════════════════════════════════════════════════
-- PROP TRADING EVALUATION & FUNDED ACCOUNT SYSTEM
-- ═══════════════════════════════════════════════════════════════════════════════
-- Implements FTMO-style evaluation rules, payout mechanics, audit logging,
-- and anti-gambling protections. Replaces the old "Combine Challenge" system
-- with a rigorous paid evaluation → funded account → payout loop.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. FUNDED ACCOUNTS TABLE
-- ──────────────────────────────────────────────────────────────────────────────
-- Central tracking table for evaluation & funded account lifecycle.
-- One active row per user at a time (enforced by application logic).

CREATE TABLE IF NOT EXISTS funded_accounts (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    account_status          TEXT NOT NULL DEFAULT 'evaluation'
                            CHECK (account_status IN ('evaluation', 'funded', 'liquidated')),
    initial_balance         NUMERIC NOT NULL DEFAULT 10000 CHECK (initial_balance > 0),
    current_balance         NUMERIC NOT NULL DEFAULT 10000,
    highest_daily_equity    NUMERIC NOT NULL DEFAULT 10000,
    midnight_equity         NUMERIC NOT NULL DEFAULT 10000,
    active_trading_days     INT NOT NULL DEFAULT 0,
    best_trading_day_profit NUMERIC NOT NULL DEFAULT 0,
    total_profit            NUMERIC NOT NULL DEFAULT 0,
    first_trade_date        TIMESTAMPTZ,
    last_payout_date        TIMESTAMPTZ,
    last_equity_reset_date  DATE,
    last_trade_date         DATE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    liquidated_at           TIMESTAMPTZ,
    passed_evaluation_at    TIMESTAMPTZ,
    CONSTRAINT funded_balance_positive CHECK (initial_balance > 0)
);

CREATE INDEX IF NOT EXISTS idx_funded_accounts_user ON funded_accounts (user_id, account_status);
CREATE INDEX IF NOT EXISTS idx_funded_accounts_active ON funded_accounts (account_status)
    WHERE account_status IN ('evaluation', 'funded');

ALTER TABLE funded_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "funded_select" ON funded_accounts;
CREATE POLICY "funded_select" ON funded_accounts
    FOR SELECT TO authenticated USING (user_id = auth.uid());

-- Prevent client-side manipulation
REVOKE INSERT, UPDATE, DELETE ON funded_accounts FROM anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. PAYOUT REQUESTS TABLE
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payout_requests (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    funded_account_id UUID NOT NULL REFERENCES funded_accounts(id) ON DELETE CASCADE,
    gross_profit      NUMERIC NOT NULL,
    payout_amount     NUMERIC NOT NULL,
    house_share       NUMERIC NOT NULL,
    balance_before    NUMERIC NOT NULL,
    balance_after     NUMERIC NOT NULL,
    active_trading_days INT NOT NULL,
    best_day_profit   NUMERIC NOT NULL,
    consistency_pct   NUMERIC NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'paid', 'rejected')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at           TIMESTAMPTZ,
    notes             TEXT
);

CREATE INDEX IF NOT EXISTS idx_payout_requests_user ON payout_requests (user_id, status);

ALTER TABLE payout_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payout_select" ON payout_requests;
CREATE POLICY "payout_select" ON payout_requests
    FOR SELECT TO authenticated USING (user_id = auth.uid());

REVOKE INSERT, UPDATE, DELETE ON payout_requests FROM anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. ACCOUNT AUDIT LOGS TABLE
-- ──────────────────────────────────────────────────────────────────────────────
-- Immutable audit trail for all funded account events.

CREATE TABLE IF NOT EXISTS account_audit_logs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    funded_account_id UUID NOT NULL REFERENCES funded_accounts(id) ON DELETE CASCADE,
    event_type        TEXT NOT NULL CHECK (event_type IN (
        'account_created', 'evaluation_passed', 'daily_loss_breach',
        'total_loss_breach', 'manual_liquidation', 'payout_requested',
        'payout_approved', 'payout_paid', 'midnight_equity_reset',
        'trading_day_recorded', 'leverage_rejected', 'consistency_failed',
        'trade_executed', 'force_close'
    )),
    details           JSONB NOT NULL DEFAULT '{}',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON account_audit_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_account ON account_audit_logs (funded_account_id, created_at DESC);

ALTER TABLE account_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_select" ON account_audit_logs;
CREATE POLICY "audit_select" ON account_audit_logs
    FOR SELECT TO authenticated USING (user_id = auth.uid());

REVOKE INSERT, UPDATE, DELETE ON account_audit_logs FROM anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────────
-- 4. DAILY EQUITY SNAPSHOTS TABLE
-- ──────────────────────────────────────────────────────────────────────────────
-- Records daily P/L per funded account for consistency rule enforcement.

CREATE TABLE IF NOT EXISTS daily_equity_snapshots (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    funded_account_id UUID NOT NULL REFERENCES funded_accounts(id) ON DELETE CASCADE,
    user_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    snapshot_date     DATE NOT NULL,
    opening_equity    NUMERIC NOT NULL,
    closing_equity    NUMERIC,
    day_profit        NUMERIC,
    trades_opened     INT NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (funded_account_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_snapshots_account ON daily_equity_snapshots (funded_account_id, snapshot_date DESC);

ALTER TABLE daily_equity_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "snapshots_select" ON daily_equity_snapshots;
CREATE POLICY "snapshots_select" ON daily_equity_snapshots
    FOR SELECT TO authenticated USING (user_id = auth.uid());

REVOKE INSERT, UPDATE, DELETE ON daily_equity_snapshots FROM anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────────
-- 5. UPDATE PROFILES CONSTRAINT — Add 'FUNDED' to account_status
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_account_status_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_account_status_check
    CHECK (account_status IN ('ACTIVE', 'LOCKED', 'COMBINE', 'FUNDED', 'EVALUATION'));

-- ──────────────────────────────────────────────────────────────────────────────
-- 6. UPDATE PAYMENTS — Add new product types
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_product_check;
ALTER TABLE payments ADD CONSTRAINT payments_product_check
    CHECK (product IN ('ACCOUNT_RESET', 'COMBINE_ENTRY', 'PRO_SUBSCRIPTION',
                       'EVALUATION_ENTRY', 'FUNDED_ENTRY'));


-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. HELPER: Calculate live floating equity for a user
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION calculate_floating_equity(p_user_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
    v_bal        NUMERIC;
    v_unrealized NUMERIC;
    v_spread     NUMERIC := 0.01;
    v_pos        RECORD;
    v_idx_price  NUMERIC;
BEGIN
    SELECT virtual_balance INTO v_bal FROM profiles WHERE id = p_user_id;
    IF v_bal IS NULL THEN RETURN 0; END IF;

    -- Tea positions unrealized P/L
    SELECT COALESCE(SUM(
        CASE WHEN p.quantity > 0
            THEN (t.current_price * (1 - v_spread/2) - p.avg_entry_price) * p.quantity
            ELSE (p.avg_entry_price - t.current_price * (1 + v_spread/2)) * ABS(p.quantity)
        END
    ), 0) INTO v_unrealized
    FROM positions p JOIN teas t ON t.id = p.tea_id
    WHERE p.user_id = p_user_id AND p.trading_mode = 'VIRTUAL' AND p.quantity != 0;

    -- Index positions unrealized P/L
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

    RETURN v_bal + v_unrealized;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. FORCE LIQUIDATE — Closes all positions and marks account as liquidated
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION force_liquidate_funded_account(
    p_funded_account_id UUID,
    p_reason            TEXT,
    p_details           JSONB DEFAULT '{}'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_account RECORD;
BEGIN
    SELECT * INTO v_account FROM funded_accounts
        WHERE id = p_funded_account_id
        FOR UPDATE;

    IF NOT FOUND OR v_account.account_status = 'liquidated' THEN
        RETURN;
    END IF;

    -- Force-close all open positions
    DELETE FROM positions
        WHERE user_id = v_account.user_id AND trading_mode = 'VIRTUAL';
    DELETE FROM index_positions
        WHERE user_id = v_account.user_id AND trading_mode = 'VIRTUAL';
    -- Cancel all pending orders
    UPDATE pending_orders SET status = 'CANCELLED'
        WHERE user_id = v_account.user_id AND status = 'PENDING';

    -- Mark account as liquidated
    UPDATE funded_accounts SET
        account_status = 'liquidated',
        liquidated_at = NOW(),
        current_balance = (SELECT virtual_balance FROM profiles WHERE id = v_account.user_id),
        updated_at = NOW()
    WHERE id = p_funded_account_id;

    -- Update profile status
    UPDATE profiles SET account_status = 'ACTIVE'
        WHERE id = v_account.user_id;

    -- Write audit log
    INSERT INTO account_audit_logs (user_id, funded_account_id, event_type, details)
    VALUES (
        v_account.user_id,
        p_funded_account_id,
        CASE
            WHEN p_reason = 'daily_loss' THEN 'daily_loss_breach'
            WHEN p_reason = 'total_loss' THEN 'total_loss_breach'
            ELSE 'manual_liquidation'
        END,
        p_details
    );
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. CHECK FUNDED ACCOUNT RULES — Called every minute by market-ticker
-- ═══════════════════════════════════════════════════════════════════════════════
-- Enforces:
--   Rule A: Max Daily Loss (5%) — floating equity vs midnight equity
--   Rule B: Max Total Loss (10%) — floating equity vs initial balance

CREATE OR REPLACE FUNCTION check_funded_account_rules()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_account       RECORD;
    v_equity        NUMERIC;
    v_daily_loss    NUMERIC;
    v_total_loss    NUMERIC;
    v_today         DATE := CURRENT_DATE;
    v_liquidated    INT := 0;
    v_checked       INT := 0;
    v_daily_floor   NUMERIC;
    v_total_floor   NUMERIC;
BEGIN
    FOR v_account IN
        SELECT fa.* FROM funded_accounts fa
        WHERE fa.account_status IN ('evaluation', 'funded')
        FOR UPDATE OF fa
    LOOP
        v_checked := v_checked + 1;

        -- Calculate live floating equity
        v_equity := calculate_floating_equity(v_account.user_id);

        -- Daily midnight equity reset (at date boundary)
        IF v_account.last_equity_reset_date IS NULL OR v_account.last_equity_reset_date < v_today THEN
            -- Close out previous day's snapshot
            UPDATE daily_equity_snapshots
                SET closing_equity = v_equity,
                    day_profit = v_equity - opening_equity
                WHERE funded_account_id = v_account.id
                  AND snapshot_date = v_account.last_equity_reset_date;

            -- Update best trading day profit from the closed snapshot
            UPDATE funded_accounts SET
                best_trading_day_profit = GREATEST(
                    best_trading_day_profit,
                    COALESCE((
                        SELECT day_profit FROM daily_equity_snapshots
                        WHERE funded_account_id = v_account.id
                          AND snapshot_date = v_account.last_equity_reset_date
                    ), 0)
                )
            WHERE id = v_account.id;

            -- Record new midnight equity & create daily snapshot
            UPDATE funded_accounts SET
                midnight_equity = v_equity,
                highest_daily_equity = v_equity,
                last_equity_reset_date = v_today,
                updated_at = NOW()
            WHERE id = v_account.id;

            INSERT INTO daily_equity_snapshots (funded_account_id, user_id, snapshot_date, opening_equity)
                VALUES (v_account.id, v_account.user_id, v_today, v_equity)
                ON CONFLICT (funded_account_id, snapshot_date) DO NOTHING;

            INSERT INTO account_audit_logs (user_id, funded_account_id, event_type, details)
            VALUES (v_account.user_id, v_account.id, 'midnight_equity_reset',
                jsonb_build_object('midnight_equity', v_equity, 'date', v_today));

            -- Refresh the record to use new midnight_equity
            v_account.midnight_equity := v_equity;
            v_account.highest_daily_equity := v_equity;
        END IF;

        -- Track highest intraday equity
        IF v_equity > v_account.highest_daily_equity THEN
            UPDATE funded_accounts SET highest_daily_equity = v_equity, updated_at = NOW()
                WHERE id = v_account.id;
        END IF;

        -- ┌─────────────────────────────────────────────────┐
        -- │ Rule A: Maximum Daily Loss (5%)                 │
        -- │ Floor = midnight_equity * 0.95                  │
        -- │ If floating equity < floor → LIQUIDATE          │
        -- └─────────────────────────────────────────────────┘
        v_daily_floor := v_account.midnight_equity * 0.95;

        IF v_equity < v_daily_floor THEN
            PERFORM force_liquidate_funded_account(
                v_account.id,
                'daily_loss',
                jsonb_build_object(
                    'midnight_equity', v_account.midnight_equity,
                    'floating_equity', v_equity,
                    'daily_floor', v_daily_floor,
                    'loss_pct', ROUND(((v_account.midnight_equity - v_equity) / v_account.initial_balance) * 100, 2),
                    'timestamp', NOW()
                )
            );
            v_liquidated := v_liquidated + 1;
            CONTINUE;
        END IF;

        -- ┌─────────────────────────────────────────────────┐
        -- │ Rule B: Maximum Total Loss (10%)                │
        -- │ Floor = initial_balance * 0.90                  │
        -- │ If floating equity < floor → LIQUIDATE          │
        -- └─────────────────────────────────────────────────┘
        v_total_floor := v_account.initial_balance * 0.90;

        IF v_equity < v_total_floor THEN
            PERFORM force_liquidate_funded_account(
                v_account.id,
                'total_loss',
                jsonb_build_object(
                    'initial_balance', v_account.initial_balance,
                    'floating_equity', v_equity,
                    'total_floor', v_total_floor,
                    'loss_pct', ROUND(((v_account.initial_balance - v_equity) / v_account.initial_balance) * 100, 2),
                    'timestamp', NOW()
                )
            );
            v_liquidated := v_liquidated + 1;
            CONTINUE;
        END IF;

        -- Update current_balance (closed P/L) for display
        UPDATE funded_accounts SET
            current_balance = (SELECT virtual_balance FROM profiles WHERE id = v_account.user_id),
            total_profit = (SELECT virtual_balance FROM profiles WHERE id = v_account.user_id) - v_account.initial_balance,
            updated_at = NOW()
        WHERE id = v_account.id;

    END LOOP;

    RETURN jsonb_build_object(
        'checked', v_checked,
        'liquidated', v_liquidated
    );
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. RECORD TRADING DAY — Called after each trade execution
-- ═══════════════════════════════════════════════════════════════════════════════
-- Increments active_trading_days if this is a new day with a trade opened.

CREATE OR REPLACE FUNCTION record_funded_trading_day(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_account RECORD;
    v_today   DATE := CURRENT_DATE;
BEGIN
    SELECT * INTO v_account FROM funded_accounts
        WHERE user_id = p_user_id
          AND account_status IN ('evaluation', 'funded')
        ORDER BY created_at DESC LIMIT 1
        FOR UPDATE;

    IF NOT FOUND THEN RETURN; END IF;

    -- Only count if this is a new trading day
    IF v_account.last_trade_date IS NULL OR v_account.last_trade_date < v_today THEN
        UPDATE funded_accounts SET
            active_trading_days = active_trading_days + 1,
            last_trade_date = v_today,
            first_trade_date = COALESCE(first_trade_date, NOW()),
            updated_at = NOW()
        WHERE id = v_account.id;

        -- Update daily snapshot trades count
        UPDATE daily_equity_snapshots
            SET trades_opened = trades_opened + 1
            WHERE funded_account_id = v_account.id AND snapshot_date = v_today;

        INSERT INTO account_audit_logs (user_id, funded_account_id, event_type, details)
        VALUES (p_user_id, v_account.id, 'trading_day_recorded',
            jsonb_build_object('date', v_today, 'total_days', v_account.active_trading_days + 1));
    ELSE
        -- Same day, just increment trades count
        UPDATE daily_equity_snapshots
            SET trades_opened = trades_opened + 1
            WHERE funded_account_id = v_account.id AND snapshot_date = v_today;
    END IF;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 11. CHECK EVALUATION PASS — Checks if evaluation targets are met
-- ═══════════════════════════════════════════════════════════════════════════════
-- Called by check_funded_account_rules when account is in evaluation status.
-- Evaluation pass requires:
--   - Profit target: 8% (current_balance >= initial_balance * 1.08)
--   - Minimum 4 trading days
--   - Consistency rule: no single day > 50% of total profit

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

    -- Must be profitable
    IF v_profit <= 0 THEN
        RETURN jsonb_build_object('passed', false, 'reason', 'Not profitable',
            'equity', v_equity, 'target', v_account.initial_balance * 1.08);
    END IF;

    -- Profit target: 8%
    IF v_equity < v_account.initial_balance * 1.08 THEN
        RETURN jsonb_build_object('passed', false, 'reason', 'Profit target not met',
            'equity', v_equity, 'target', v_account.initial_balance * 1.08,
            'current_pct', ROUND((v_profit / v_account.initial_balance) * 100, 2));
    END IF;

    -- Minimum trading days
    IF v_account.active_trading_days < 5 THEN
        RETURN jsonb_build_object('passed', false, 'reason', 'Minimum trading days not met',
            'active_days', v_account.active_trading_days, 'required', 5);
    END IF;

    -- Consistency rule: best single day < 50% of total profit
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

    -- ALL CHECKS PASSED — Promote to funded
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


-- ═══════════════════════════════════════════════════════════════════════════════
-- 12. REQUEST REWARD PAYOUT — The 14-day payout cycle
-- ═══════════════════════════════════════════════════════════════════════════════
-- Validates all conditions before allowing 80/20 profit split payout.

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
    -- Lock the funded account row
    SELECT * INTO v_account FROM funded_accounts
        WHERE user_id = p_user_id AND account_status = 'funded'
        ORDER BY created_at DESC LIMIT 1
        FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No active funded account found. You must pass the evaluation first.';
    END IF;

    -- ── Condition 1: 14-day cycle ──────────────────────────────────
    v_cycle_start := COALESCE(v_account.last_payout_date, v_account.first_trade_date, v_account.created_at);
    IF NOW() < v_cycle_start + INTERVAL '14 days' THEN
        RAISE EXCEPTION 'Payout not available yet. Next payout eligible on %. (14-day cycle)',
            TO_CHAR(v_cycle_start + INTERVAL '14 days', 'DD Mon YYYY HH24:MI');
    END IF;

    -- ── Condition 2: Flat book — NO open positions or pending orders ──
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

    -- ── Condition 3: Must be profitable ────────────────────────────
    v_equity := (SELECT virtual_balance FROM profiles WHERE id = p_user_id);
    v_profit := v_equity - v_account.initial_balance;

    IF v_profit <= 0 THEN
        RAISE EXCEPTION 'Account is not profitable. Current balance: $%, Initial: $%. No reward to claim.',
            ROUND(v_equity, 2), ROUND(v_account.initial_balance, 2);
    END IF;

    -- ── Condition 4: Minimum trading days ──────────────────────────
    IF v_account.active_trading_days < 5 THEN
        RAISE EXCEPTION 'Minimum 5 active trading days required. Current: % days.', v_account.active_trading_days;
    END IF;

    -- ── Condition 5: Consistency rule ──────────────────────────────
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

    -- ══════════════ ALL CHECKS PASSED — EXECUTE PAYOUT ══════════════

    -- Calculate 80/20 split
    v_payout     := ROUND(v_profit * 0.80, 2);
    v_house_share := ROUND(v_profit * 0.20, 2);

    -- Insert payout request
    INSERT INTO payout_requests (
        user_id, funded_account_id, gross_profit, payout_amount, house_share,
        balance_before, balance_after, active_trading_days, best_day_profit, consistency_pct
    ) VALUES (
        p_user_id, v_account.id, v_profit, v_payout, v_house_share,
        v_equity, v_account.initial_balance, v_account.active_trading_days,
        v_best_day, COALESCE(v_consistency, 0)
    );

    -- CRITICAL RESET: Balance back to initial, trading days to 0
    UPDATE profiles SET
        virtual_balance = v_account.initial_balance,
        cash_balance = v_account.initial_balance
    WHERE id = p_user_id;

    UPDATE funded_accounts SET
        current_balance = v_account.initial_balance,
        active_trading_days = 0,
        best_trading_day_profit = 0,
        total_profit = 0,
        last_payout_date = NOW(),
        midnight_equity = v_account.initial_balance,
        highest_daily_equity = v_account.initial_balance,
        updated_at = NOW()
    WHERE id = v_account.id;

    -- Audit log
    INSERT INTO account_audit_logs (user_id, funded_account_id, event_type, details)
    VALUES (p_user_id, v_account.id, 'payout_requested',
        jsonb_build_object(
            'gross_profit', v_profit,
            'payout_amount', v_payout,
            'house_share', v_house_share,
            'balance_reset_to', v_account.initial_balance,
            'trading_days_at_payout', v_account.active_trading_days,
            'consistency_pct', COALESCE(v_consistency, 0)
        ));

    RETURN jsonb_build_object(
        'success', true,
        'payout_amount', v_payout,
        'house_share', v_house_share,
        'gross_profit', v_profit,
        'new_balance', v_account.initial_balance,
        'next_payout_eligible', NOW() + INTERVAL '14 days'
    );
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 13. LEVERAGE CAP ENFORCEMENT — Rule E: 1:30 max for tea (volatile)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Patches execute_trade_secure to reject leverage > 30 for funded accounts.
-- This is enforced inside the trade function, but we also add a standalone check.

CREATE OR REPLACE FUNCTION check_leverage_cap(
    p_user_id  UUID,
    p_leverage NUMERIC
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
    v_has_funded BOOLEAN;
    v_max_leverage NUMERIC := 30;
BEGIN
    SELECT EXISTS(
        SELECT 1 FROM funded_accounts
        WHERE user_id = p_user_id
          AND account_status IN ('evaluation', 'funded')
    ) INTO v_has_funded;

    IF v_has_funded AND p_leverage > v_max_leverage THEN
        INSERT INTO account_audit_logs (user_id, funded_account_id, event_type, details)
        SELECT p_user_id, id, 'leverage_rejected',
            jsonb_build_object('requested_leverage', p_leverage, 'max_allowed', v_max_leverage)
        FROM funded_accounts
        WHERE user_id = p_user_id AND account_status IN ('evaluation', 'funded')
        LIMIT 1;
        RETURN false;
    END IF;

    RETURN true;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 14. START EVALUATION — Called after Stripe payment for evaluation entry
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION start_evaluation(
    p_user_id        UUID,
    p_initial_balance NUMERIC DEFAULT 10000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_account_id UUID;
BEGIN
    -- Cancel any existing active funded accounts
    UPDATE funded_accounts SET
        account_status = 'liquidated',
        liquidated_at = NOW(),
        updated_at = NOW()
    WHERE user_id = p_user_id
      AND account_status IN ('evaluation', 'funded');

    -- Close all positions
    DELETE FROM positions WHERE user_id = p_user_id AND trading_mode = 'VIRTUAL';
    DELETE FROM index_positions WHERE user_id = p_user_id AND trading_mode = 'VIRTUAL';
    UPDATE pending_orders SET status = 'CANCELLED'
        WHERE user_id = p_user_id AND status = 'PENDING';

    -- Set balance
    UPDATE profiles SET
        virtual_balance = p_initial_balance,
        cash_balance = p_initial_balance,
        account_status = 'EVALUATION'
    WHERE id = p_user_id;

    -- Create funded_accounts row
    INSERT INTO funded_accounts (
        user_id, account_status, initial_balance, current_balance,
        highest_daily_equity, midnight_equity, last_equity_reset_date
    ) VALUES (
        p_user_id, 'evaluation', p_initial_balance, p_initial_balance,
        p_initial_balance, p_initial_balance, CURRENT_DATE
    ) RETURNING id INTO v_account_id;

    -- Create initial daily snapshot
    INSERT INTO daily_equity_snapshots (funded_account_id, user_id, snapshot_date, opening_equity)
        VALUES (v_account_id, p_user_id, CURRENT_DATE, p_initial_balance);

    -- Audit log
    INSERT INTO account_audit_logs (user_id, funded_account_id, event_type, details)
    VALUES (p_user_id, v_account_id, 'account_created',
        jsonb_build_object('initial_balance', p_initial_balance, 'type', 'evaluation'));

    RETURN jsonb_build_object(
        'success', true,
        'funded_account_id', v_account_id,
        'initial_balance', p_initial_balance,
        'status', 'evaluation'
    );
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 15. GET FUNDED ACCOUNT STATUS — Frontend dashboard RPC
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_funded_account_status(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
    v_account  RECORD;
    v_equity   NUMERIC;
    v_profit   NUMERIC;
    v_daily_pct NUMERIC;
    v_total_pct NUMERIC;
    v_consistency NUMERIC;
    v_next_payout TIMESTAMPTZ;
    v_cycle_start TIMESTAMPTZ;
    v_open_positions INT;
    v_last_audit JSONB;
BEGIN
    SELECT * INTO v_account FROM funded_accounts
        WHERE user_id = p_user_id
        ORDER BY created_at DESC LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('has_account', false);
    END IF;

    v_equity := calculate_floating_equity(p_user_id);
    v_profit := v_equity - v_account.initial_balance;

    -- Daily loss percentage
    IF v_account.midnight_equity > 0 THEN
        v_daily_pct := ROUND(((v_account.midnight_equity - v_equity) / v_account.initial_balance) * 100, 2);
    ELSE
        v_daily_pct := 0;
    END IF;

    -- Total loss percentage
    v_total_pct := ROUND(((v_account.initial_balance - v_equity) / v_account.initial_balance) * 100, 2);

    -- Consistency percentage
    IF v_profit > 0 AND v_account.best_trading_day_profit > 0 THEN
        v_consistency := ROUND((v_account.best_trading_day_profit / v_profit) * 100, 2);
    ELSE
        v_consistency := 0;
    END IF;

    -- Next payout date
    v_cycle_start := COALESCE(v_account.last_payout_date, v_account.first_trade_date, v_account.created_at);
    v_next_payout := v_cycle_start + INTERVAL '14 days';

    -- Open position count
    SELECT COUNT(*) INTO v_open_positions
        FROM (
            SELECT 1 FROM positions WHERE user_id = p_user_id AND trading_mode = 'VIRTUAL' AND quantity != 0
            UNION ALL
            SELECT 1 FROM index_positions WHERE user_id = p_user_id AND trading_mode = 'VIRTUAL' AND quantity != 0
        ) x;

    -- Last liquidation audit log (if liquidated)
    IF v_account.account_status = 'liquidated' THEN
        SELECT details INTO v_last_audit FROM account_audit_logs
            WHERE funded_account_id = v_account.id
              AND event_type IN ('daily_loss_breach', 'total_loss_breach', 'manual_liquidation')
            ORDER BY created_at DESC LIMIT 1;
    END IF;

    RETURN jsonb_build_object(
        'has_account', true,
        'account_id', v_account.id,
        'account_status', v_account.account_status,
        'initial_balance', v_account.initial_balance,
        'current_balance', v_account.current_balance,
        'floating_equity', v_equity,
        'profit', v_profit,
        'profit_pct', CASE WHEN v_account.initial_balance > 0
            THEN ROUND((v_profit / v_account.initial_balance) * 100, 2) ELSE 0 END,
        'midnight_equity', v_account.midnight_equity,
        'daily_loss_pct', v_daily_pct,
        'daily_floor', v_account.midnight_equity * 0.95,
        'total_loss_pct', v_total_pct,
        'total_floor', v_account.initial_balance * 0.90,
        'active_trading_days', v_account.active_trading_days,
        'best_day_profit', v_account.best_trading_day_profit,
        'consistency_pct', v_consistency,
        'first_trade_date', v_account.first_trade_date,
        'last_payout_date', v_account.last_payout_date,
        'next_payout_eligible', v_next_payout,
        'open_positions', v_open_positions,
        'can_request_payout', (
            v_account.account_status = 'funded'
            AND v_profit > 0
            AND v_account.active_trading_days >= 4
            AND v_open_positions = 0
            AND NOW() >= v_next_payout
            AND (v_profit <= 0 OR v_account.best_trading_day_profit <= 0
                 OR (v_account.best_trading_day_profit / v_profit) <= 0.50)
        ),
        'liquidation_details', v_last_audit,
        'created_at', v_account.created_at,
        'passed_evaluation_at', v_account.passed_evaluation_at,
        'liquidated_at', v_account.liquidated_at
    );
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 16. GET LIQUIDATION AUDIT LOG — For the mandatory liquidation modal
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_liquidation_audit(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
    v_logs JSONB;
BEGIN
    SELECT jsonb_agg(
        jsonb_build_object(
            'event_type', event_type,
            'details', details,
            'timestamp', created_at
        ) ORDER BY created_at DESC
    ) INTO v_logs
    FROM account_audit_logs
    WHERE user_id = p_user_id
      AND funded_account_id = (
          SELECT id FROM funded_accounts
          WHERE user_id = p_user_id
          ORDER BY created_at DESC LIMIT 1
      )
      AND event_type IN ('daily_loss_breach', 'total_loss_breach', 'manual_liquidation',
                         'account_created', 'evaluation_passed', 'payout_requested',
                         'midnight_equity_reset');

    RETURN COALESCE(v_logs, '[]'::jsonb);
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 17. GRANT EXECUTE permissions on all new RPCs
-- ═══════════════════════════════════════════════════════════════════════════════

GRANT EXECUTE ON FUNCTION calculate_floating_equity(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION check_funded_account_rules() TO service_role;
GRANT EXECUTE ON FUNCTION record_funded_trading_day(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION check_evaluation_pass(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION request_reward_payout(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION check_leverage_cap(UUID, NUMERIC) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION start_evaluation(UUID, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION get_funded_account_status(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_liquidation_audit(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION force_liquidate_funded_account(UUID, TEXT, JSONB) TO service_role;
