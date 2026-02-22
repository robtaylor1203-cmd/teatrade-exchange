-- =============================================
-- TeaTrade Exchange - Database Migration (Golden Master)
-- Fully Idempotent: safe to run multiple times.
-- =============================================

-- 0. ANCHOR PRICE AUDIT LOG (M4 Fix)
-- Records every change to a tea's anchor_price for regulatory traceability.
CREATE TABLE IF NOT EXISTS anchor_price_audit (
    id BIGSERIAL PRIMARY KEY,
    tea_id INT NOT NULL,
    tea_symbol TEXT NOT NULL,
    old_anchor_price NUMERIC,
    new_anchor_price NUMERIC,
    old_reference_forex NUMERIC,
    new_reference_forex NUMERIC,
    changed_by TEXT DEFAULT 'watchdog',
    source_file TEXT,
    changed_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE anchor_price_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anchor audit read" ON anchor_price_audit;
CREATE POLICY "Anchor audit read" ON anchor_price_audit FOR SELECT USING (true);

DROP POLICY IF EXISTS "Anchor audit insert" ON anchor_price_audit;
DROP POLICY IF EXISTS "Anchor audit update" ON anchor_price_audit;
DROP POLICY IF EXISTS "Anchor audit delete" ON anchor_price_audit;

CREATE INDEX IF NOT EXISTS idx_anchor_audit_tea ON anchor_price_audit (tea_symbol, changed_at DESC);

-- Trigger function: fires AFTER UPDATE on teas when anchor_price changes
CREATE OR REPLACE FUNCTION log_anchor_price_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF OLD.anchor_price IS DISTINCT FROM NEW.anchor_price
       OR OLD.reference_forex IS DISTINCT FROM NEW.reference_forex THEN
        INSERT INTO anchor_price_audit
            (tea_id, tea_symbol, old_anchor_price, new_anchor_price,
             old_reference_forex, new_reference_forex, changed_by)
        VALUES
            (NEW.id, NEW.symbol, OLD.anchor_price, NEW.anchor_price,
             OLD.reference_forex, NEW.reference_forex, 'trigger');
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_anchor_price_audit ON teas;
CREATE TRIGGER trg_anchor_price_audit
    AFTER UPDATE ON teas
    FOR EACH ROW
    EXECUTE FUNCTION log_anchor_price_change();

-- 1. INDEXES table
CREATE TABLE IF NOT EXISTS indexes (
    id SERIAL PRIMARY KEY,
    symbol TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    teas TEXT[] NOT NULL,
    color TEXT DEFAULT 'var(--accent-green)',
    currency TEXT DEFAULT '$',
    multiplier NUMERIC DEFAULT 1,
    is_market_card BOOLEAN DEFAULT FALSE,
    display_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE indexes ENABLE ROW LEVEL SECURITY;

-- C6 FIX: indexes is a read-only reference table for clients.
DROP POLICY IF EXISTS "Public read access" ON indexes;
CREATE POLICY "Public read access" ON indexes FOR SELECT USING (true);
DROP POLICY IF EXISTS "Indexes insert" ON indexes;
DROP POLICY IF EXISTS "Indexes update" ON indexes;
DROP POLICY IF EXISTS "Indexes delete" ON indexes;

INSERT INTO indexes (symbol, name, teas, color, display_order) VALUES
    ('KENYA',  'Kenya Tea Index',   ARRAY['KEN-BP1', 'KEN-PF1', 'KEN-DUST'], 'var(--accent-green)', 1),
    ('INDIA',  'India Tea Index',   ARRAY['IND-ASM', 'IND-DRJ'],             'var(--accent-orange)', 2),
    ('CEYLON', 'Ceylon Tea Index',  ARRAY['SRI-BOP', 'SRI-PEK'],             'var(--accent-purple)', 3),
    ('CHINA',  'China Tea Index',   ARRAY['CHN-YUN'],                        'var(--accent-red)', 4),
    ('AFRICA', 'African Tea Index', ARRAY['KEN-BP1', 'KEN-PF1', 'MLW-BP1', 'RWA-OP'], 'var(--accent-green)', 5),
    ('ASIA',   'Asian Tea Index',   ARRAY['IND-ASM', 'IND-DRJ', 'SRI-BOP', 'SRI-PEK', 'CHN-YUN'], 'var(--accent-blue)', 6)
ON CONFLICT (symbol) DO NOTHING;

INSERT INTO indexes (symbol, name, teas, color, currency, multiplier, is_market_card, display_order) VALUES
    ('MOMBASA',  'Mombasa Auction Index', ARRAY['KEN-BP1', 'KEN-PF1', 'KEN-DUST'], 'var(--accent-green)', '$', 1,    TRUE, 10),
    ('KOLKATA',  'Kolkata Tea Index',     ARRAY['IND-ASM', 'IND-DRJ'],               'var(--accent-orange)', '₹', 83,  TRUE, 11),
    ('COLOMBO',  'Colombo Index',         ARRAY['SRI-BOP', 'SRI-PEK'],               'var(--accent-purple)', '$', 1,   TRUE, 12),
    ('FUTURES',  'Global Tea Futures',    ARRAY['KEN-BP1', 'IND-ASM', 'SRI-BOP', 'CHN-YUN', 'IND-DRJ'], 'var(--accent-blue)', '$', 1000, TRUE, 13)
ON CONFLICT (symbol) DO NOTHING;


-- 2. INDEX_PAIRS table
CREATE TABLE IF NOT EXISTS index_pairs (
    id TEXT PRIMARY KEY,
    base_symbol TEXT NOT NULL REFERENCES indexes(symbol),
    quote_symbol TEXT NOT NULL REFERENCES indexes(symbol),
    is_index BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE index_pairs ENABLE ROW LEVEL SECURITY;

-- C6 FIX: index_pairs is a read-only reference table for clients.
DROP POLICY IF EXISTS "Public read access" ON index_pairs;
CREATE POLICY "Public read access" ON index_pairs FOR SELECT USING (true);
DROP POLICY IF EXISTS "Index pairs insert" ON index_pairs;
DROP POLICY IF EXISTS "Index pairs update" ON index_pairs;
DROP POLICY IF EXISTS "Index pairs delete" ON index_pairs;

INSERT INTO index_pairs (id, base_symbol, quote_symbol) VALUES
    ('idx-kenya-india',  'KENYA',  'INDIA'),
    ('idx-india-ceylon', 'INDIA',  'CEYLON'),
    ('idx-africa-asia',  'AFRICA', 'ASIA'),
    ('idx-kenya-ceylon', 'KENYA',  'CEYLON'),
    ('idx-china-india',  'CHINA',  'INDIA')
ON CONFLICT (id) DO NOTHING;


-- 3. ORIGINS table
CREATE TABLE IF NOT EXISTS origins (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    display_order INT DEFAULT 0
);

ALTER TABLE origins ENABLE ROW LEVEL SECURITY;

-- C6 FIX: origins is a read-only reference table for clients.
DROP POLICY IF EXISTS "Public read access" ON origins;
CREATE POLICY "Public read access" ON origins FOR SELECT USING (true);
DROP POLICY IF EXISTS "Origins insert" ON origins;
DROP POLICY IF EXISTS "Origins update" ON origins;
DROP POLICY IF EXISTS "Origins delete" ON origins;

INSERT INTO origins (code, name, display_order) VALUES
    ('KEN', 'Kenya',     1),
    ('IND', 'India',     2),
    ('SRI', 'Sri Lanka', 3),
    ('CHN', 'China',     4),
    ('JPN', 'Japan',     5),
    ('MLW', 'Malawi',    6),
    ('RWA', 'Rwanda',    7)
ON CONFLICT (code) DO NOTHING;


-- 4. PRICE HISTORY table
CREATE TABLE IF NOT EXISTS price_history (
    id          BIGSERIAL PRIMARY KEY,
    symbol      TEXT NOT NULL,
    price       NUMERIC NOT NULL,
    volume      NUMERIC DEFAULT 0,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read access" ON price_history;
CREATE POLICY "Public read access" ON price_history FOR SELECT USING (true);

-- C5 FIX: Remove the permissive INSERT policy. Only the service_role key
-- (used by Edge Functions) can insert. service_role bypasses RLS entirely,
-- so no INSERT policy is needed for it. Removing this blocks authenticated users.
DROP POLICY IF EXISTS "Service insert" ON price_history;

-- Safe Constraint Creation
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'price_history_symbol_recorded_at_key') THEN
        ALTER TABLE price_history ADD CONSTRAINT price_history_symbol_recorded_at_key UNIQUE (symbol, recorded_at);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_price_history_symbol_time ON price_history (symbol, recorded_at DESC);

-- M2 FIX: Price history data retention function.
-- Retains granular (1-min) data for 90 days; rolls older data into
-- hourly OHLC summaries in a separate table, then purges the raw rows.
CREATE TABLE IF NOT EXISTS price_history_daily (
    id          BIGSERIAL PRIMARY KEY,
    symbol      TEXT NOT NULL,
    bucket_hour TIMESTAMPTZ NOT NULL,
    open_price  NUMERIC NOT NULL,
    high_price  NUMERIC NOT NULL,
    low_price   NUMERIC NOT NULL,
    close_price NUMERIC NOT NULL,
    tick_count  INT NOT NULL DEFAULT 1,
    UNIQUE (symbol, bucket_hour)
);

CREATE INDEX IF NOT EXISTS idx_phd_symbol_hour ON price_history_daily (symbol, bucket_hour DESC);

-- purge_old_price_history is intentionally a no-op.
-- Price history is the permanent, immutable audit trail of every price tick
-- and must never be deleted. This stub replaces the old function that deleted
-- rows older than p_retention_days to prevent accidental data loss.
CREATE OR REPLACE FUNCTION purge_old_price_history(
    p_retention_days INT DEFAULT 90
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN jsonb_build_object(
        'success', true,
        'message', 'Price history is permanent and is never purged.',
        'deleted_rows', 0
    );
END;
$$;


-- 5. CHAT MESSAGES Updates
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS recipient_name TEXT;


-- 6. TEAS Updates
ALTER TABLE teas ADD COLUMN IF NOT EXISTS anchor_price    NUMERIC;
ALTER TABLE teas ADD COLUMN IF NOT EXISTS reference_forex NUMERIC;
ALTER TABLE teas ADD COLUMN IF NOT EXISTS beta            NUMERIC DEFAULT 1.0;
ALTER TABLE teas ADD COLUMN IF NOT EXISTS last_update     TIMESTAMPTZ;
ALTER TABLE teas ADD COLUMN IF NOT EXISTS currency_pair   TEXT DEFAULT 'usd_kes';

-- 6b. RISK MANAGEMENT COLUMNS (FCA-compliant house protection)
ALTER TABLE teas ADD COLUMN IF NOT EXISTS trading_mode          TEXT    DEFAULT 'FULL';
ALTER TABLE teas ADD COLUMN IF NOT EXISTS max_exposure          NUMERIC DEFAULT 500000;
ALTER TABLE teas ADD COLUMN IF NOT EXISTS current_long_volume   NUMERIC DEFAULT 0;
ALTER TABLE teas ADD COLUMN IF NOT EXISTS current_short_volume  NUMERIC DEFAULT 0;
ALTER TABLE teas ADD COLUMN IF NOT EXISTS base_spread           NUMERIC DEFAULT 0.01;
ALTER TABLE teas ADD COLUMN IF NOT EXISTS volatility_multiplier NUMERIC DEFAULT 1.0;
ALTER TABLE teas ADD COLUMN IF NOT EXISTS halt_until            TIMESTAMPTZ;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teas_trading_mode_valid') THEN
        ALTER TABLE teas ADD CONSTRAINT teas_trading_mode_valid
            CHECK (trading_mode IN ('FULL', 'CLOSE_ONLY', 'HALTED'));
    END IF;
END $$;

-- Backfill data safely
UPDATE teas
SET anchor_price    = current_price,
    reference_forex = 129.45,
    beta            = 1.0,
    last_update     = NOW()
WHERE anchor_price IS NULL;


-- 7. MARKET STATE table
CREATE TABLE IF NOT EXISTS market_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Safe Column Migration (Numeric -> Text)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'market_state' AND column_name = 'value' AND data_type = 'numeric'
    ) THEN
        ALTER TABLE market_state ALTER COLUMN value TYPE TEXT USING value::TEXT;
    END IF;
END $$;

ALTER TABLE market_state ENABLE ROW LEVEL SECURITY;

-- C6 FIX: market_state is read-only for clients. Edge Functions use service_role.
DROP POLICY IF EXISTS "Public read access" ON market_state;
CREATE POLICY "Public read access" ON market_state FOR SELECT USING (true);
DROP POLICY IF EXISTS "Market state insert" ON market_state;
DROP POLICY IF EXISTS "Market state update" ON market_state;
DROP POLICY IF EXISTS "Market state delete" ON market_state;

INSERT INTO market_state (key, value) VALUES
    ('usd_kes',      '129.45'),
    ('usd_inr',      '87.50'),
    ('usd_lkr',      '305.00'),
    ('usd_cny',      '7.24'),
    ('brent_crude',  '82.40'),
    ('data_source',  'SIMULATED'),
    ('last_tick',    '')
ON CONFLICT (key) DO NOTHING;


-- 8. SMART REALTIME ACTIVATION
DO $$
BEGIN
    -- Check 'teas'
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'teas') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE teas;
    END IF;

    -- Check 'market_state'
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'market_state') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE market_state;
    END IF;
END $$;


-- 9. ROW LEVEL SECURITY (Hardened for real-money compliance)
-- =============================================================
-- PRINCIPLE: The frontend (anon/authenticated roles) should ONLY be able
-- to READ its own financial data. ALL writes to financial tables go through
-- SECURITY DEFINER functions (which bypass RLS via the function owner).
-- The service_role key (used by Edge Functions) also bypasses RLS.

-- ── PROFILES ─────────────────────────────────────────────────────────
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own profile" ON profiles;
DROP POLICY IF EXISTS "profiles_public_read" ON profiles;
CREATE POLICY "profiles_public_read" ON profiles FOR SELECT TO authenticated USING (true);

-- C1 FIX: Users can update display fields (username, avatar, etc.) but NOT cash_balance.
-- The column-level REVOKE below prevents cash_balance manipulation from the client.
DROP POLICY IF EXISTS "Users update own profile" ON profiles;
CREATE POLICY "Users update own profile" ON profiles
    FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users insert own profile" ON profiles;
CREATE POLICY "Users insert own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- C1 FIX: Revoke direct UPDATE on cash_balance from frontend roles.
-- Only SECURITY DEFINER functions (execute_trade, reset_account) can modify it.
REVOKE UPDATE (cash_balance) ON profiles FROM anon, authenticated;

-- ── TEAS (read-only reference table) ─────────────────────────────────
-- C6 FIX: Only SELECT allowed. No INSERT/UPDATE/DELETE policies for users.
ALTER TABLE teas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read teas" ON teas;
CREATE POLICY "Public read teas" ON teas FOR SELECT USING (true);

-- ── POSITIONS (server-managed only) ──────────────────────────────────
-- C2 FIX: Remove all INSERT/UPDATE/DELETE policies. Users can only READ.
-- The execute_trade() SECURITY DEFINER function manages positions.
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own positions" ON positions;
CREATE POLICY "Users read own positions" ON positions FOR SELECT USING (auth.uid() = user_id);

-- Remove dangerous client-writable policies
DROP POLICY IF EXISTS "Users insert own positions" ON positions;
DROP POLICY IF EXISTS "Users update own positions" ON positions;
DROP POLICY IF EXISTS "Users delete own positions" ON positions;

-- ── INDEX POSITIONS (server-managed only) ────────────────────────────
-- C2 FIX: Same treatment as positions - read-only for clients.
ALTER TABLE index_positions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own index positions" ON index_positions;
CREATE POLICY "Users read own index positions" ON index_positions FOR SELECT USING (auth.uid() = user_id);

-- Remove dangerous client-writable policies
DROP POLICY IF EXISTS "Users insert own index positions" ON index_positions;
DROP POLICY IF EXISTS "Users update own index positions" ON index_positions;
DROP POLICY IF EXISTS "Users delete own index positions" ON index_positions;

-- ── TRADES (immutable audit trail - server-managed only) ─────────────
-- C3 FIX: Remove INSERT policy. Only SECURITY DEFINER functions can insert.
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own trades" ON trades;
CREATE POLICY "Users read own trades" ON trades FOR SELECT USING (auth.uid() = user_id);

-- Remove dangerous client-writable policy
DROP POLICY IF EXISTS "Users insert own trades" ON trades;

-- Chat Messages
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read public messages" ON chat_messages;
CREATE POLICY "Users read public messages" ON chat_messages
    FOR SELECT USING (
        is_private = false
        OR sender_email = (SELECT email FROM auth.users WHERE id = auth.uid())
        OR recipient_email = (SELECT email FROM auth.users WHERE id = auth.uid())
    );

DROP POLICY IF EXISTS "Users insert own messages" ON chat_messages;
CREATE POLICY "Users insert own messages" ON chat_messages
    FOR INSERT WITH CHECK (sender_email = (SELECT email FROM auth.users WHERE id = auth.uid()));

-- Tea Pairs (Safety check)
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tea_pairs') THEN
        ALTER TABLE tea_pairs ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS "Public read tea_pairs" ON tea_pairs;
        CREATE POLICY "Public read tea_pairs" ON tea_pairs FOR SELECT USING (true);
    END IF;
END $$;


-- 10. SAFETY CONSTRAINTS (Negative Balances/Qty)
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_balance_non_negative') THEN
        ALTER TABLE profiles ADD CONSTRAINT profiles_balance_non_negative CHECK (cash_balance >= 0);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'positions_quantity_positive') THEN
        ALTER TABLE positions ADD CONSTRAINT positions_quantity_positive CHECK (quantity > 0);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trades_quantity_positive') THEN
        ALTER TABLE trades ADD CONSTRAINT trades_quantity_positive CHECK (quantity > 0);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trades_price_positive') THEN
        ALTER TABLE trades ADD CONSTRAINT trades_price_positive CHECK (price > 0);
    END IF;
