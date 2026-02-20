-- ═══════════════════════════════════════════════════════════════════════════════
-- AUCTION CENTRE EXPANSION
-- 12 global auction centres, 42 new tea grades, updated indexes
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── 1. NEW TEAS ─────────────────────────────────────────────────────────────

-- Indonesia (Jakarta auction) — IDR-denominated
INSERT INTO teas (symbol, name, origin, grade, current_price, anchor_price, reference_forex, beta, currency_pair, last_update)
VALUES
    ('IDN-BOP',  'Indonesia BOP',             'IDN', 'BOP',  1.80, 1.80, 15700, 1.2, 'usd_idr', now()),
    ('IDN-PF',   'Indonesia Pekoe Fannings',  'IDN', 'PF',   1.50, 1.50, 15700, 1.0, 'usd_idr', now()),
    ('IDN-DUST', 'Indonesia Dust',            'IDN', 'DUST', 1.20, 1.20, 15700, 1.0, 'usd_idr', now()),
    ('IDN-BT',   'Indonesia Broken Tea',      'IDN', 'BT',   1.60, 1.60, 15700, 1.1, 'usd_idr', now())
ON CONFLICT (symbol) DO NOTHING;

-- Bangladesh (Chittagong auction) — BDT-denominated
INSERT INTO teas (symbol, name, origin, grade, current_price, anchor_price, reference_forex, beta, currency_pair, last_update)
VALUES
    ('BGD-BOP',  'Bangladesh BOP',            'BGD', 'BOP',  2.10, 2.10, 110, 1.3, 'usd_bdt', now()),
    ('BGD-BP',   'Bangladesh Broken Pekoe',   'BGD', 'BP',   1.80, 1.80, 110, 1.2, 'usd_bdt', now()),
    ('BGD-DUST', 'Bangladesh Dust',           'BGD', 'DUST', 1.30, 1.30, 110, 1.0, 'usd_bdt', now()),
    ('BGD-FNGS', 'Bangladesh Fannings',       'BGD', 'FNGS', 1.50, 1.50, 110, 1.0, 'usd_bdt', now())
ON CONFLICT (symbol) DO NOTHING;

-- Guwahati (India — Assam CTC) — INR-denominated
INSERT INTO teas (symbol, name, origin, grade, current_price, anchor_price, reference_forex, beta, currency_pair, last_update)
VALUES
    ('GUW-BOP', 'Assam CTC BOP',            'IND', 'BOP', 2.50, 2.50, 83.5, 1.4, 'usd_inr', now()),
    ('GUW-BP',  'Assam CTC BP',             'IND', 'BP',  2.20, 2.20, 83.5, 1.3, 'usd_inr', now()),
    ('GUW-OF',  'Assam Orthodox Flowery',    'IND', 'OF',  3.00, 3.00, 83.5, 1.5, 'usd_inr', now()),
    ('GUW-PF',  'Assam CTC PF',             'IND', 'PF',  1.80, 1.80, 83.5, 1.2, 'usd_inr', now())
ON CONFLICT (symbol) DO NOTHING;

-- Jalpaiguri (India — Dooars/Terai) — INR-denominated
INSERT INTO teas (symbol, name, origin, grade, current_price, anchor_price, reference_forex, beta, currency_pair, last_update)
VALUES
    ('JAL-BOP',  'Dooars CTC BOP',  'IND', 'BOP',  2.00, 2.00, 83.5, 1.3, 'usd_inr', now()),
    ('JAL-BP',   'Dooars CTC BP',   'IND', 'BP',   1.70, 1.70, 83.5, 1.2, 'usd_inr', now()),
    ('JAL-DUST', 'Terai CTC Dust',  'IND', 'DUST', 1.40, 1.40, 83.5, 1.0, 'usd_inr', now()),
    ('JAL-PF',   'Terai CTC PF',    'IND', 'PF',   1.60, 1.60, 83.5, 1.1, 'usd_inr', now())
ON CONFLICT (symbol) DO NOTHING;

