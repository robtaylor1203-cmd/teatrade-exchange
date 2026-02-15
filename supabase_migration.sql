-- =============================================
-- TeaTrade Exchange - Database Migration
-- Moves hardcoded data tables to Supabase
-- =============================================

-- 1. INDEXES table - Regional index compositions
CREATE TABLE IF NOT EXISTS indexes (
    id SERIAL PRIMARY KEY,
    symbol TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    teas TEXT[] NOT NULL,          -- Array of constituent tea symbols
    color TEXT DEFAULT 'var(--accent-green)',
    currency TEXT DEFAULT '$',
    multiplier NUMERIC DEFAULT 1,
    is_market_card BOOLEAN DEFAULT FALSE,
    display_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE indexes ENABLE ROW LEVEL SECURITY;

-- Allow public read access
CREATE POLICY "Public read access" ON indexes FOR SELECT USING (true);

-- Seed regional indexes (used in calculateRegionalIndexes)
INSERT INTO indexes (symbol, name, teas, color, display_order) VALUES
    ('KENYA',  'Kenya Tea Index',   ARRAY['KEN-BP1', 'KEN-PF1', 'KEN-DUST'], 'var(--accent-green)', 1),
    ('INDIA',  'India Tea Index',   ARRAY['IND-ASM', 'IND-DRJ'],             'var(--accent-orange)', 2),
    ('CEYLON', 'Ceylon Tea Index',   ARRAY['SRI-BOP', 'SRI-PEK'],             'var(--accent-purple)', 3),
    ('CHINA',  'China Tea Index',    ARRAY['CHN-YUN'],                         'var(--accent-red)', 4),
    ('AFRICA', 'African Tea Index',  ARRAY['KEN-BP1', 'KEN-PF1', 'MLW-BP1', 'RWA-OP'], 'var(--accent-green)', 5),
    ('ASIA',   'Asian Tea Index',    ARRAY['IND-ASM', 'IND-DRJ', 'SRI-BOP', 'SRI-PEK', 'CHN-YUN'], 'var(--accent-blue)', 6)
ON CONFLICT (symbol) DO NOTHING;

-- Seed market display cards (used in cardData / mainChartData)
INSERT INTO indexes (symbol, name, teas, color, currency, multiplier, is_market_card, display_order) VALUES
    ('MOMBASA',  'Mombasa Auction Index', ARRAY['KEN-BP1', 'KEN-PF1', 'KEN-DUST'], 'var(--accent-green)', '$', 1,    TRUE, 10),
    ('KOLKATA',  'Kolkata Tea Index',     ARRAY['IND-ASM', 'IND-DRJ'],              'var(--accent-orange)', '₹', 83,  TRUE, 11),
    ('COLOMBO',  'Colombo Index',         ARRAY['SRI-BOP', 'SRI-PEK'],              'var(--accent-purple)', '$', 1,   TRUE, 12),
    ('FUTURES',  'Global Tea Futures',    ARRAY['KEN-BP1', 'IND-ASM', 'SRI-BOP', 'CHN-YUN', 'IND-DRJ'], 'var(--accent-blue)', '$', 1000, TRUE, 13)
ON CONFLICT (symbol) DO NOTHING;


-- 2. INDEX_PAIRS table - Pairs of indexes for trading
CREATE TABLE IF NOT EXISTS index_pairs (
    id TEXT PRIMARY KEY,
    base_symbol TEXT NOT NULL REFERENCES indexes(symbol),
    quote_symbol TEXT NOT NULL REFERENCES indexes(symbol),
    is_index BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE index_pairs ENABLE ROW LEVEL SECURITY;

-- Allow public read access
CREATE POLICY "Public read access" ON index_pairs FOR SELECT USING (true);

-- Seed index pairs
INSERT INTO index_pairs (id, base_symbol, quote_symbol) VALUES
    ('idx-kenya-india',  'KENYA',  'INDIA'),
    ('idx-india-ceylon', 'INDIA',  'CEYLON'),
    ('idx-africa-asia',  'AFRICA', 'ASIA'),
    ('idx-kenya-ceylon', 'KENYA',  'CEYLON'),
    ('idx-china-india',  'CHINA',  'INDIA')
ON CONFLICT (id) DO NOTHING;


-- 3. ORIGINS table - Origin code to country name mapping
CREATE TABLE IF NOT EXISTS origins (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    display_order INT DEFAULT 0
);

-- Enable RLS
ALTER TABLE origins ENABLE ROW LEVEL SECURITY;

-- Allow public read access
CREATE POLICY "Public read access" ON origins FOR SELECT USING (true);

-- Seed origins
INSERT INTO origins (code, name, display_order) VALUES
    ('KEN', 'Kenya',     1),
    ('IND', 'India',     2),
    ('SRI', 'Sri Lanka', 3),
    ('CHN', 'China',     4),
    ('JPN', 'Japan',     5),
    ('MLW', 'Malawi',    6),
    ('RWA', 'Rwanda',    7)
ON CONFLICT (code) DO NOTHING;

-- =============================================
-- 4. Fix price_history unique constraint
-- Required for upsert (ON CONFLICT) to work
-- =============================================
ALTER TABLE price_history
    ADD CONSTRAINT IF NOT EXISTS price_history_symbol_recorded_at_key
    UNIQUE (symbol, recorded_at);