END $$;


-- 11. ATOMIC TRADE FUNCTION (with Risk Management)
-- Uses subqueries for tea_id to avoid type mismatch (int vs uuid) between tables.
-- Enforces: HALTED check, CLOSE_ONLY gating, exposure caps, symmetric spread,
-- and volume tracking for FCA-compliant house protection.
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

    -- Lock and fetch the tea row (looked up by symbol, not id)
    SELECT * INTO v_tea FROM teas WHERE symbol = p_tea_symbol FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Tea not found: ' || p_tea_symbol);
    END IF;

    -- ── RISK CHECK: Trading mode ──────────────────────────────────────
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

    v_is_closing := false;
    IF p_side = 'SELL' THEN
        v_is_closing := true;
    END IF;

    IF v_tea.trading_mode = 'CLOSE_ONLY' AND NOT v_is_closing THEN
        RETURN jsonb_build_object('success', false, 'error',
            'Maximum platform exposure reached for ' || p_tea_symbol || '. Only closing trades are allowed.');
    END IF;

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

        UPDATE teas SET current_long_volume = COALESCE(current_long_volume, 0) + p_quantity
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

        UPDATE teas SET current_long_volume = GREATEST(0, COALESCE(current_long_volume, 0) - p_quantity)
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


-- 12. ATOMIC INDEX TRADE FUNCTION (C4 FIX)
-- The server provides the mid price — spread is applied server-side.
CREATE OR REPLACE FUNCTION execute_index_trade(
    p_user_id      UUID,
    p_index_symbol TEXT,
    p_side         TEXT,
    p_quantity     NUMERIC,
    p_price        NUMERIC
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
    v_spread_cost  NUMERIC;
    v_total        NUMERIC;
    v_new_balance  NUMERIC;
    v_new_qty      NUMERIC;
    v_new_avg      NUMERIC;
BEGIN
    IF p_side NOT IN ('BUY', 'SELL') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid side: must be BUY or SELL');
    END IF;
    IF p_quantity <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Quantity must be greater than zero');
    END IF;
    IF p_price IS NULL OR p_price <= 0 OR p_price != p_price OR p_price > 1e15 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid price');
    END IF;

    -- Verify the index exists
    IF NOT EXISTS (SELECT 1 FROM indexes WHERE symbol = p_index_symbol) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Index not found: ' || p_index_symbol);
    END IF;

    -- Symmetric spread (1% default, same as tea base_spread)
    v_spread := 0.01;
    IF p_side = 'BUY' THEN
        v_exec_price := p_price * (1.0 + v_spread / 2.0);
    ELSE
        v_exec_price := p_price * (1.0 - v_spread / 2.0);
    END IF;
    v_spread_cost := ABS(v_exec_price - p_price) * p_quantity;

    v_total := v_exec_price * p_quantity;

    -- Lock user profile
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

        SELECT * INTO v_position FROM index_positions
            WHERE user_id = p_user_id AND index_symbol = p_index_symbol
            FOR UPDATE;

        IF FOUND THEN
            v_new_qty := v_position.quantity + p_quantity;
            v_new_avg := ((v_position.avg_entry_price * v_position.quantity) + (v_exec_price * p_quantity)) / v_new_qty;
            UPDATE index_positions
                SET quantity = v_new_qty, avg_entry_price = v_new_avg, updated_at = NOW()
                WHERE id = v_position.id;
        ELSE
            INSERT INTO index_positions (user_id, index_symbol, quantity, avg_entry_price)
                VALUES (p_user_id, p_index_symbol, p_quantity, v_exec_price);
        END IF;

    -- ── SELL ────────────────────────────────────────────────────────
    ELSIF p_side = 'SELL' THEN
        SELECT * INTO v_position FROM index_positions
            WHERE user_id = p_user_id AND index_symbol = p_index_symbol
            FOR UPDATE;

        IF NOT FOUND OR v_position.quantity < p_quantity THEN
            RETURN jsonb_build_object('success', false, 'error',
                'Insufficient index holdings. Have ' || COALESCE(v_position.quantity, 0) || ' kg');
        END IF;

        v_new_balance := v_profile.cash_balance + v_total;
        UPDATE profiles SET cash_balance = v_new_balance WHERE id = p_user_id;

        v_new_qty := v_position.quantity - p_quantity;
        IF v_new_qty <= 0 THEN
            DELETE FROM index_positions WHERE id = v_position.id;
        ELSE
            UPDATE index_positions
                SET quantity = v_new_qty, updated_at = NOW()
                WHERE id = v_position.id;
        END IF;
    END IF;

    -- ── RECORD TRADE ────────────────────────────────────────────────
    INSERT INTO trades (user_id, tea_id, index_symbol, side, quantity, price, total_value)
        VALUES (p_user_id, NULL, p_index_symbol, p_side, p_quantity, v_exec_price, v_total)
        RETURNING * INTO v_trade;

    RETURN jsonb_build_object(
        'success',          true,
        'trade_id',         v_trade.id::TEXT,
        'side',             p_side,
        'symbol',           p_index_symbol,
        'quantity',         p_quantity,
        'price',            v_exec_price,
        'mid_price',        p_price,
        'spread',           v_spread,
        'spread_cost',      v_spread_cost,
        'total',            v_total,
        'new_balance',      v_new_balance,
        'execution_price',  v_exec_price
    );
END;
$$;


-- 13. ATOMIC PAIR TRADE CLOSE FUNCTION (C4 FIX)
CREATE OR REPLACE FUNCTION close_pair_trade(
    p_user_id    UUID,
    p_trade_id   TEXT,
    p_exit_ratio NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_trade        RECORD;
    v_profile      RECORD;
    v_close_trade  RECORD;
    v_margin       NUMERIC;
    v_pnl          NUMERIC;
    v_direction    INT;
    v_ratio_change NUMERIC;
    v_return_amt   NUMERIC;
    v_new_balance  NUMERIC;
    v_leverage     NUMERIC;
BEGIN
    IF p_exit_ratio IS NULL OR p_exit_ratio <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid exit ratio');
    END IF;

    -- Lock and fetch original trade
    SELECT * INTO v_trade FROM trades
        WHERE id::TEXT = p_trade_id AND user_id = p_user_id
        FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Trade not found');
    END IF;

    IF NOT COALESCE(v_trade.is_pair_trade, false) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Not a pair trade');
    END IF;

    v_margin := v_trade.quantity;
    v_leverage := COALESCE(v_trade.leverage, 1);
    v_direction := CASE WHEN v_trade.side = 'BUY' THEN 1 ELSE -1 END;
    v_ratio_change := (p_exit_ratio - v_trade.price) / v_trade.price;
    v_pnl := v_margin * v_ratio_change * v_leverage * v_direction;
    v_return_amt := v_margin + v_pnl;

    -- Lock profile and update balance
    SELECT * INTO v_profile FROM profiles WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'User profile not found');
    END IF;

    v_new_balance := v_profile.cash_balance + v_return_amt;
    UPDATE profiles SET cash_balance = v_new_balance WHERE id = p_user_id;

    -- Record closing trade
    INSERT INTO trades (user_id, tea_id, index_symbol, side, quantity, price, total_value, pair_id, leverage, is_pair_trade)
        VALUES (
            p_user_id,
            v_trade.tea_id,
            v_trade.index_symbol,
            CASE WHEN v_trade.side = 'BUY' THEN 'SELL' ELSE 'BUY' END,
            v_margin,
            p_exit_ratio,
            v_return_amt,
            v_trade.pair_id,
            v_leverage,
            true
        )
        RETURNING * INTO v_close_trade;

    RETURN jsonb_build_object(
        'success',      true,
        'trade_id',     v_close_trade.id::TEXT,
        'pnl',          v_pnl,
        'return_amount', v_return_amt,
        'new_balance',  v_new_balance,
        'entry_ratio',  v_trade.price,
        'exit_ratio',   p_exit_ratio,
        'margin',       v_margin,
        'leverage',     v_leverage
    );
END;
$$;


-- 14. ACCOUNT RESET FUNCTION (SECURITY DEFINER)
-- Supports paid reset, free bailout, and combine start via p_source parameter.
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

    DELETE FROM positions WHERE user_id = p_user_id AND trading_mode = p_mode;
    DELETE FROM index_positions WHERE user_id = p_user_id AND trading_mode = p_mode;
    DELETE FROM trades WHERE user_id = p_user_id AND trading_mode = p_mode;

    IF p_mode = 'REAL' THEN
        UPDATE profiles
        SET real_balance = v_new_balance, account_status = v_new_status, next_free_reset_at = NULL
        WHERE id = p_user_id;
    ELSE
        UPDATE profiles
        SET virtual_balance = v_new_balance, account_status = v_new_status, next_free_reset_at = NULL
        WHERE id = p_user_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true, 'new_balance', v_new_balance,
        'mode', p_mode, 'source', p_source, 'status', v_new_status
    );