-- Cochin (India — Kerala) — INR-denominated
INSERT INTO teas (symbol, name, origin, grade, current_price, anchor_price, reference_forex, beta, currency_pair, last_update)
VALUES
    ('COC-BOP',  'Kerala Orthodox BOP',  'IND', 'BOP',  2.80, 2.80, 83.5, 1.4, 'usd_inr', now()),
    ('COC-OP',   'Kerala Orange Pekoe',  'IND', 'OP',   3.20, 3.20, 83.5, 1.5, 'usd_inr', now()),
    ('COC-DUST', 'Kerala CTC Dust',      'IND', 'DUST', 1.60, 1.60, 83.5, 1.0, 'usd_inr', now()),
    ('COC-PF',   'Kerala CTC PF',        'IND', 'PF',   1.90, 1.90, 83.5, 1.2, 'usd_inr', now())
ON CONFLICT (symbol) DO NOTHING;

-- Coimbatore (India — Tamil Nadu) — INR-denominated
INSERT INTO teas (symbol, name, origin, grade, current_price, anchor_price, reference_forex, beta, currency_pair, last_update)
VALUES
    ('CMB-BOP',  'Tamil Nadu CTC BOP',     'IND', 'BOP',  2.40, 2.40, 83.5, 1.3, 'usd_inr', now()),
    ('CMB-BP',   'Tamil Nadu CTC BP',      'IND', 'BP',   2.00, 2.00, 83.5, 1.2, 'usd_inr', now()),
    ('CMB-DUST', 'Tamil Nadu CTC Dust',    'IND', 'DUST', 1.50, 1.50, 83.5, 1.0, 'usd_inr', now()),
    ('CMB-OP',   'Tamil Nadu Orthodox OP',  'IND', 'OP',   3.00, 3.00, 83.5, 1.5, 'usd_inr', now())
ON CONFLICT (symbol) DO NOTHING;

-- Siliguri (India — Darjeeling/Terai) — INR-denominated
INSERT INTO teas (symbol, name, origin, grade, current_price, anchor_price, reference_forex, beta, currency_pair, last_update)
VALUES
    ('SIL-DRJ',  'Darjeeling Whole Leaf',  'IND', 'DRJ',  8.50, 8.50, 83.5, 1.8, 'usd_inr', now()),
    ('SIL-BOP',  'Darjeeling BOP',         'IND', 'BOP',  5.00, 5.00, 83.5, 1.6, 'usd_inr', now()),
    ('SIL-DUST', 'Terai Dust',             'IND', 'DUST', 1.60, 1.60, 83.5, 1.0, 'usd_inr', now()),
    ('SIL-FNGS', 'Terai Fannings',         'IND', 'FNGS', 1.40, 1.40, 83.5, 1.0, 'usd_inr', now())
ON CONFLICT (symbol) DO NOTHING;

-- Coonoor (India — Nilgiris) — INR-denominated
INSERT INTO teas (symbol, name, origin, grade, current_price, anchor_price, reference_forex, beta, currency_pair, last_update)
VALUES
    ('COO-BOP',  'Nilgiri CTC BOP',     'IND', 'BOP',  2.60, 2.60, 83.5, 1.3, 'usd_inr', now()),
    ('COO-OP',   'Nilgiri Orthodox OP',  'IND', 'OP',   3.50, 3.50, 83.5, 1.5, 'usd_inr', now()),
    ('COO-DUST', 'Nilgiri CTC Dust',    'IND', 'DUST', 1.50, 1.50, 83.5, 1.0, 'usd_inr', now()),
    ('COO-PF',   'Nilgiri CTC PF',      'IND', 'PF',   1.80, 1.80, 83.5, 1.2, 'usd_inr', now())
ON CONFLICT (symbol) DO NOTHING;

-- Limbe expansion (Malawi) — USD-denominated
INSERT INTO teas (symbol, name, origin, grade, current_price, anchor_price, reference_forex, beta, currency_pair, last_update)
VALUES
    ('MLW-PF1',  'Malawi PF1',       'MLW', 'PF1',  1.70, 1.70, 1, 1.0, 'usd_usd', now()),
    ('MLW-DUST', 'Malawi Dust',      'MLW', 'DUST', 1.20, 1.20, 1, 1.0, 'usd_usd', now()),
    ('MLW-FNGS', 'Malawi Fannings',  'MLW', 'FNGS', 1.40, 1.40, 1, 1.0, 'usd_usd', now())
ON CONFLICT (symbol) DO NOTHING;

