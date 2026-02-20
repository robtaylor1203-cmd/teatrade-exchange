-- ═══════════════════════════════════════════════════════════════════════════════
-- TRADING ENGINE MONETIZATION
-- Leverage, Bid/Ask Spread, Overnight Financing, Stop-Out Protection
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── 1. PLATFORM CONFIG TABLE ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_config (
    key   TEXT PRIMARY KEY,
    value NUMERIC NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO platform_config (key, value) VALUES
    ('spread_pct',       0.01),
    ('annual_swap_rate', 0.05),
    ('stop_out_level',   0.50),
    ('max_leverage',     25)
ON CONFLICT (key) DO NOTHING;

-- ─── 2. POSITIONS: add leverage + margin tracking ───────────────────────────
ALTER TABLE positions
    ADD COLUMN IF NOT EXISTS leverage    NUMERIC NOT NULL DEFAULT 1 CHECK (leverage >= 1 AND leverage <= 25),
    ADD COLUMN IF NOT EXISTS margin_used NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE index_positions
    ADD COLUMN IF NOT EXISTS leverage    NUMERIC NOT NULL DEFAULT 1 CHECK (leverage >= 1 AND leverage <= 25),
    ADD COLUMN IF NOT EXISTS margin_used NUMERIC NOT NULL DEFAULT 0;

-- Backfill existing positions (opened at 1x, full notional was deducted)
UPDATE positions SET margin_used = ABS(quantity) * avg_entry_price WHERE margin_used = 0 AND quantity != 0;
UPDATE index_positions SET margin_used = ABS(quantity) * avg_entry_price WHERE margin_used = 0 AND quantity != 0;

-- ─── 3. FINANCING HISTORY TABLE ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS financing_history (
    id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id        UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    position_type  TEXT NOT NULL CHECK (position_type IN ('tea', 'index')),
    symbol         TEXT NOT NULL,
    notional_value NUMERIC NOT NULL,
    fee            NUMERIC NOT NULL,
    rate           NUMERIC NOT NULL,
    trading_mode   TEXT NOT NULL DEFAULT 'VIRTUAL' CHECK (trading_mode IN ('VIRTUAL', 'REAL')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_financing_user ON financing_history (user_id, created_at DESC);

-- ─── 4. PLATFORM REVENUE TABLE ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_revenue (
    id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    revenue_type TEXT NOT NULL CHECK (revenue_type IN ('spread', 'swap', 'stop_out')),
    trade_id     UUID,
    user_id      UUID REFERENCES profiles(id) ON DELETE SET NULL,
    amount       NUMERIC NOT NULL,
    symbol       TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_revenue_type ON platform_revenue (revenue_type, created_at DESC);

-- ─── 5. RLS for new tables ──────────────────────────────────────────────────
ALTER TABLE financing_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_revenue  ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_config   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own financing" ON financing_history
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Config readable by all" ON platform_config
    FOR SELECT USING (true);

-- platform_revenue: no public read (admin-only)


-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. EXECUTE_TRADE — with spread, leverage, margin
-- ═══════════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS execute_trade(UUID, TEXT, TEXT, NUMERIC, TEXT);

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
    -- Validate inputs
    IF p_mode NOT IN ('VIRTUAL', 'REAL') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid trading mode');
    END IF;
    IF p_side NOT IN ('BUY', 'SELL') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid side: must be BUY or SELL');
    END IF;
    IF p_quantity <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Quantity must be greater than zero');
    END IF;
    IF p_leverage < 1 OR p_leverage > 25 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Leverage must be between 1 and 25');
    END IF;

    -- Load spread from config
    SELECT value INTO v_spread FROM platform_config WHERE key = 'spread_pct';
    v_spread := COALESCE(v_spread, 0.01);

    -- Lock tea row and get market price
    SELECT * INTO v_tea FROM teas WHERE symbol = p_tea_symbol FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Tea not found: ' || p_tea_symbol);
    END IF;

    v_tea_id := v_tea.id;
    v_price  := v_tea.current_price;
    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'No valid market price');
    END IF;

    -- Lock profile
    SELECT * INTO v_profile FROM profiles WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'User profile not found');
    END IF;
    v_bal := CASE WHEN p_mode = 'REAL' THEN v_profile.real_balance ELSE v_profile.virtual_balance END;

    -- Lock position
    SELECT * INTO v_position FROM positions
        WHERE user_id = p_user_id AND tea_id = v_tea_id AND trading_mode = p_mode
        FOR UPDATE;

    v_existing_qty := COALESCE(v_position.quantity, 0);

    -- ── BUY ──────────────────────────────────────────────────────────
    IF p_side = 'BUY' THEN
        IF v_existing_qty >= 0 THEN
            -- Open / extend LONG → execute at ASK
            v_exec_price := v_price * (1 + v_spread / 2);
            v_notional   := v_exec_price * p_quantity;
            v_margin_req := v_notional / p_leverage;
            v_spread_cost := (v_exec_price - v_price) * p_quantity;

            IF v_bal < v_margin_req THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient margin. Need $' || ROUND(v_margin_req, 2) || ' (have $' || ROUND(v_bal, 2) || ')');
            END IF;
            v_new_balance := v_bal - v_margin_req;

            IF FOUND THEN
                v_new_qty    := v_existing_qty + p_quantity;
                v_new_avg    := ((v_position.avg_entry_price * v_existing_qty) + (v_exec_price * p_quantity)) / v_new_qty;
                v_new_margin := v_position.margin_used + v_margin_req;
                v_new_leverage := v_new_qty * v_new_avg / NULLIF(v_new_margin, 0);
                UPDATE positions SET quantity = v_new_qty, avg_entry_price = v_new_avg,
                    margin_used = v_new_margin, leverage = COALESCE(v_new_leverage, 1), updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                INSERT INTO positions (user_id, tea_id, quantity, avg_entry_price, leverage, margin_used, trading_mode)
                    VALUES (p_user_id, v_tea_id, p_quantity, v_exec_price, p_leverage, v_margin_req, p_mode);
            END IF;

        ELSE
            -- Close / reduce SHORT → execute at ASK (worse for short holder)
            v_exec_price := v_price * (1 + v_spread / 2);
            v_spread_cost := (v_exec_price - v_price) * p_quantity;

            v_close_qty := LEAST(p_quantity, ABS(v_existing_qty));
            v_open_qty  := p_quantity - v_close_qty;

            -- P&L on closed short portion
            v_close_pnl    := (v_position.avg_entry_price - v_exec_price) * v_close_qty;
            v_close_margin := v_position.margin_used * (v_close_qty / ABS(v_existing_qty));
            v_new_balance  := v_bal + v_close_margin + v_close_pnl;

            -- If there's a remainder to open long
            IF v_open_qty > 0 THEN
                v_margin_req := v_exec_price * v_open_qty / p_leverage;
                v_new_balance := v_new_balance - v_margin_req;
            END IF;

            IF v_new_balance < 0 THEN
                RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance to complete this trade');
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
                    margin_used = v_position.margin_used - v_close_margin, updated_at = NOW()
                    WHERE id = v_position.id;
            END IF;
        END IF;

    -- ── SELL ─────────────────────────────────────────────────────────
    ELSIF p_side = 'SELL' THEN
        IF v_existing_qty <= 0 THEN
            -- Open / extend SHORT → execute at BID
            v_exec_price := v_price * (1 - v_spread / 2);
            v_notional   := v_exec_price * p_quantity;
            v_margin_req := v_notional / p_leverage;
            v_spread_cost := (v_price - v_exec_price) * p_quantity;

            IF v_bal < v_margin_req THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient margin. Need $' || ROUND(v_margin_req, 2) || ' (have $' || ROUND(v_bal, 2) || ')');
            END IF;
            v_new_balance := v_bal - v_margin_req;

            IF FOUND THEN
                v_new_qty    := v_existing_qty - p_quantity;
                v_new_avg    := ((v_position.avg_entry_price * ABS(v_existing_qty)) + (v_exec_price * p_quantity)) / ABS(v_new_qty);
                v_new_margin := v_position.margin_used + v_margin_req;
                v_new_leverage := ABS(v_new_qty) * v_new_avg / NULLIF(v_new_margin, 0);
                UPDATE positions SET quantity = v_new_qty, avg_entry_price = v_new_avg,
                    margin_used = v_new_margin, leverage = COALESCE(v_new_leverage, 1), updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                INSERT INTO positions (user_id, tea_id, quantity, avg_entry_price, leverage, margin_used, trading_mode)
                    VALUES (p_user_id, v_tea_id, -p_quantity, v_exec_price, p_leverage, v_margin_req, p_mode);
            END IF;

        ELSE
            -- Close / reduce LONG → execute at BID (worse for long holder)
            v_exec_price := v_price * (1 - v_spread / 2);
            v_spread_cost := (v_price - v_exec_price) * p_quantity;

            v_close_qty := LEAST(p_quantity, v_existing_qty);
            v_open_qty  := p_quantity - v_close_qty;

            -- P&L on closed long portion
            v_close_pnl    := (v_exec_price - v_position.avg_entry_price) * v_close_qty;
            v_close_margin := v_position.margin_used * (v_close_qty / v_existing_qty);
            v_new_balance  := v_bal + v_close_margin + v_close_pnl;

            -- If there's a remainder to open short
            IF v_open_qty > 0 THEN
                v_margin_req := v_exec_price * v_open_qty / p_leverage;
                v_new_balance := v_new_balance - v_margin_req;
            END IF;

            IF v_new_balance < 0 THEN
                RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance to complete this trade');
            END IF;

            v_new_qty := v_existing_qty - p_quantity;
            IF v_new_qty = 0 THEN
                DELETE FROM positions WHERE id = v_position.id;
            ELSIF v_new_qty > 0 THEN
                UPDATE positions SET quantity = v_new_qty,
                    margin_used = v_position.margin_used - v_close_margin, updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                UPDATE positions SET quantity = v_new_qty, avg_entry_price = v_exec_price,
                    leverage = p_leverage, margin_used = v_exec_price * ABS(v_new_qty) / p_leverage, updated_at = NOW()
                    WHERE id = v_position.id;
            END IF;
        END IF;
    END IF;

    -- Update balance
    IF p_mode = 'REAL' THEN
        UPDATE profiles SET real_balance = v_new_balance WHERE id = p_user_id;
    ELSE
        UPDATE profiles SET virtual_balance = v_new_balance WHERE id = p_user_id;
    END IF;

    -- Log trade
    INSERT INTO trades (user_id, tea_id, side, quantity, price, total_value, trading_mode)
        VALUES (p_user_id, v_tea_id, p_side, p_quantity, v_exec_price,
                v_exec_price * p_quantity, p_mode)
        RETURNING * INTO v_trade;

    -- Log spread revenue
    v_spread_cost := COALESCE(v_spread_cost, 0);
    IF v_spread_cost > 0 THEN
        INSERT INTO platform_revenue (revenue_type, trade_id, user_id, amount, symbol)
            VALUES ('spread', v_trade.id, p_user_id, v_spread_cost, p_tea_symbol);
    END IF;

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


-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. EXECUTE_INDEX_TRADE — with spread, leverage, margin
-- ═══════════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS execute_index_trade(UUID, TEXT, TEXT, NUMERIC, NUMERIC, TEXT);

CREATE OR REPLACE FUNCTION execute_index_trade(
    p_user_id      UUID,
    p_index_symbol TEXT,
    p_side         TEXT,
    p_quantity     NUMERIC,
    p_price        NUMERIC,
    p_mode         TEXT DEFAULT 'VIRTUAL',
    p_leverage     NUMERIC DEFAULT 1
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
BEGIN
    -- Validate
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
    IF p_leverage < 1 OR p_leverage > 25 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Leverage must be between 1 and 25');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM indexes WHERE symbol = p_index_symbol) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Index not found: ' || p_index_symbol);
    END IF;

    -- Load spread
    SELECT value INTO v_spread FROM platform_config WHERE key = 'spread_pct';
    v_spread := COALESCE(v_spread, 0.01);

    -- Lock profile
    SELECT * INTO v_profile FROM profiles WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'User profile not found');
    END IF;
    v_bal := CASE WHEN p_mode = 'REAL' THEN v_profile.real_balance ELSE v_profile.virtual_balance END;

    -- Lock position
    SELECT * INTO v_position FROM index_positions
        WHERE user_id = p_user_id AND index_symbol = p_index_symbol AND trading_mode = p_mode
        FOR UPDATE;

    v_existing_qty := COALESCE(v_position.quantity, 0);

    -- ── BUY ──────────────────────────────────────────────────────────
    IF p_side = 'BUY' THEN
        IF v_existing_qty >= 0 THEN
            v_exec_price := p_price * (1 + v_spread / 2);
            v_notional   := v_exec_price * p_quantity;
            v_margin_req := v_notional / p_leverage;
            v_spread_cost := (v_exec_price - p_price) * p_quantity;

            IF v_bal < v_margin_req THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient margin. Need $' || ROUND(v_margin_req, 2) || ' (have $' || ROUND(v_bal, 2) || ')');
            END IF;
            v_new_balance := v_bal - v_margin_req;

            IF FOUND THEN
                v_new_qty    := v_existing_qty + p_quantity;
                v_new_avg    := ((v_position.avg_entry_price * v_existing_qty) + (v_exec_price * p_quantity)) / v_new_qty;
                v_new_margin := v_position.margin_used + v_margin_req;
                v_new_leverage := v_new_qty * v_new_avg / NULLIF(v_new_margin, 0);
                UPDATE index_positions SET quantity = v_new_qty, avg_entry_price = v_new_avg,
                    margin_used = v_new_margin, leverage = COALESCE(v_new_leverage, 1), updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                INSERT INTO index_positions (user_id, index_symbol, quantity, avg_entry_price, leverage, margin_used, trading_mode)
                    VALUES (p_user_id, p_index_symbol, p_quantity, v_exec_price, p_leverage, v_margin_req, p_mode);
            END IF;

        ELSE
            v_exec_price := p_price * (1 + v_spread / 2);
            v_spread_cost := (v_exec_price - p_price) * p_quantity;
            v_close_qty := LEAST(p_quantity, ABS(v_existing_qty));
            v_open_qty  := p_quantity - v_close_qty;
            v_close_pnl    := (v_position.avg_entry_price - v_exec_price) * v_close_qty;
            v_close_margin := v_position.margin_used * (v_close_qty / ABS(v_existing_qty));
            v_new_balance  := v_bal + v_close_margin + v_close_pnl;
            IF v_open_qty > 0 THEN
                v_margin_req := v_exec_price * v_open_qty / p_leverage;
                v_new_balance := v_new_balance - v_margin_req;
            END IF;
            IF v_new_balance < 0 THEN
                RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance to complete this trade');
            END IF;
            v_new_qty := v_existing_qty + p_quantity;
            IF v_new_qty = 0 THEN
                DELETE FROM index_positions WHERE id = v_position.id;
            ELSIF v_new_qty > 0 THEN
                UPDATE index_positions SET quantity = v_new_qty, avg_entry_price = v_exec_price,
                    leverage = p_leverage, margin_used = v_exec_price * v_new_qty / p_leverage, updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                UPDATE index_positions SET quantity = v_new_qty,
                    margin_used = v_position.margin_used - v_close_margin, updated_at = NOW()
                    WHERE id = v_position.id;
            END IF;
        END IF;

    -- ── SELL ─────────────────────────────────────────────────────────
    ELSIF p_side = 'SELL' THEN
        IF v_existing_qty <= 0 THEN
            v_exec_price := p_price * (1 - v_spread / 2);
            v_notional   := v_exec_price * p_quantity;
            v_margin_req := v_notional / p_leverage;
            v_spread_cost := (p_price - v_exec_price) * p_quantity;

            IF v_bal < v_margin_req THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Insufficient margin. Need $' || ROUND(v_margin_req, 2) || ' (have $' || ROUND(v_bal, 2) || ')');
            END IF;
            v_new_balance := v_bal - v_margin_req;

            IF FOUND THEN
                v_new_qty    := v_existing_qty - p_quantity;
                v_new_avg    := ((v_position.avg_entry_price * ABS(v_existing_qty)) + (v_exec_price * p_quantity)) / ABS(v_new_qty);
                v_new_margin := v_position.margin_used + v_margin_req;
                v_new_leverage := ABS(v_new_qty) * v_new_avg / NULLIF(v_new_margin, 0);
                UPDATE index_positions SET quantity = v_new_qty, avg_entry_price = v_new_avg,
                    margin_used = v_new_margin, leverage = COALESCE(v_new_leverage, 1), updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                INSERT INTO index_positions (user_id, index_symbol, quantity, avg_entry_price, leverage, margin_used, trading_mode)
                    VALUES (p_user_id, p_index_symbol, -p_quantity, v_exec_price, p_leverage, v_margin_req, p_mode);
            END IF;

        ELSE
            v_exec_price := p_price * (1 - v_spread / 2);
            v_spread_cost := (p_price - v_exec_price) * p_quantity;
            v_close_qty := LEAST(p_quantity, v_existing_qty);
            v_open_qty  := p_quantity - v_close_qty;
            v_close_pnl    := (v_exec_price - v_position.avg_entry_price) * v_close_qty;
            v_close_margin := v_position.margin_used * (v_close_qty / v_existing_qty);
            v_new_balance  := v_bal + v_close_margin + v_close_pnl;
            IF v_open_qty > 0 THEN
                v_margin_req := v_exec_price * v_open_qty / p_leverage;
                v_new_balance := v_new_balance - v_margin_req;
            END IF;
            IF v_new_balance < 0 THEN
                RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance to complete this trade');
            END IF;
            v_new_qty := v_existing_qty - p_quantity;
            IF v_new_qty = 0 THEN
                DELETE FROM index_positions WHERE id = v_position.id;
            ELSIF v_new_qty > 0 THEN
                UPDATE index_positions SET quantity = v_new_qty,
                    margin_used = v_position.margin_used - v_close_margin, updated_at = NOW()
                    WHERE id = v_position.id;
            ELSE
                UPDATE index_positions SET quantity = v_new_qty, avg_entry_price = v_exec_price,
                    leverage = p_leverage, margin_used = v_exec_price * ABS(v_new_qty) / p_leverage, updated_at = NOW()
                    WHERE id = v_position.id;
            END IF;
        END IF;
    END IF;

    -- Update balance
    IF p_mode = 'REAL' THEN
        UPDATE profiles SET real_balance = v_new_balance WHERE id = p_user_id;
    ELSE
        UPDATE profiles SET virtual_balance = v_new_balance WHERE id = p_user_id;
    END IF;

    -- Log trade
    INSERT INTO trades (user_id, tea_id, index_symbol, side, quantity, price, total_value, trading_mode)
        VALUES (p_user_id, NULL, p_index_symbol, p_side, p_quantity, v_exec_price,
                v_exec_price * p_quantity, p_mode)
        RETURNING * INTO v_trade;

    -- Log spread revenue
    v_spread_cost := COALESCE(v_spread_cost, 0);
    IF v_spread_cost > 0 THEN
        INSERT INTO platform_revenue (revenue_type, trade_id, user_id, amount, symbol)
            VALUES ('spread', v_trade.id, p_user_id, v_spread_cost, p_index_symbol);
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'trade_id', v_trade.id::TEXT,
        'side', p_side,
        'symbol', p_index_symbol,
        'quantity', p_quantity,
        'market_price', p_price,
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


-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. OVERNIGHT FINANCING (SWAP FEES)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION apply_overnight_financing()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_annual_rate NUMERIC;
    v_daily_rate  NUMERIC;
    v_pos         RECORD;
    v_tea         RECORD;
    v_idx         RECORD;
    v_notional    NUMERIC;
    v_fee         NUMERIC;
    v_total_fees  NUMERIC := 0;
    v_count       INT := 0;
BEGIN
    SELECT value INTO v_annual_rate FROM platform_config WHERE key = 'annual_swap_rate';
    v_annual_rate := COALESCE(v_annual_rate, 0.05);
    v_daily_rate  := v_annual_rate / 365.0;

    -- Tea positions
    FOR v_pos IN
        SELECT p.*, t.current_price, t.symbol AS tea_symbol
        FROM positions p
        JOIN teas t ON t.id = p.tea_id
        WHERE p.quantity != 0
    LOOP
        v_notional := ABS(v_pos.quantity) * v_pos.current_price;
        v_fee      := v_notional * v_daily_rate;

        IF v_pos.trading_mode = 'REAL' THEN
            UPDATE profiles SET real_balance = real_balance - v_fee WHERE id = v_pos.user_id;
        ELSE
            UPDATE profiles SET virtual_balance = virtual_balance - v_fee WHERE id = v_pos.user_id;
        END IF;

        INSERT INTO financing_history (user_id, position_type, symbol, notional_value, fee, rate, trading_mode)
            VALUES (v_pos.user_id, 'tea', v_pos.tea_symbol, v_notional, v_fee, v_daily_rate, v_pos.trading_mode);

        INSERT INTO platform_revenue (revenue_type, user_id, amount, symbol)
            VALUES ('swap', v_pos.user_id, v_fee, v_pos.tea_symbol);

        v_total_fees := v_total_fees + v_fee;
        v_count := v_count + 1;
    END LOOP;

    -- Index positions
    FOR v_pos IN
        SELECT ip.*, i.teas AS idx_teas
        FROM index_positions ip
        JOIN indexes i ON i.symbol = ip.index_symbol
        WHERE ip.quantity != 0
    LOOP
        v_notional := ABS(v_pos.quantity) * v_pos.avg_entry_price;
        v_fee      := v_notional * v_daily_rate;

        IF v_pos.trading_mode = 'REAL' THEN
            UPDATE profiles SET real_balance = real_balance - v_fee WHERE id = v_pos.user_id;
        ELSE
            UPDATE profiles SET virtual_balance = virtual_balance - v_fee WHERE id = v_pos.user_id;
        END IF;

        INSERT INTO financing_history (user_id, position_type, symbol, notional_value, fee, rate, trading_mode)
            VALUES (v_pos.user_id, 'index', v_pos.index_symbol, v_notional, v_fee, v_daily_rate, v_pos.trading_mode);

        INSERT INTO platform_revenue (revenue_type, user_id, amount, symbol)
            VALUES ('swap', v_pos.user_id, v_fee, v_pos.index_symbol);

        v_total_fees := v_total_fees + v_fee;
        v_count := v_count + 1;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'positions_charged', v_count, 'total_fees', v_total_fees);
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. STOP-OUT PROTECTION
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION check_stop_outs()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user        RECORD;
    v_stop_level  NUMERIC;
    v_bal         NUMERIC;
    v_used_margin NUMERIC;
    v_unrealized  NUMERIC;
    v_equity      NUMERIC;
    v_pos         RECORD;
    v_close_pnl   NUMERIC;
    v_spread      NUMERIC;
    v_liquidated  INT := 0;