END;
$$;


-- 15. OPEN PAIR TRADE FUNCTION (C4 FIX)
-- Deducts margin from balance and records the pair trade atomically.
CREATE OR REPLACE FUNCTION open_pair_trade(
    p_user_id       UUID,
    p_side          TEXT,
    p_amount        NUMERIC,
    p_ratio         NUMERIC,
    p_leverage      NUMERIC,
    p_pair_id       TEXT,
    p_tea_id        INT,
    p_index_symbol  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile     RECORD;
    v_trade       RECORD;
    v_new_balance NUMERIC;
    v_total_value NUMERIC;
    v_db_side     TEXT;
BEGIN
    IF p_side NOT IN ('LONG', 'SHORT') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid side: must be LONG or SHORT');
    END IF;
    IF p_amount < 10 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Minimum position size is $10');
    END IF;
    IF p_ratio IS NULL OR p_ratio <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid ratio');
    END IF;
    IF p_leverage IS NULL OR p_leverage < 1 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid leverage');
    END IF;

    v_db_side := CASE WHEN p_side = 'LONG' THEN 'BUY' ELSE 'SELL' END;
    v_total_value := p_amount * p_leverage;

    -- Lock profile and check balance
    SELECT * INTO v_profile FROM profiles WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'User profile not found');
    END IF;

    IF v_profile.cash_balance < p_amount THEN
        RETURN jsonb_build_object('success', false, 'error',
            'Insufficient balance. Need $' || ROUND(p_amount, 2));
    END IF;

    v_new_balance := v_profile.cash_balance - p_amount;
    UPDATE profiles SET cash_balance = v_new_balance WHERE id = p_user_id;

    -- Record pair trade
    INSERT INTO trades (user_id, tea_id, index_symbol, side, quantity, price, total_value, pair_id, leverage, is_pair_trade)
        VALUES (p_user_id, p_tea_id, p_index_symbol, v_db_side, p_amount, p_ratio, v_total_value, p_pair_id::uuid, p_leverage, true)
        RETURNING * INTO v_trade;

    RETURN jsonb_build_object(
        'success',     true,
        'trade_id',    v_trade.id::TEXT,
        'new_balance', v_new_balance,
        'margin',      p_amount,
        'exposure',    v_total_value
    );
END;
$$;