-- Colombo expansion (Sri Lanka) — LKR-denominated
INSERT INTO teas (symbol, name, origin, grade, current_price, anchor_price, reference_forex, beta, currency_pair, last_update)
VALUES
    ('SRI-OP',   'Ceylon Orange Pekoe',   'SRI', 'OP',   4.50, 4.50, 305, 1.5, 'usd_lkr', now()),
    ('SRI-FBOP', 'Ceylon Flowery BOP',    'SRI', 'FBOP', 5.00, 5.00, 305, 1.6, 'usd_lkr', now()),
    ('SRI-DUST', 'Ceylon Dust',           'SRI', 'DUST', 2.50, 2.50, 305, 1.0, 'usd_lkr', now()),
    ('SRI-BOP1', 'Ceylon BOP1',           'SRI', 'BOP1', 4.20, 4.20, 305, 1.4, 'usd_lkr', now())
ON CONFLICT (symbol) DO NOTHING;

-- Kolkata expansion (India — Darjeeling specialty) — INR-denominated
INSERT INTO teas (symbol, name, origin, grade, current_price, anchor_price, reference_forex, beta, currency_pair, last_update)
VALUES
    ('KOL-SF',   'Darjeeling Second Flush',  'IND', 'SF',   10.00, 10.00, 83.5, 1.8, 'usd_inr', now()),
    ('KOL-AUT',  'Darjeeling Autumnal',      'IND', 'AUT',   5.50,  5.50, 83.5, 1.5, 'usd_inr', now()),
    ('KOL-GOLD', 'Darjeeling Gold Tip',      'IND', 'GOLD', 12.00, 12.00, 83.5, 2.0, 'usd_inr', now())
ON CONFLICT (symbol) DO NOTHING;


-- ─── 2. NEW AUCTION CENTRE INDEXES ──────────────────────────────────────────

INSERT INTO indexes (symbol, name, teas, color, currency, multiplier, is_market_card, display_order, forex_key)
VALUES
    ('JAKARTA',    'Jakarta Auction Index',    ARRAY['IDN-BOP','IDN-PF','IDN-DUST','IDN-BT'],           'var(--accent-teal)',   'Rp', 15700, FALSE, 20, 'usd_idr'),
    ('CHITTAGONG', 'Chittagong Auction Index', ARRAY['BGD-BOP','BGD-BP','BGD-DUST','BGD-FNGS'],         'var(--accent-cyan)',   '৳',  110,   FALSE, 21, 'usd_bdt'),
    ('GUWAHATI',   'Guwahati Auction Index',   ARRAY['GUW-BOP','GUW-BP','GUW-OF','GUW-PF'],            'var(--accent-orange)', '₹',  83.5,  FALSE, 22, 'usd_inr'),
    ('JALPAIGURI', 'Jalpaiguri Auction Index', ARRAY['JAL-BOP','JAL-BP','JAL-DUST','JAL-PF'],           'var(--accent-amber)',  '₹',  83.5,  FALSE, 23, 'usd_inr'),
    ('COCHIN',     'Cochin Auction Index',     ARRAY['COC-BOP','COC-OP','COC-DUST','COC-PF'],           'var(--accent-lime)',   '₹',  83.5,  FALSE, 24, 'usd_inr'),
    ('COIMBATORE', 'Coimbatore Auction Index', ARRAY['CMB-BOP','CMB-BP','CMB-DUST','CMB-OP'],           'var(--accent-yellow)', '₹',  83.5,  FALSE, 25, 'usd_inr'),
    ('LIMBE',      'Limbe Auction Index',      ARRAY['MLW-BP1','MLW-PF1','MLW-DUST','MLW-FNGS'],        'var(--accent-green)',  '$',  1,     FALSE, 26, NULL),
    ('SILIGURI',   'Siliguri Auction Index',   ARRAY['SIL-DRJ','SIL-BOP','SIL-DUST','SIL-FNGS'],       'var(--accent-pink)',   '₹',  83.5,  FALSE, 27, 'usd_inr'),
    ('COONOOR',    'Coonoor Auction Index',    ARRAY['COO-BOP','COO-OP','COO-DUST','COO-PF'],           'var(--accent-indigo)', '₹',  83.5,  FALSE, 28, 'usd_inr')