BEGIN
    SELECT value INTO v_stop_level FROM platform_config WHERE key = 'stop_out_level';
    v_stop_level := COALESCE(v_stop_level, 0.50);

    SELECT value INTO v_spread FROM platform_config WHERE key = 'spread_pct';
    v_spread := COALESCE(v_spread, 0.01);

    FOR v_user IN
        SELECT DISTINCT user_id, trading_mode FROM (
            SELECT user_id, trading_mode FROM positions WHERE quantity != 0
            UNION
            SELECT user_id, trading_mode FROM index_positions WHERE quantity != 0
        ) AS active_users
    LOOP
        -- Get balance
        SELECT CASE WHEN v_user.trading_mode = 'REAL' THEN real_balance ELSE virtual_balance END
            INTO v_bal FROM profiles WHERE id = v_user.user_id;

        -- Sum used margin
        SELECT COALESCE(SUM(margin_used), 0) INTO v_used_margin
            FROM (
                SELECT margin_used FROM positions WHERE user_id = v_user.user_id AND trading_mode = v_user.trading_mode AND quantity != 0
                UNION ALL
                SELECT margin_used FROM index_positions WHERE user_id = v_user.user_id AND trading_mode = v_user.trading_mode AND quantity != 0
            ) AS margins;

        IF v_used_margin <= 0 THEN CONTINUE; END IF;

        -- Sum unrealized P&L (tea positions)
        SELECT COALESCE(SUM(
            CASE WHEN p.quantity > 0
                THEN (t.current_price * (1 - v_spread/2) - p.avg_entry_price) * p.quantity
                ELSE (p.avg_entry_price - t.current_price * (1 + v_spread/2)) * ABS(p.quantity)
            END
        ), 0) INTO v_unrealized
        FROM positions p JOIN teas t ON t.id = p.tea_id
        WHERE p.user_id = v_user.user_id AND p.trading_mode = v_user.trading_mode AND p.quantity != 0;

        v_equity := v_bal + v_unrealized;

        -- Check stop-out condition
        IF v_equity < v_used_margin * v_stop_level THEN
            -- Liquidate all tea positions
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

            -- Liquidate all index positions
            FOR v_pos IN
                SELECT ip.*
                FROM index_positions ip
                WHERE ip.user_id = v_user.user_id AND ip.trading_mode = v_user.trading_mode AND ip.quantity != 0
            LOOP
                v_bal := v_bal + v_pos.margin_used;

                INSERT INTO trades (user_id, tea_id, index_symbol, side, quantity, price, total_value, trading_mode)
                    VALUES (v_pos.user_id, NULL, v_pos.index_symbol,
                            CASE WHEN v_pos.quantity > 0 THEN 'SELL' ELSE 'BUY' END,
                            ABS(v_pos.quantity), v_pos.avg_entry_price,
                            ABS(v_pos.quantity) * v_pos.avg_entry_price, v_user.trading_mode);

                DELETE FROM index_positions WHERE id = v_pos.id;
            END LOOP;

            -- Update final balance
            IF v_user.trading_mode = 'REAL' THEN
                UPDATE profiles SET real_balance = GREATEST(v_bal, 0) WHERE id = v_user.user_id;
            ELSE
                UPDATE profiles SET virtual_balance = GREATEST(v_bal, 0) WHERE id = v_user.user_id;
            END IF;

            v_liquidated := v_liquidated + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'users_liquidated', v_liquidated);
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. pg_cron for overnight financing (22:00 GMT daily)
-- ═══════════════════════════════════════════════════════════════════════════════
SELECT cron.schedule(
    'nightly-swap-fees',
    '0 22 * * *',
    $$SELECT apply_overnight_financing()$$
);