-- =============================================
-- 16. PENDING ORDERS TABLE (Phase 4-16: Limit/Stop Orders)
-- =============================================
CREATE TABLE IF NOT EXISTS pending_orders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES profiles(id),
    symbol          TEXT NOT NULL,
    is_index        BOOLEAN NOT NULL DEFAULT false,
    side            TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    order_type      TEXT NOT NULL CHECK (order_type IN ('LIMIT', 'STOP')),
    quantity        NUMERIC NOT NULL CHECK (quantity > 0),
    target_price    NUMERIC NOT NULL CHECK (target_price > 0),
    margin_reserved NUMERIC NOT NULL DEFAULT 0 CHECK (margin_reserved >= 0),
    status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'FILLED', 'CANCELLED', 'EXPIRED')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    filled_at       TIMESTAMPTZ,
    fill_price      NUMERIC,
    expires_at      TIMESTAMPTZ
);

ALTER TABLE pending_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own orders" ON pending_orders;
CREATE POLICY "Users read own orders" ON pending_orders FOR SELECT USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_pending_orders_user ON pending_orders (user_id, status);
CREATE INDEX IF NOT EXISTS idx_pending_orders_active ON pending_orders (status, symbol) WHERE status = 'PENDING';

-- =============================================
-- 17. PLACE ORDER FUNCTION
-- =============================================
CREATE OR REPLACE FUNCTION place_order(
    p_user_id       UUID,
    p_symbol        TEXT,
    p_is_index      BOOLEAN,
    p_side          TEXT,
    p_order_type    TEXT,
    p_quantity      NUMERIC,
    p_target_price  NUMERIC,
    p_expires_hours INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile       RECORD;
    v_margin        NUMERIC;
    v_new_balance   NUMERIC;
    v_order         RECORD;
    v_expires_at    TIMESTAMPTZ;
BEGIN
    IF p_side NOT IN ('BUY', 'SELL') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Side must be BUY or SELL');
    END IF;
    IF p_order_type NOT IN ('LIMIT', 'STOP') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Order type must be LIMIT or STOP');
    END IF;
    IF p_quantity <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Quantity must be positive');
    END IF;
    IF p_target_price <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Price must be positive');
    END IF;

    SELECT * INTO v_profile FROM profiles WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Profile not found');
    END IF;

    v_margin := 0;
    IF p_side = 'BUY' THEN
        v_margin := p_quantity * p_target_price;
        IF v_profile.cash_balance < v_margin THEN
            RETURN jsonb_build_object('success', false, 'error',
                'Insufficient balance. Need $' || ROUND(v_margin, 2) || ' (have $' || ROUND(v_profile.cash_balance, 2) || ')');
        END IF;
        v_new_balance := v_profile.cash_balance - v_margin;
        UPDATE profiles SET cash_balance = v_new_balance WHERE id = p_user_id;
    END IF;

    IF p_expires_hours IS NOT NULL AND p_expires_hours > 0 THEN
        v_expires_at := NOW() + (p_expires_hours || ' hours')::INTERVAL;
    END IF;

    INSERT INTO pending_orders (user_id, symbol, is_index, side, order_type, quantity, target_price, margin_reserved, expires_at)
        VALUES (p_user_id, p_symbol, p_is_index, p_side, p_order_type, p_quantity, p_target_price, v_margin, v_expires_at)
        RETURNING * INTO v_order;

    RETURN jsonb_build_object(
        'success',          true,
        'order_id',         v_order.id::TEXT,
        'margin_reserved',  v_margin,
        'new_balance',      COALESCE(v_new_balance, v_profile.cash_balance)
    );
END;
$$;

-- =============================================
-- 18. CANCEL ORDER FUNCTION
-- =============================================
CREATE OR REPLACE FUNCTION cancel_order(
    p_user_id   UUID,
    p_order_id  UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_order     RECORD;
    v_profile   RECORD;
    v_new_bal   NUMERIC;
BEGIN
    SELECT * INTO v_order FROM pending_orders WHERE id = p_order_id AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Order not found');
    END IF;
    IF v_order.status <> 'PENDING' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Order is already ' || v_order.status);
    END IF;

    UPDATE pending_orders SET status = 'CANCELLED' WHERE id = p_order_id;

    IF v_order.margin_reserved > 0 THEN
        SELECT * INTO v_profile FROM profiles WHERE id = p_user_id FOR UPDATE;
        v_new_bal := v_profile.cash_balance + v_order.margin_reserved;
        UPDATE profiles SET cash_balance = v_new_bal WHERE id = p_user_id;
    ELSE
        SELECT cash_balance INTO v_new_bal FROM profiles WHERE id = p_user_id;
    END IF;

    RETURN jsonb_build_object(
        'success',     true,
        'refunded',    v_order.margin_reserved,
        'new_balance', v_new_bal
    );
END;
$$;

-- =============================================
-- 19. FILL PENDING ORDERS (called by market-ticker)
-- =============================================
CREATE OR REPLACE FUNCTION fill_pending_orders()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_order         RECORD;
    v_current_price NUMERIC;
    v_should_fill   BOOLEAN;
    v_trade_result  JSONB;
    v_filled_count  INT := 0;
    v_margin_diff   NUMERIC;
BEGIN
    FOR v_order IN
        SELECT po.*, COALESCE(
            (SELECT t.current_price FROM teas t WHERE t.symbol = po.symbol),
            (SELECT ph.price FROM price_history ph WHERE ph.symbol = po.symbol ORDER BY ph.recorded_at DESC LIMIT 1)
        ) AS market_price
        FROM pending_orders po
        WHERE po.status = 'PENDING'
          AND (po.expires_at IS NULL OR po.expires_at > NOW())
        ORDER BY po.created_at
        FOR UPDATE OF po
    LOOP
        v_current_price := v_order.market_price;
        IF v_current_price IS NULL OR v_current_price <= 0 THEN CONTINUE; END IF;

        v_should_fill := false;
        IF v_order.order_type = 'LIMIT' AND v_order.side = 'BUY' AND v_current_price <= v_order.target_price THEN
            v_should_fill := true;
        ELSIF v_order.order_type = 'LIMIT' AND v_order.side = 'SELL' AND v_current_price >= v_order.target_price THEN
            v_should_fill := true;
        ELSIF v_order.order_type = 'STOP' AND v_order.side = 'BUY' AND v_current_price >= v_order.target_price THEN
            v_should_fill := true;
        ELSIF v_order.order_type = 'STOP' AND v_order.side = 'SELL' AND v_current_price <= v_order.target_price THEN
            v_should_fill := true;
        END IF;

        IF NOT v_should_fill THEN CONTINUE; END IF;

        IF v_order.is_index THEN
            SELECT execute_index_trade(v_order.user_id, v_order.symbol, v_order.side, v_order.quantity, v_current_price) INTO v_trade_result;
        ELSE
            -- For BUY orders: margin was already reserved, so refund it first so execute_trade can re-deduct at market price
            IF v_order.side = 'BUY' AND v_order.margin_reserved > 0 THEN
                UPDATE profiles SET cash_balance = cash_balance + v_order.margin_reserved WHERE id = v_order.user_id;
            END IF;
            SELECT execute_trade(v_order.user_id, v_order.symbol, v_order.side, v_order.quantity) INTO v_trade_result;
        END IF;

        IF (v_trade_result->>'success')::boolean THEN
            UPDATE pending_orders
            SET status = 'FILLED', filled_at = NOW(), fill_price = v_current_price
            WHERE id = v_order.id;
            v_filled_count := v_filled_count + 1;
        ELSE
            -- Fill failed (e.g. insufficient holdings for SELL) — refund margin for BUY that was restored then failed
            IF v_order.side = 'BUY' AND v_order.margin_reserved > 0 AND NOT v_order.is_index THEN
                UPDATE profiles SET cash_balance = cash_balance - v_order.margin_reserved + v_order.margin_reserved WHERE id = v_order.user_id;
            END IF;
        END IF;
    END LOOP;

    -- Expire overdue orders and refund margin
    FOR v_order IN
        SELECT * FROM pending_orders
        WHERE status = 'PENDING' AND expires_at IS NOT NULL AND expires_at <= NOW()
        FOR UPDATE
    LOOP
        UPDATE pending_orders SET status = 'EXPIRED' WHERE id = v_order.id;
        IF v_order.margin_reserved > 0 THEN
            UPDATE profiles SET cash_balance = cash_balance + v_order.margin_reserved WHERE id = v_order.user_id;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('filled', v_filled_count);
END;
$$;

-- =============================================
-- 20. SETTLEMENT (Phase 4-17)
-- Adds settlement tracking to trades table and
-- a function to process T+0 instant settlement.
-- =============================================

-- Add settlement columns to trades (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='trades' AND column_name='settlement_status') THEN
        ALTER TABLE trades ADD COLUMN settlement_status TEXT NOT NULL DEFAULT 'PENDING'
            CHECK (settlement_status IN ('PENDING', 'SETTLED', 'FAILED'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='trades' AND column_name='settled_at') THEN
        ALTER TABLE trades ADD COLUMN settled_at TIMESTAMPTZ;
    END IF;
END
$$;

-- Backfill existing trades as SETTLED (they were already processed)
UPDATE trades SET settlement_status = 'SETTLED', settled_at = created_at
WHERE settlement_status = 'PENDING';

-- Auto-settle all new trades immediately on insert (T+0 instant settlement)
CREATE OR REPLACE FUNCTION auto_settle_trade()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    NEW.settlement_status := 'SETTLED';
    NEW.settled_at := NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_settle ON trades;
CREATE TRIGGER trg_auto_settle
    BEFORE INSERT ON trades
    FOR EACH ROW
    EXECUTE FUNCTION auto_settle_trade();

-- Settlement summary view for audit/reporting
CREATE OR REPLACE VIEW settlement_summary AS
SELECT
    DATE_TRUNC('day', created_at) AS settlement_date,
    COUNT(*)                       AS total_trades,
    COUNT(*) FILTER (WHERE settlement_status = 'SETTLED') AS settled,
    COUNT(*) FILTER (WHERE settlement_status = 'PENDING') AS pending,
    COUNT(*) FILTER (WHERE settlement_status = 'FAILED')  AS failed,
    SUM(total_value)               AS total_notional,
    SUM(total_value) FILTER (WHERE settlement_status = 'SETTLED') AS settled_notional
FROM trades
GROUP BY DATE_TRUNC('day', created_at)
ORDER BY settlement_date DESC;

GRANT SELECT ON settlement_summary TO authenticated;

CREATE INDEX IF NOT EXISTS idx_trades_settlement ON trades (settlement_status, created_at)
    WHERE settlement_status = 'PENDING';

-- ============================================================
-- VOLATILITY CALIBRATION: beta values + currency_pair per tea
-- ============================================================
-- Beta represents forex sensitivity (how much a 1% currency move
-- affects the USD tea price). Calibrated per origin:
--   Kenya:      beta 5-7  (KES-denominated; highly sensitive)
--   India Assam: beta 5   (INR; moderate sensitivity)
--   Darjeeling:  beta 6   (INR; premium, more volatile)
--   Ceylon:      beta 7   (LKR; historically very volatile)
--   Yunnan:      beta 3   (CNY; PBoC managed float, tighter)
--   Rwanda/Malawi: beta 5 (USD-proxied but regional sensitivity)
--
-- currency_pair must match the key used in market-ticker rates map.
-- ============================================================

UPDATE teas SET beta = 6.0, currency_pair = 'usd_kes' WHERE symbol IN ('KEN-BP1', 'KEN-PF1');
UPDATE teas SET beta = 5.0, currency_pair = 'usd_kes' WHERE symbol = 'KEN-DUST';
UPDATE teas SET beta = 5.0, currency_pair = 'usd_inr' WHERE symbol = 'IND-ASM';
UPDATE teas SET beta = 6.5, currency_pair = 'usd_inr' WHERE symbol = 'IND-DRJ';
UPDATE teas SET beta = 7.0, currency_pair = 'usd_lkr' WHERE symbol IN ('SRI-BOP', 'SRI-PEK', 'SRI-OP');
UPDATE teas SET beta = 3.0, currency_pair = 'usd_cny' WHERE symbol = 'CHN-YUN';
UPDATE teas SET beta = 5.0, currency_pair = 'usd_kes' WHERE symbol IN ('RWA-OP', 'MLW-BP1');
-- Any remaining teas default to KES sensitivity
UPDATE teas SET beta = 4.0, currency_pair = 'usd_kes'
WHERE (beta IS NULL OR beta = 1.0)
  AND symbol NOT IN ('KEN-BP1','KEN-PF1','KEN-DUST','IND-ASM','IND-DRJ',
                     'SRI-BOP','SRI-PEK','SRI-OP','CHN-YUN','RWA-OP','MLW-BP1');

-- ============================================================
-- REAL AUCTION DATA SCHEMA
-- ============================================================
-- These tables store real Mombasa auction data imported from
-- the GeneralReport Excel files (per-lot) and the Auction
-- Quantity file (weekly volumes). Data can be loaded ad-hoc
-- via the import_auction_data.py script whenever a new report
-- is received.
--
-- Grade → Tea symbol mapping used throughout:
--   BP1   → KEN-BP1   (Broken Pekoe 1)
--   PF1   → KEN-PF1   (Pekoe Fannings 1)
--   DUST1 → KEN-DUST  (Dust 1)
-- These VWAP prices are written back to teas.anchor_price and
-- to price_history so that charts show real historical data.
-- ============================================================

-- One row per weekly auction sale
CREATE TABLE IF NOT EXISTS auction_sales (
    id               uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
    sale_number      integer     NOT NULL,               -- 37, 38 …
    sale_code        text        NOT NULL,               -- "Sale 37"
    sale_date        date,                               -- date of the auction session
    country          text        DEFAULT 'Kenya',
    total_lots       integer     DEFAULT 0,
    lots_sold        integer     DEFAULT 0,
    lots_unsold      integer     DEFAULT 0,
    lots_outsold     integer     DEFAULT 0,
    lots_private     integer     DEFAULT 0,
    total_weight_kg  numeric(14,2) DEFAULT 0,
    total_value      numeric(16,4) DEFAULT 0,            -- sum of lot values (USD)
    vwap_usd_per_kg  numeric(10,4),                     -- volume-weighted avg all grades
    kenya_index_price numeric(10,4),                    -- VWAP Kenya lots only → KENYA index
    pf1_vwap         numeric(10,4),                     -- → KEN-PF1 anchor
    bp1_vwap         numeric(10,4),                     -- → KEN-BP1 anchor
    dust1_vwap       numeric(10,4),                     -- → KEN-DUST anchor
    created_at       timestamptz DEFAULT now(),
    UNIQUE(sale_number)
);

-- One row per lot in each auction
CREATE TABLE IF NOT EXISTS auction_lots (
    id                    uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
    sale_id               uuid        REFERENCES auction_sales(id) ON DELETE CASCADE,
    sale_number           integer     NOT NULL,
    broker_code           text,
    lot_number            integer,
    selling_mark          text,                          -- factory / estate name
    grade                 text        NOT NULL,          -- BP1, PF1, DUST1 …
    invoice_no            text,
    sub_elevation         text,
    category              text,                          -- M1, M2, M3, S1
    rp                    text,                          -- Reprint flag
    ra                    text,                          -- Reauction flag
    certifications        text,
    bags                  integer,
    net_weight_per_bag_kg numeric(8,2),
    total_weight_kg       numeric(10,2),
    asking_price          numeric(10,4),
    baseline_price        numeric(10,4),
    registered_bid_price  numeric(10,4),
    registered_bid_buyer  text,
    second_highest_bid    numeric(10,4),
    second_highest_buyer  text,
    total_price           numeric(14,2),
    status                text,                          -- Sold / Unsold / Outsold / Private Sold
    purchased_price       numeric(10,4),                -- USD per kg (final sold price)
    buyer_code            text,
    buyer_name            text,
    factory               text,
    producer_country      text,
    warehouse_company     text,
    warehouse_location    text,
    manufactured_date     text,
    selling_end_time      timestamptz,
    producer              text,
    final_buyer_name      text,
    final_price           numeric(10,4),
    total_value           numeric(14,2),                -- USD total for this lot
    transaction_type      text,
    created_at            timestamptz DEFAULT now()
);

-- Aggregated per-grade stats per sale (fast lookup for charts / index calcs)
CREATE TABLE IF NOT EXISTS auction_grade_summary (
    id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
    sale_id         uuid        REFERENCES auction_sales(id) ON DELETE CASCADE,
    sale_number     integer     NOT NULL,
    sale_date       date,
    grade           text        NOT NULL,
    lots_sold       integer     DEFAULT 0,
    lots_unsold     integer     DEFAULT 0,
    total_weight_kg numeric(14,2) DEFAULT 0,
    vwap            numeric(10,4),                      -- volume-weighted avg price USD/kg
    avg_price       numeric(10,4),                      -- simple average
    min_price       numeric(10,4),
    max_price       numeric(10,4),
    total_value     numeric(16,4) DEFAULT 0,
    created_at      timestamptz DEFAULT now(),
    UNIQUE(sale_id, grade)
);

-- Weekly offered / sold quantities (from Auction Quantity Excel)
CREATE TABLE IF NOT EXISTS auction_weekly_volumes (
    id             uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
    sale_date      date    NOT NULL,
    sale_number    integer NOT NULL,
    year           integer NOT NULL,
    total_bags     integer,
    main_bags      integer,
    secondary_bags integer,
    kenya_bags     integer,
    foreign_bags   integer,
    reprints_bags  integer,
    fresh_bags     integer,
    created_at     timestamptz DEFAULT now(),
    UNIQUE(sale_date, year)
);

-- ============================================================
-- ROW-LEVEL SECURITY FOR AUCTION TABLES
-- ============================================================
ALTER TABLE auction_sales         ENABLE ROW LEVEL SECURITY;
ALTER TABLE auction_lots          ENABLE ROW LEVEL SECURITY;
ALTER TABLE auction_grade_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE auction_weekly_volumes ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read auction data (public market data)
DROP POLICY IF EXISTS "auction_sales_read"            ON auction_sales;
DROP POLICY IF EXISTS "auction_lots_read"             ON auction_lots;
DROP POLICY IF EXISTS "auction_grade_summary_read"    ON auction_grade_summary;
DROP POLICY IF EXISTS "auction_weekly_volumes_read"   ON auction_weekly_volumes;
DROP POLICY IF EXISTS "auction_sales_insert"          ON auction_sales;
DROP POLICY IF EXISTS "auction_lots_insert"           ON auction_lots;
DROP POLICY IF EXISTS "auction_grade_summary_insert"  ON auction_grade_summary;
DROP POLICY IF EXISTS "auction_weekly_volumes_insert" ON auction_weekly_volumes;

CREATE POLICY "auction_sales_read"
    ON auction_sales FOR SELECT TO authenticated USING (true);
CREATE POLICY "auction_lots_read"
    ON auction_lots FOR SELECT TO authenticated USING (true);
CREATE POLICY "auction_grade_summary_read"
    ON auction_grade_summary FOR SELECT TO authenticated USING (true);
CREATE POLICY "auction_weekly_volumes_read"
    ON auction_weekly_volumes FOR SELECT TO authenticated USING (true);

-- Only service role can insert / update (done via the import script)
CREATE POLICY "auction_sales_insert"
    ON auction_sales FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "auction_lots_insert"
    ON auction_lots FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "auction_grade_summary_insert"
    ON auction_grade_summary FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "auction_weekly_volumes_insert"
    ON auction_weekly_volumes FOR INSERT TO service_role WITH CHECK (true);

-- ============================================================
-- INDEXES FOR AUCTION TABLES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_auction_sales_number
    ON auction_sales (sale_number);
CREATE INDEX IF NOT EXISTS idx_auction_sales_date
    ON auction_sales (sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_auction_lots_sale
    ON auction_lots (sale_id, grade);
CREATE INDEX IF NOT EXISTS idx_auction_lots_grade
    ON auction_lots (grade, producer_country);
CREATE INDEX IF NOT EXISTS idx_auction_grade_summary_sale
    ON auction_grade_summary (sale_id);
CREATE INDEX IF NOT EXISTS idx_auction_grade_summary_date
    ON auction_grade_summary (sale_date DESC, grade);
CREATE INDEX IF NOT EXISTS idx_auction_weekly_date
    ON auction_weekly_volumes (sale_date DESC);

-- ============================================================
-- EXPANDED KENYA GRADES
-- ============================================================
-- Adds three new tradable Kenyan grades sourced directly from
-- Mombasa auction data.  Volumes from Sale 37:
--   PD    (Pekoe Dust)           – 1,674,280 kg  largest by weight
--   BMF   (Broken Mixed Fanning) –   128,956 kg
--   FNGS1 (Fannings Grade 1)     –    83,582 kg
-- ============================================================

-- ============================================================
-- SIMULATED DATA SUPPORT
-- Adds is_simulated flag to price_history so generated
-- placeholder data can be overwritten by real auction imports.
-- ============================================================
ALTER TABLE price_history ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT false;

-- Ensure a unique constraint exists on (symbol, recorded_at) so the
-- ON CONFLICT clause in apply_auction_prices_to_teas works correctly.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'price_history'::regclass
          AND contype   = 'u'
          AND conname   = 'price_history_symbol_recorded_at_key'
    ) THEN
        ALTER TABLE price_history ADD CONSTRAINT price_history_symbol_recorded_at_key UNIQUE (symbol, recorded_at);
    END IF;
END $$;

-- ============================================================
-- EXPANDED KENYA GRADES
-- ============================================================
INSERT INTO teas (symbol, name, origin, grade, current_price, anchor_price,
                  reference_forex, beta, currency_pair, last_update)
VALUES
    ('KEN-PD',   'Kenya Pekoe Dust',           'KEN', 'PD',    1.9762, 1.9762, 129.45, 5.5, 'usd_kes', now()),
    ('KEN-BMF',  'Kenya Broken Mixed Fanning',  'KEN', 'BMF',   0.9680, 0.9680, 129.45, 5.0, 'usd_kes', now()),
    ('KEN-FNGS', 'Kenya Fannings',              'KEN', 'FNGS1', 1.4033, 1.4033, 129.45, 5.0, 'usd_kes', now())
ON CONFLICT (symbol) DO NOTHING;

-- Expand index compositions to include the new grades
UPDATE indexes
SET teas = ARRAY['KEN-BP1','KEN-PF1','KEN-DUST','KEN-PD','KEN-BMF','KEN-FNGS']
WHERE symbol IN ('KENYA', 'MOMBASA');

UPDATE indexes
SET teas = ARRAY['KEN-BP1','KEN-PF1','KEN-DUST','KEN-PD','KEN-BMF','KEN-FNGS','MLW-BP1','RWA-OP']
WHERE symbol = 'AFRICA';

-- Add new VWAP columns to auction_sales for the expanded grade set
ALTER TABLE auction_sales ADD COLUMN IF NOT EXISTS pd_vwap   numeric(10,4);
ALTER TABLE auction_sales ADD COLUMN IF NOT EXISTS bmf_vwap  numeric(10,4);
ALTER TABLE auction_sales ADD COLUMN IF NOT EXISTS fngs_vwap numeric(10,4);

-- ============================================================
-- FUNCTION: apply_auction_prices_to_teas  (v2 — expanded)
-- ============================================================
-- Called after importing any auction sale.  Behaviour:
--   • ALWAYS writes price_history candles for every grade
--     (builds up the historical chart dataset over time).
--   • Only updates teas.anchor_price when this sale is the
--     most recent one imported — so importing a historical
--     file never overwrites the current live anchor price.
-- ============================================================
CREATE OR REPLACE FUNCTION apply_auction_prices_to_teas(p_sale_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_sale      auction_sales%ROWTYPE;
    v_ts        timestamptz;
    v_is_latest boolean;
BEGIN
    SELECT * INTO v_sale FROM auction_sales WHERE id = p_sale_id;
    IF NOT FOUND THEN RETURN; END IF;

    v_ts := (v_sale.sale_date::timestamptz AT TIME ZONE 'Africa/Nairobi') + interval '12 hours';

    -- Is this the most recently dated sale in the table?
    -- COALESCE handles the edge case where this is the only sale (no other rows).
    SELECT COALESCE(v_sale.sale_date >= MAX(sale_date), true)
    INTO   v_is_latest
    FROM   auction_sales
    WHERE  id != p_sale_id;

    -- ── Update anchor_price only for the most recent sale ───────────────
    IF v_is_latest THEN
        IF v_sale.pf1_vwap   > 0 THEN UPDATE teas SET anchor_price = v_sale.pf1_vwap   WHERE symbol = 'KEN-PF1';  END IF;
        IF v_sale.bp1_vwap   > 0 THEN UPDATE teas SET anchor_price = v_sale.bp1_vwap   WHERE symbol = 'KEN-BP1';  END IF;
        IF v_sale.dust1_vwap > 0 THEN UPDATE teas SET anchor_price = v_sale.dust1_vwap WHERE symbol = 'KEN-DUST'; END IF;
        IF v_sale.pd_vwap    > 0 THEN UPDATE teas SET anchor_price = v_sale.pd_vwap    WHERE symbol = 'KEN-PD';   END IF;
        IF v_sale.bmf_vwap   > 0 THEN UPDATE teas SET anchor_price = v_sale.bmf_vwap   WHERE symbol = 'KEN-BMF';  END IF;
        IF v_sale.fngs_vwap  > 0 THEN UPDATE teas SET anchor_price = v_sale.fngs_vwap  WHERE symbol = 'KEN-FNGS'; END IF;
    END IF;

    -- ── Always accumulate price_history candles (never overwrite) ────────
    -- Real auction data always overwrites simulated placeholders at the same timestamp.
    -- ON CONFLICT ... DO UPDATE WHERE is_simulated = true ensures real ticks are never overwritten.
    IF v_sale.pf1_vwap   > 0 THEN INSERT INTO price_history (symbol,price,volume,recorded_at,is_simulated) VALUES ('KEN-PF1',  v_sale.pf1_vwap,   v_sale.total_weight_kg, v_ts, false) ON CONFLICT (symbol,recorded_at) DO UPDATE SET price=EXCLUDED.price, volume=EXCLUDED.volume, is_simulated=false WHERE price_history.is_simulated=true; END IF;
    IF v_sale.bp1_vwap   > 0 THEN INSERT INTO price_history (symbol,price,volume,recorded_at,is_simulated) VALUES ('KEN-BP1',  v_sale.bp1_vwap,   v_sale.total_weight_kg, v_ts, false) ON CONFLICT (symbol,recorded_at) DO UPDATE SET price=EXCLUDED.price, volume=EXCLUDED.volume, is_simulated=false WHERE price_history.is_simulated=true; END IF;
    IF v_sale.dust1_vwap > 0 THEN INSERT INTO price_history (symbol,price,volume,recorded_at,is_simulated) VALUES ('KEN-DUST', v_sale.dust1_vwap, v_sale.total_weight_kg, v_ts, false) ON CONFLICT (symbol,recorded_at) DO UPDATE SET price=EXCLUDED.price, volume=EXCLUDED.volume, is_simulated=false WHERE price_history.is_simulated=true; END IF;
    IF v_sale.pd_vwap    > 0 THEN INSERT INTO price_history (symbol,price,volume,recorded_at,is_simulated) VALUES ('KEN-PD',   v_sale.pd_vwap,    v_sale.total_weight_kg, v_ts, false) ON CONFLICT (symbol,recorded_at) DO UPDATE SET price=EXCLUDED.price, volume=EXCLUDED.volume, is_simulated=false WHERE price_history.is_simulated=true; END IF;
    IF v_sale.bmf_vwap   > 0 THEN INSERT INTO price_history (symbol,price,volume,recorded_at,is_simulated) VALUES ('KEN-BMF',  v_sale.bmf_vwap,   v_sale.total_weight_kg, v_ts, false) ON CONFLICT (symbol,recorded_at) DO UPDATE SET price=EXCLUDED.price, volume=EXCLUDED.volume, is_simulated=false WHERE price_history.is_simulated=true; END IF;
    IF v_sale.fngs_vwap  > 0 THEN INSERT INTO price_history (symbol,price,volume,recorded_at,is_simulated) VALUES ('KEN-FNGS', v_sale.fngs_vwap,  v_sale.total_weight_kg, v_ts, false) ON CONFLICT (symbol,recorded_at) DO UPDATE SET price=EXCLUDED.price, volume=EXCLUDED.volume, is_simulated=false WHERE price_history.is_simulated=true; END IF;
    IF v_sale.kenya_index_price > 0 THEN
        INSERT INTO price_history (symbol,price,volume,recorded_at,is_simulated) VALUES ('KENYA',   v_sale.kenya_index_price, v_sale.total_weight_kg, v_ts, false) ON CONFLICT (symbol,recorded_at) DO UPDATE SET price=EXCLUDED.price, volume=EXCLUDED.volume, is_simulated=false WHERE price_history.is_simulated=true;
        INSERT INTO price_history (symbol,price,volume,recorded_at,is_simulated) VALUES ('MOMBASA', v_sale.kenya_index_price, v_sale.total_weight_kg, v_ts, false) ON CONFLICT (symbol,recorded_at) DO UPDATE SET price=EXCLUDED.price, volume=EXCLUDED.volume, is_simulated=false WHERE price_history.is_simulated=true;
    END IF;
END;
$$;
-- ============================================================
-- ORDER FLOW REAL-TIME ENGINE
-- Run this block in the Supabase SQL Editor after deploying.
-- ============================================================

-- ── 1. market_pressure table ─────────────────────────────────────────────────
-- Stores live buy/sell aggregates per symbol.
-- Updated by the trigger on every trade insert — typically within <100ms.
-- Subscribed to via Supabase Realtime so the frontend receives depth
-- updates the moment any user executes a trade.

CREATE TABLE IF NOT EXISTS market_pressure (
    symbol          TEXT        PRIMARY KEY,
    buy_volume_5m   NUMERIC     NOT NULL DEFAULT 0,   -- kg bought, last 5 min
    sell_volume_5m  NUMERIC     NOT NULL DEFAULT 0,   -- kg sold,   last 5 min
    buy_volume_30m  NUMERIC     NOT NULL DEFAULT 0,   -- kg bought, last 30 min
    sell_volume_30m NUMERIC     NOT NULL DEFAULT 0,   -- kg sold,   last 30 min
    trade_count_5m  INT         NOT NULL DEFAULT 0,
    trade_count_30m INT         NOT NULL DEFAULT 0,
    last_side       TEXT,                             -- 'BUY' | 'SELL' — last trade direction
    last_qty        NUMERIC     NOT NULL DEFAULT 0,   -- kg in the last trade
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Realtime requires FULL replica identity so old/new rows are visible
ALTER TABLE market_pressure REPLICA IDENTITY FULL;

ALTER TABLE market_pressure ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "market_pressure_read" ON market_pressure;
CREATE POLICY "market_pressure_read" ON market_pressure
    FOR SELECT TO authenticated USING (true);

-- service_role writes via the trigger (SECURITY DEFINER — bypasses RLS)

-- ── 2. Instant price-impact trigger ──────────────────────────────────────────
--
-- Fires AFTER EACH ROW inserted into trades.
-- Does three things atomically:
--   a) Re-aggregates the 5-min and 30-min buy/sell windows for this symbol
--   b) Upserts market_pressure — frontend Realtime fires immediately
--   c) Recalculates the tea's live price using Kyle's Lambda + tanh bounding
--      and writes it to teas.current_price (triggering the existing teas
--      Realtime subscription the frontend already has open)
--
-- No edge-function cron needed for flow impact — this fires in <100ms.

CREATE OR REPLACE FUNCTION apply_trade_flow_impact()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_symbol        TEXT;
    v_tea           RECORD;
    v_buy_5m        NUMERIC := 0;
    v_sell_5m       NUMERIC := 0;
    v_buy_30m       NUMERIC := 0;
    v_sell_30m      NUMERIC := 0;
    v_cnt_5m        INT     := 0;
    v_cnt_30m       INT     := 0;
    v_net_flow      NUMERIC;
    v_raw_impact    NUMERIC;
    v_flow_effect   NUMERIC;
    v_new_price     NUMERIC;

    -- Tuning constants (mirror the edge function values)
    c_ref_vol       CONSTANT NUMERIC := 5000;   -- kg  — "normal" 30-min volume
    c_max_impact    CONSTANT NUMERIC := 0.02;   -- ±2% maximum price move per event
BEGIN
    -- ── Resolve which symbol this trade belongs to ─────────────────────────
    IF NEW.tea_id IS NOT NULL THEN
        SELECT symbol INTO v_symbol FROM teas WHERE id = NEW.tea_id;
    ELSIF NEW.index_symbol IS NOT NULL THEN
        v_symbol := NEW.index_symbol;
    END IF;

    IF v_symbol IS NULL THEN
        RETURN NEW;  -- unrecognised trade row — skip cleanly
    END IF;

    -- ── Aggregate trade volumes for the two look-back windows ─────────────
    -- Single-pass scan of the 30-min window; 5-min filter applied inline.
    SELECT
        COALESCE(SUM(CASE WHEN side = 'BUY'  AND created_at >= NOW() - INTERVAL '5 minutes'  THEN quantity END), 0),
        COALESCE(SUM(CASE WHEN side = 'SELL' AND created_at >= NOW() - INTERVAL '5 minutes'  THEN quantity END), 0),
        COALESCE(SUM(CASE WHEN side = 'BUY'  THEN quantity END), 0),
        COALESCE(SUM(CASE WHEN side = 'SELL' THEN quantity END), 0),
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '5 minutes'),
        COUNT(*)
    INTO v_buy_5m, v_sell_5m, v_buy_30m, v_sell_30m, v_cnt_5m, v_cnt_30m
    FROM trades
    WHERE (
            (tea_id = NEW.tea_id AND NEW.tea_id IS NOT NULL)
         OR (index_symbol = v_symbol AND NEW.index_symbol IS NOT NULL)
    )
    AND created_at >= NOW() - INTERVAL '30 minutes';

    -- ── Push aggregates to market_pressure (Realtime fires here) ──────────
    INSERT INTO market_pressure (
        symbol, buy_volume_5m, sell_volume_5m,
        buy_volume_30m, sell_volume_30m,
        trade_count_5m, trade_count_30m,
        last_side, last_qty, updated_at
    ) VALUES (
        v_symbol, v_buy_5m, v_sell_5m,
        v_buy_30m, v_sell_30m,
        v_cnt_5m, v_cnt_30m,
        NEW.side, NEW.quantity, NOW()
    )
    ON CONFLICT (symbol) DO UPDATE SET
        buy_volume_5m   = EXCLUDED.buy_volume_5m,
        sell_volume_5m  = EXCLUDED.sell_volume_5m,
        buy_volume_30m  = EXCLUDED.buy_volume_30m,
        sell_volume_30m = EXCLUDED.sell_volume_30m,
        trade_count_5m  = EXCLUDED.trade_count_5m,
        trade_count_30m = EXCLUDED.trade_count_30m,
        last_side       = EXCLUDED.last_side,
        last_qty        = EXCLUDED.last_qty,
        updated_at      = EXCLUDED.updated_at;

    -- ── Apply flow impact to individual tea price (not composite indexes) ──
    -- Composite indexes (KENYA, MOMBASA, etc.) are averages of tea prices —
    -- adjusting them directly would create double-counting.  Their prices
    -- will naturally reflect flow when the constituent teas are adjusted.
    IF NEW.tea_id IS NULL THEN
        RETURN NEW;  -- index trade: depth updated above; no direct price write
    END IF;

    SELECT * INTO v_tea FROM teas WHERE id = NEW.tea_id;
    IF NOT FOUND OR v_tea.anchor_price IS NULL OR v_tea.anchor_price <= 0 THEN
        RETURN NEW;
    END IF;

    -- ── Kyle's Lambda with tanh bounding (30-min window) ──────────────────
    --
    -- net_flow positive → more buying than selling → price nudges up
    -- net_flow negative → more selling than buying → price nudges down
    --
    -- tanh() is PostgreSQL built-in (available since PG 9.x).
    -- It maps any real number to (-1, +1) via the S-curve, preventing
    -- a flood of large orders from creating an unbounded price spike.
    --
    v_net_flow    := v_buy_30m - v_sell_30m;
    v_raw_impact  := v_net_flow / c_ref_vol;
    v_flow_effect := tanh(v_raw_impact) * c_max_impact;

    -- Apply the flow effect on top of the current live price (not anchor).
    -- This means successive trades in the same direction compound correctly:
    -- each new BUY pushes price a little higher than the last.
    v_new_price := v_tea.current_price * (1.0 + v_flow_effect);

    -- Hard safety clamp: ±15% of the real-world auction anchor.
    -- Prevents any coordinated manipulation from moving prices to
    -- levels that are economically absurd relative to real auction data.
    v_new_price := GREATEST(
        v_tea.anchor_price * 0.85,
        LEAST(v_tea.anchor_price * 1.15, v_new_price)
    );

    -- Commit live price (triggers teas Realtime → frontend updates chart)
    UPDATE teas
    SET    current_price = v_new_price,
           last_update   = NOW()
    WHERE  id = NEW.tea_id;

    -- Append tick to immutable price history.
    -- DO NOTHING on conflict: price_history rows are write-once; two trades in
    -- the same millisecond simply result in one recorded point (acceptable).
    INSERT INTO price_history (symbol, price, volume, recorded_at, is_simulated)
    VALUES (v_symbol, v_new_price, NEW.quantity, NOW(), false)
    ON CONFLICT (symbol, recorded_at) DO NOTHING;

    RETURN NEW;
END;
$$;

-- Install the trigger (idempotent — DROP first in case of re-run)
DROP TRIGGER IF EXISTS trg_trade_flow_impact ON trades;
CREATE TRIGGER trg_trade_flow_impact
    AFTER INSERT ON trades
    FOR EACH ROW
    EXECUTE FUNCTION apply_trade_flow_impact();

-- ── 3. Seed initial market_pressure rows from existing trade history ──────────
-- Populates the table on first run so the frontend has data immediately.
INSERT INTO market_pressure (
    symbol, buy_volume_5m, sell_volume_5m,
    buy_volume_30m, sell_volume_30m,
    trade_count_5m, trade_count_30m,
    last_side, last_qty, updated_at
)
SELECT
    v_symbol,
    COALESCE(SUM(CASE WHEN side = 'BUY'  AND created_at >= NOW() - INTERVAL '5 minutes'  THEN quantity END), 0),
    COALESCE(SUM(CASE WHEN side = 'SELL' AND created_at >= NOW() - INTERVAL '5 minutes'  THEN quantity END), 0),
    COALESCE(SUM(CASE WHEN side = 'BUY'  THEN quantity END), 0),
    COALESCE(SUM(CASE WHEN side = 'SELL' THEN quantity END), 0),
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '5 minutes'),
    COUNT(*),
    (SELECT side FROM trades t2
     WHERE (t2.tea_id = t.tea_id OR t2.index_symbol = v_symbol)
     ORDER BY t2.created_at DESC LIMIT 1),
    (SELECT quantity FROM trades t3
     WHERE (t3.tea_id = t.tea_id OR t3.index_symbol = v_symbol)
     ORDER BY t3.created_at DESC LIMIT 1),
    NOW()
