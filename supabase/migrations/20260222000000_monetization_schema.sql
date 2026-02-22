-- ═══════════════════════════════════════════════════════════════════════════════
-- MONETIZATION ENGINE: Schema, tables, and updated functions
-- Adds: tier/account_status to profiles, combine_challenges, payments,
--        updated reset_account with source parameter, check_combine_rules,
--        account locking in check_stop_outs
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1. PROFILES: Monetization columns ──────────────────────────────────────────

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'FREE';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS pro_expires_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS next_free_reset_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS combine_badge BOOLEAN NOT NULL DEFAULT FALSE;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_tier_check') THEN
        ALTER TABLE profiles ADD CONSTRAINT profiles_tier_check CHECK (tier IN ('FREE', 'PRO'));
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_account_status_check') THEN
        ALTER TABLE profiles ADD CONSTRAINT profiles_account_status_check CHECK (account_status IN ('ACTIVE', 'LOCKED', 'COMBINE'));
    END IF;
END $$;

-- Prevent client-side manipulation of monetization columns
REVOKE UPDATE (tier, account_status, stripe_customer_id, pro_expires_at, next_free_reset_at, combine_badge)
    ON profiles FROM anon, authenticated;

-- ── 2. COMBINE CHALLENGES ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS combine_challenges (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    start_balance          NUMERIC NOT NULL DEFAULT 50000,
    target_profit_pct      NUMERIC NOT NULL DEFAULT 8.0,
    max_daily_drawdown_pct NUMERIC NOT NULL DEFAULT 5.0,
    daily_start_equity     NUMERIC NOT NULL DEFAULT 50000,
    peak_equity            NUMERIC NOT NULL DEFAULT 50000,
    status                 TEXT NOT NULL DEFAULT 'ACTIVE',
    started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at             TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',
    completed_at           TIMESTAMPTZ,
    CONSTRAINT combine_status_check CHECK (status IN ('ACTIVE', 'PASSED', 'FAILED', 'EXPIRED'))
);

ALTER TABLE combine_challenges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "combine_select" ON combine_challenges;
CREATE POLICY "combine_select" ON combine_challenges
    FOR SELECT TO authenticated USING (user_id = auth.uid());

-- ── 3. PAYMENTS (audit log) ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payments (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    stripe_session_id TEXT UNIQUE,
    product           TEXT NOT NULL,
    amount_pence      INT NOT NULL,
    currency          TEXT NOT NULL DEFAULT 'gbp',
    status            TEXT NOT NULL DEFAULT 'completed',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT payments_product_check CHECK (product IN ('ACCOUNT_RESET', 'COMBINE_ENTRY', 'PRO_SUBSCRIPTION'))
);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payments_select" ON payments;
CREATE POLICY "payments_select" ON payments
    FOR SELECT TO authenticated USING (user_id = auth.uid());

-- ── 4. UPDATED reset_account() ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION reset_account(
    p_user_id         UUID,
    p_default_balance NUMERIC DEFAULT 10000,
    p_mode            TEXT DEFAULT 'VIRTUAL',
    p_source          TEXT DEFAULT 'PAID_RESET'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_new_balance NUMERIC;
    v_new_status  TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_user_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Profile not found');
    END IF;

    -- Determine balance and status based on source
    CASE p_source
        WHEN 'FREE_BAILOUT' THEN
            v_new_balance := 1000;
            v_new_status  := 'ACTIVE';
        WHEN 'PAID_RESET' THEN
            v_new_balance := COALESCE(p_default_balance, 10000);
            v_new_status  := 'ACTIVE';
        WHEN 'COMBINE_START' THEN
            v_new_balance := 50000;
            v_new_status  := 'COMBINE';
        ELSE
            v_new_balance := COALESCE(p_default_balance, 10000);
            v_new_status  := 'ACTIVE';
    END CASE;

    -- Close all positions and trades for this mode
    DELETE FROM positions WHERE user_id = p_user_id AND trading_mode = p_mode;
    DELETE FROM index_positions WHERE user_id = p_user_id AND trading_mode = p_mode;
    DELETE FROM trades WHERE user_id = p_user_id AND trading_mode = p_mode;

    -- Set balance and account status
    IF p_mode = 'REAL' THEN
        UPDATE profiles
        SET real_balance    = v_new_balance,
            account_status  = v_new_status,
            next_free_reset_at = NULL
        WHERE id = p_user_id;
    ELSE
        UPDATE profiles
        SET virtual_balance = v_new_balance,
            account_status  = v_new_status,
            next_free_reset_at = NULL
        WHERE id = p_user_id;
    END IF;

    RETURN jsonb_build_object(
        'success',     true,
        'new_balance', v_new_balance,
        'mode',        p_mode,
        'source',      p_source,
        'status',      v_new_status
    );
END;
$$;

-- ── 5. check_combine_rules() ───────────────────────────────────────────────────

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
BEGIN
    SELECT * INTO v_challenge FROM combine_challenges
        WHERE user_id = p_user_id AND status = 'ACTIVE'
        ORDER BY started_at DESC LIMIT 1;

    IF v_challenge IS NULL THEN
        RETURN jsonb_build_object('active', false);
    END IF;

    -- Check expiry
    IF NOW() > v_challenge.expires_at THEN
        UPDATE combine_challenges SET status = 'EXPIRED', completed_at = NOW() WHERE id = v_challenge.id;
        UPDATE profiles SET account_status = 'ACTIVE', virtual_balance = 10000 WHERE id = p_user_id;
        DELETE FROM positions WHERE user_id = p_user_id AND trading_mode = 'VIRTUAL';
        DELETE FROM index_positions WHERE user_id = p_user_id AND trading_mode = 'VIRTUAL';
        RETURN jsonb_build_object('active', false, 'result', 'EXPIRED');
    END IF;

    -- Calculate live equity
    SELECT virtual_balance INTO v_bal FROM profiles WHERE id = p_user_id;

    SELECT COALESCE(SUM(
        CASE WHEN p.quantity > 0
            THEN (t.current_price * (1 - v_spread/2) - p.avg_entry_price) * p.quantity
            ELSE (p.avg_entry_price - t.current_price * (1 + v_spread/2)) * ABS(p.quantity)
        END
    ), 0) INTO v_unrealized
    FROM positions p JOIN teas t ON t.id = p.tea_id
    WHERE p.user_id = p_user_id AND p.trading_mode = 'VIRTUAL' AND p.quantity != 0;

    -- Add index positions
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

    -- Update peak
    IF v_equity > v_challenge.peak_equity THEN
        UPDATE combine_challenges SET peak_equity = v_equity WHERE id = v_challenge.id;
    END IF;

    v_target   := v_challenge.start_balance * (1 + v_challenge.target_profit_pct / 100);
    v_dd_floor := v_challenge.daily_start_equity * (1 - v_challenge.max_daily_drawdown_pct / 100);

    -- Check daily drawdown breach
    IF v_equity < v_dd_floor THEN
        UPDATE combine_challenges SET status = 'FAILED', completed_at = NOW() WHERE id = v_challenge.id;
        UPDATE profiles SET account_status = 'ACTIVE', virtual_balance = 10000 WHERE id = p_user_id;
        DELETE FROM positions WHERE user_id = p_user_id AND trading_mode = 'VIRTUAL';
        DELETE FROM index_positions WHERE user_id = p_user_id AND trading_mode = 'VIRTUAL';
        RETURN jsonb_build_object('active', false, 'result', 'FAILED', 'reason', 'daily_drawdown');
    END IF;

    -- Check victory
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