ON CONFLICT (symbol) DO NOTHING;

-- ─── 3. NEW COUNTRY INDEXES ─────────────────────────────────────────────────

INSERT INTO indexes (symbol, name, teas, color, currency, multiplier, is_market_card, display_order)
VALUES
    ('INDONESIA',  'Indonesia Tea Index',   ARRAY['IDN-BOP','IDN-PF','IDN-DUST','IDN-BT'],             'var(--accent-teal)',  '$', 1, FALSE, 30),
    ('BANGLADESH', 'Bangladesh Tea Index',  ARRAY['BGD-BOP','BGD-BP','BGD-DUST','BGD-FNGS'],            'var(--accent-cyan)',  '$', 1, FALSE, 31),
    ('MALAWI',     'Malawi Tea Index',      ARRAY['MLW-BP1','MLW-PF1','MLW-DUST','MLW-FNGS'],           'var(--accent-green)', '$', 1, FALSE, 32)
ON CONFLICT (symbol) DO NOTHING;

-- ─── 4. UPDATE EXISTING INDEXES ─────────────────────────────────────────────

-- Kolkata: add Darjeeling specialty grades
UPDATE indexes SET teas = ARRAY['IND-ASM','IND-DRJ','KOL-SF','KOL-AUT','KOL-GOLD']
WHERE symbol = 'KOLKATA';

-- Colombo: add expanded Ceylon grades
UPDATE indexes SET teas = ARRAY['SRI-BOP','SRI-PEK','SRI-OP','SRI-FBOP','SRI-DUST','SRI-BOP1']
WHERE symbol = 'COLOMBO';

-- India country index: all Indian teas
UPDATE indexes SET teas = ARRAY[
    'IND-ASM','IND-DRJ','KOL-SF','KOL-AUT','KOL-GOLD',
    'GUW-BOP','GUW-BP','GUW-OF','GUW-PF',
    'JAL-BOP','JAL-BP','JAL-DUST','JAL-PF',
    'COC-BOP','COC-OP','COC-DUST','COC-PF',
    'CMB-BOP','CMB-BP','CMB-DUST','CMB-OP',
    'SIL-DRJ','SIL-BOP','SIL-DUST','SIL-FNGS',
    'COO-BOP','COO-OP','COO-DUST','COO-PF'
] WHERE symbol = 'INDIA';

-- Ceylon country index: all Sri Lankan teas
UPDATE indexes SET teas = ARRAY['SRI-BOP','SRI-PEK','SRI-OP','SRI-FBOP','SRI-DUST','SRI-BOP1']
WHERE symbol = 'CEYLON';

-- Africa: expand with Malawi grades
UPDATE indexes SET teas = ARRAY[
    'KEN-BP1','KEN-PF1','KEN-DUST','KEN-PD','KEN-BMF','KEN-FNGS',
    'MLW-BP1','MLW-PF1','MLW-DUST','MLW-FNGS','RWA-OP'
] WHERE symbol = 'AFRICA';

-- Asia: representative basket from each Asian origin
UPDATE indexes SET teas = ARRAY[
    'IND-ASM','IND-DRJ','SRI-BOP','SRI-PEK',
    'IDN-BOP','BGD-BOP',
    'GUW-BOP','COC-OP','CMB-BOP','COO-BOP','SIL-DRJ','JAL-BOP'
] WHERE symbol = 'ASIA';

-- Global Tea Futures: one representative per major region (no China)
UPDATE indexes SET teas = ARRAY[
    'KEN-BP1','IND-ASM','SRI-BOP','IDN-BOP','BGD-BOP','MLW-BP1'
] WHERE symbol = 'FUTURES';

-- ─── 5. REMOVE CHINA INDEX ──────────────────────────────────────────────────
DELETE FROM index_pairs WHERE base_symbol = 'CHINA' OR quote_symbol = 'CHINA';
DELETE FROM index_positions WHERE index_symbol = 'CHINA';
DELETE FROM indexes WHERE symbol = 'CHINA';

-- ─── 6. NEW ORIGINS ─────────────────────────────────────────────────────────
INSERT INTO origins (code, name, display_order) VALUES
    ('IDN', 'Indonesia',  8),
    ('BGD', 'Bangladesh', 9)
ON CONFLICT (code) DO NOTHING;