FROM (
    SELECT COALESCE(te.symbol, tr.index_symbol) AS v_symbol,
           tr.tea_id, tr.side, tr.quantity, tr.created_at
    FROM   trades tr
    LEFT JOIN teas te ON tr.tea_id = te.id
    WHERE  tr.created_at >= NOW() - INTERVAL '30 minutes'
) t
GROUP BY v_symbol, t.tea_id
ON CONFLICT (symbol) DO UPDATE SET
    buy_volume_5m   = EXCLUDED.buy_volume_5m,
    sell_volume_5m  = EXCLUDED.sell_volume_5m,
    buy_volume_30m  = EXCLUDED.buy_volume_30m,
    sell_volume_30m = EXCLUDED.sell_volume_30m,
    trade_count_5m  = EXCLUDED.trade_count_5m,
    trade_count_30m = EXCLUDED.trade_count_30m,
    updated_at      = NOW();


-- ============================================================
-- ORDER FLOW REAL-TIME ENGINE  (run in Supabase SQL Editor)
-- ============================================================
-- Creates:
--   1. market_pressure  — live buy/sell aggregates per symbol,
--      updated instantly on every trade INSERT via trigger.
--      Subscribed to via Supabase Realtime by the frontend.
--   2. apply_trade_flow_impact()  — trigger function that:
--        a. Recalculates 5-min and 30-min buy/sell volumes.
--        b. Writes them to market_pressure (fires Realtime).
--        c. Applies Kyle's-Lambda tanh-bounded flow impact
--           directly to teas.current_price.
--        d. Appends a price_history row for chart continuity.
-- ============================================================

