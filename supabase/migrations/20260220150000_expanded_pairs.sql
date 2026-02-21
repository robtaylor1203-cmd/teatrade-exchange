-- ═══════════════════════════════════════════════════════════════════════════════
-- EXPANDED TRADING PAIRS
-- Index pairs (cross-region, country, composite) + Tea grade pairs
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── 1. NEW INDEX PAIRS ─────────────────────────────────────────────────────
-- Remove old pairs that may conflict, then insert full set
DELETE FROM index_pairs;

INSERT INTO index_pairs (id, base_symbol, quote_symbol) VALUES
    -- Country vs Country
    ('idx-kenya-india',     'KENYA',      'INDIA'),
    ('idx-kenya-ceylon',    'KENYA',      'CEYLON'),
    ('idx-india-ceylon',    'INDIA',      'CEYLON'),
    ('idx-indo-bangla',     'INDONESIA',  'BANGLADESH'),
    ('idx-africa-asia',     'AFRICA',     'ASIA'),
    -- Auction Centre Cross-Region
    ('idx-mom-col',         'MOMBASA',    'COLOMBO'),
    ('idx-mom-kol',         'MOMBASA',    'KOLKATA'),
    ('idx-kol-col',         'KOLKATA',    'COLOMBO'),
    ('idx-kol-guw',         'KOLKATA',    'GUWAHATI'),
    ('idx-col-jak',         'COLOMBO',    'JAKARTA'),
    ('idx-chi-jak',         'CHITTAGONG', 'JAKARTA'),
    ('idx-guw-jal',         'GUWAHATI',   'JALPAIGURI'),
    ('idx-coc-cmb',         'COCHIN',     'COIMBATORE'),
    ('idx-sil-coo',         'SILIGURI',   'COONOOR'),
    ('idx-lim-mom',         'LIMBE',      'MOMBASA'),
    -- Composite
    ('idx-fut-africa',      'FUTURES',    'AFRICA'),
    ('idx-fut-asia',        'FUTURES',    'ASIA'),
    ('idx-fut-kenya',       'FUTURES',    'KENYA'),
    ('idx-fut-india',       'FUTURES',    'INDIA')
ON CONFLICT (id) DO NOTHING;

-- ─── 2. TEA PAIRS TABLE ────────────────────────────────────────────────────
-- Drop and recreate to ensure TEXT primary key (may have been created with UUID)
DROP TABLE IF EXISTS tea_pairs CASCADE;
CREATE TABLE tea_pairs (
    id TEXT PRIMARY KEY,
    base_symbol TEXT NOT NULL,
    quote_symbol TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE tea_pairs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read tea_pairs" ON tea_pairs FOR SELECT USING (true);

-- ─── 3. TEA GRADE PAIRS ────────────────────────────────────────────────────
DELETE FROM tea_pairs;

INSERT INTO tea_pairs (id, base_symbol, quote_symbol) VALUES
    -- Cross-origin BOP/BP1 comparisons
    ('tp-kenbp1-sribop',    'KEN-BP1',  'SRI-BOP'),
    ('tp-kenbp1-bgdbop',    'KEN-BP1',  'BGD-BOP'),
    ('tp-kenbp1-idnbop',    'KEN-BP1',  'IDN-BOP'),
    ('tp-mlwbp1-kenbp1',    'MLW-BP1',  'KEN-BP1'),
    ('tp-sribop-idnbop',    'SRI-BOP',  'IDN-BOP'),
    -- Cross-origin DUST comparisons
    ('tp-kendust-sridust',  'KEN-DUST', 'SRI-DUST'),
    ('tp-kendust-idndust',  'KEN-DUST', 'IDN-DUST'),
    ('tp-bgddust-jaldust',  'BGD-DUST', 'JAL-DUST'),
    -- Fannings
    ('tp-kenfngs-bgdfngs',  'KEN-FNGS', 'BGD-FNGS'),
    ('tp-kenpf1-idnpf',     'KEN-PF1',  'IDN-PF'),
    -- India regional comparisons
    ('tp-indasm-inddrj',    'IND-ASM',  'IND-DRJ'),
    ('tp-guwbop-jalbop',    'GUW-BOP',  'JAL-BOP'),
    ('tp-cocbop-cmbbop',    'COC-BOP',  'CMB-BOP'),
    ('tp-coobop-silbop',    'COO-BOP',  'SIL-BOP'),
    ('tp-guwbop-cocbop',    'GUW-BOP',  'COC-BOP')
ON CONFLICT (id) DO NOTHING;