-- 1. market_pressure table
CREATE TABLE IF NOT EXISTS market_pressure (
    symbol          TEXT        PRIMARY KEY,
    buy_volume_5m   NUMERIC     NOT NULL DEFAULT 0,
    sell_volume_5m  NUMERIC     NOT NULL DEFAULT 0,
    buy_volume_30m  NUMERIC     NOT NULL DEFAULT 0,
    sell_volume_30m NUMERIC     NOT NULL DEFAULT 0,
    trade_count_5m  INT         NOT NULL DEFAULT 0,
    trade_count_30m INT         NOT NULL DEFAULT 0,
    last_side       TEXT        CHECK (last_side IN ('BUY','SELL')),
    last_qty        NUMERIC     DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Realtime so the frontend receives instant push updates
ALTER TABLE market_pressure REPLICA IDENTITY FULL;

ALTER TABLE market_pressure ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "market_pressure_read"  ON market_pressure;
DROP POLICY IF EXISTS "market_pressure_write" ON market_pressure;
CREATE POLICY "market_pressure_read"  ON market_pressure FOR SELECT TO authenticated USING (true);
CREATE POLICY "market_pressure_write" ON market_pressure FOR ALL    TO service_role  USING (true);

-- 2. Trigger function
CREATE OR REPLACE FUNCTION apply_trade_flow_impact()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_symbol        TEXT;
    v_tea           RECORD;
    v_buy_5m        NUMERIC := 0;
    v_sell_5m       NUMERIC := 0;
    v_buy_30m       NUMERIC := 0;
    v_sell_30m      NUMERIC := 0;
    v_cnt_5m        INT     := 0;
    v_cnt_30m       INT     := 0;
    v_net_flow      NUMERIC;
    v_raw_impact    NUMERIC;
    v_flow_effect   NUMERIC;
    v_new_price     NUMERIC;
    -- Kyle's Lambda parameters (must match edge function constants)
    v_ref_vol       CONSTANT NUMERIC := 5000;  -- kg normalisation reference
    v_max_impact    CONSTANT NUMERIC := 0.02;  -- ±2 % max flow impact per tick
BEGIN
    -- ── Resolve the symbol being traded ───────────────────────────────
    IF NEW.tea_id IS NOT NULL THEN
        SELECT symbol INTO v_symbol FROM teas WHERE id = NEW.tea_id;
    ELSIF NEW.index_symbol IS NOT NULL THEN
        v_symbol := NEW.index_symbol;
    END IF;
    IF v_symbol IS NULL THEN RETURN NEW; END IF;

    -- ── Aggregate buy/sell volumes over 5-min and 30-min windows ─────
    -- We re-scan on every trade so the numbers are always current.
    SELECT
        COALESCE(SUM(quantity) FILTER (WHERE side='BUY'  AND created_at >= NOW()-INTERVAL'5 minutes'),  0),
        COALESCE(SUM(quantity) FILTER (WHERE side='SELL' AND created_at >= NOW()-INTERVAL'5 minutes'),  0),
        COALESCE(SUM(quantity) FILTER (WHERE side='BUY'),  0),
        COALESCE(SUM(quantity) FILTER (WHERE side='SELL'), 0),
        COUNT(*)              FILTER (WHERE created_at >= NOW()-INTERVAL'5 minutes'),
        COUNT(*)
    INTO v_buy_5m, v_sell_5m, v_buy_30m, v_sell_30m, v_cnt_5m, v_cnt_30m
    FROM trades
    WHERE created_at >= NOW() - INTERVAL '30 minutes'
      AND (
          (NEW.tea_id       IS NOT NULL AND tea_id      = NEW.tea_id)
       OR (NEW.index_symbol IS NOT NULL AND index_symbol = v_symbol)
      );

    -- ── Push to market_pressure (fires Supabase Realtime to frontend) ─
    INSERT INTO market_pressure
        (symbol, buy_volume_5m, sell_volume_5m,
         buy_volume_30m, sell_volume_30m,
         trade_count_5m, trade_count_30m,
         last_side, last_qty, updated_at)
    VALUES
        (v_symbol, v_buy_5m, v_sell_5m,
         v_buy_30m, v_sell_30m,
         v_cnt_5m,  v_cnt_30m,
         NEW.side, NEW.quantity, NOW())
    ON CONFLICT (symbol) DO UPDATE SET
        buy_volume_5m   = EXCLUDED.buy_volume_5m,
        sell_volume_5m  = EXCLUDED.sell_volume_5m,
        buy_volume_30m  = EXCLUDED.buy_volume_30m,
        sell_volume_30m = EXCLUDED.sell_volume_30m,
        trade_count_5m  = EXCLUDED.trade_count_5m,
        trade_count_30m = EXCLUDED.trade_count_30m,
        last_side       = EXCLUDED.last_side,
        last_qty        = EXCLUDED.last_qty,
        updated_at      = EXCLUDED.updated_at;

    -- ── Apply price impact for individual tea grades only ─────────────
    -- Index prices are composites (computed from teas), not directly updated.
    SELECT * INTO v_tea FROM teas WHERE symbol = v_symbol;
    IF NOT FOUND
       OR v_tea.anchor_price IS NULL
       OR v_tea.anchor_price <= 0
       OR v_tea.current_price IS NULL
       OR v_tea.current_price <= 0
    THEN
        RETURN NEW;
    END IF;

    -- Kyle's Lambda with tanh bounding (30-min window gives persistence)
    v_net_flow    := v_buy_30m - v_sell_30m;
    v_raw_impact  := v_net_flow / v_ref_vol;
    v_flow_effect := tanh(v_raw_impact) * v_max_impact;

    v_new_price := v_tea.current_price * (1.0 + v_flow_effect);

    -- Hard guard: must stay within ±15 % of real-world auction anchor
    v_new_price := GREATEST(v_tea.anchor_price * 0.85,
                    LEAST(  v_tea.anchor_price * 1.15, v_new_price));

    -- Commit the live price (triggers existing teas Realtime to frontend)
    UPDATE teas
    SET  current_price = v_new_price,
         last_update   = NOW()
    WHERE symbol = v_symbol;

    -- Append to immutable price history for chart continuity
    INSERT INTO price_history (symbol, price, volume, recorded_at, is_simulated)
    VALUES (v_symbol, v_new_price, NEW.quantity, NOW(), false)
    ON CONFLICT (symbol, recorded_at)
    DO UPDATE SET
        price        = EXCLUDED.price,
        volume       = price_history.volume + EXCLUDED.volume,
        is_simulated = false;

    RETURN NEW;
END;
$$;

-- 3. Attach trigger to trades table
DROP TRIGGER IF EXISTS trg_trade_flow_impact ON trades;
CREATE TRIGGER trg_trade_flow_impact
    AFTER INSERT ON trades
    FOR EACH ROW
    EXECUTE FUNCTION apply_trade_flow_impact();

-- Allow tea_id to be NULL for index trades
ALTER TABLE trades ALTER COLUMN tea_id DROP NOT NULL;
ALTER TABLE trades DROP CONSTRAINT IF EXISTS trades_must_have_symbol;
ALTER TABLE trades ADD CONSTRAINT trades_must_have_symbol
    CHECK (tea_id IS NOT NULL OR index_symbol IS NOT NULL);

-- ═══════════════════════════════════════════════════════════════════════════════
-- CHECK_STOP_OUTS — Equity-Based Liquidation (2% buffer)
--
-- Liquidation formula:  equity / total_used_margin <= 0.02
--   where equity = cash_balance + unrealized_pnl (all open positions)
--
-- This ensures account balance never goes negative by closing out
-- when only 2% of margin remains as equity backing.
--
-- Margin call at equity/margin <= 0.15 (15%).
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
        -- At 100% the account is fully covered; at 2% the 2% buffer triggers close-out.
        v_margin_level := v_equity / v_used_margin;

        -- Hard floor: if equity is already negative, always liquidate
        IF v_equity <= 0 THEN
            v_margin_level := 0;
        END IF;

        -- ── STOP-OUT (equity/margin <= 2%) ─────────────────────────────
        IF v_margin_level <= v_stop_level THEN
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

            -- Lock account if balance is effectively zero
            IF v_bal < 1 THEN
                UPDATE profiles
                SET account_status = 'LOCKED',
                    next_free_reset_at = date_trunc('month', NOW() + INTERVAL '1 month')
                WHERE id = v_user.user_id AND account_status != 'COMBINE';
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

-- ============================================================
-- BADGES SYSTEM
-- ============================================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS badges JSONB NOT NULL DEFAULT '[]'::JSONB;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS showcase_badge TEXT DEFAULT NULL;
