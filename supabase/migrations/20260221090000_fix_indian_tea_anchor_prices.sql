-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX INDIAN TEA ANCHOR PRICES TO MATCH REAL AUCTION DATA
--
-- Source: Tea Board of India weekly auction reports (2025 data in auction_results)
--
-- The original anchor_price values for Darjeeling specialty teas and several
-- other Indian teas were set far above actual auction realisation prices.
-- For example KOL-GOLD was $12 (₹1,002) but Kolkata auction averages ₹145-290.
--
-- This migration corrects anchor_price AND current_price so the market-ticker's
-- ±15% clamp keeps prices within realistic bounds going forward.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── KOLKATA CONSTITUENT TEAS ────────────────────────────────────────────────
-- Target index: ₹230 (real Kolkata auction avg ₹145-290)
-- Constituent avg: ($1.80+$2.80+$3.50+$2.30+$3.40)/5 = $2.76 → ₹230

UPDATE teas SET anchor_price = 1.80, current_price = 1.80 WHERE symbol = 'IND-ASM';
UPDATE teas SET anchor_price = 2.80, current_price = 2.80 WHERE symbol = 'IND-DRJ';
UPDATE teas SET anchor_price = 3.50, current_price = 3.50 WHERE symbol = 'KOL-SF';
UPDATE teas SET anchor_price = 2.30, current_price = 2.30 WHERE symbol = 'KOL-AUT';
UPDATE teas SET anchor_price = 3.40, current_price = 3.40 WHERE symbol = 'KOL-GOLD';

-- ─── SILIGURI CONSTITUENT TEAS ───────────────────────────────────────────────
-- Target index: ₹165 (real Siliguri auction avg ₹135-200)
-- Constituent avg: ($3.00+$2.10+$1.50+$1.30)/4 = $1.98 → ₹165

UPDATE teas SET anchor_price = 3.00, current_price = 3.00 WHERE symbol = 'SIL-DRJ';
UPDATE teas SET anchor_price = 2.10, current_price = 2.10 WHERE symbol = 'SIL-BOP';
UPDATE teas SET anchor_price = 1.50, current_price = 1.50 WHERE symbol = 'SIL-DUST';
UPDATE teas SET anchor_price = 1.30, current_price = 1.30 WHERE symbol = 'SIL-FNGS';

-- ─── COCHIN CONSTITUENT TEAS ─────────────────────────────────────────────────
-- Target index: ₹163 (real Cochin auction avg ₹150-172)
-- Constituent avg: ($2.00+$2.30+$1.60+$1.90)/4 = $1.95 → ₹163

UPDATE teas SET anchor_price = 2.00, current_price = 2.00 WHERE symbol = 'COC-BOP';
UPDATE teas SET anchor_price = 2.30, current_price = 2.30 WHERE symbol = 'COC-OP';
-- COC-DUST ($1.60) and COC-PF ($1.90) are already reasonable

-- ─── COIMBATORE CONSTITUENT TEAS ─────────────────────────────────────────────
-- Target index: ₹136 (real Coimbatore auction avg ₹113-151)
-- Constituent avg: ($1.70+$1.50+$1.50+$1.80)/4 = $1.63 → ₹136

UPDATE teas SET anchor_price = 1.70, current_price = 1.70 WHERE symbol = 'CMB-BOP';
UPDATE teas SET anchor_price = 1.50, current_price = 1.50 WHERE symbol = 'CMB-BP';
-- CMB-DUST ($1.50) is fine
UPDATE teas SET anchor_price = 1.80, current_price = 1.80 WHERE symbol = 'CMB-OP';

-- ─── COONOOR CONSTITUENT TEAS ────────────────────────────────────────────────
-- Target index: ₹109 (real Coonoor auction avg ₹91-128)
-- Constituent avg: ($1.40+$1.50+$1.10+$1.25)/4 = $1.31 → ₹109

UPDATE teas SET anchor_price = 1.40, current_price = 1.40 WHERE symbol = 'COO-BOP';
UPDATE teas SET anchor_price = 1.50, current_price = 1.50 WHERE symbol = 'COO-OP';
UPDATE teas SET anchor_price = 1.10, current_price = 1.10 WHERE symbol = 'COO-DUST';
UPDATE teas SET anchor_price = 1.25, current_price = 1.25 WHERE symbol = 'COO-PF';

-- ─── JALPAIGURI CONSTITUENT TEAS ─────────────────────────────────────────────
-- Target index: ₹113 (real Jalpaiguri auction avg ₹107-116)
-- Constituent avg: ($1.50+$1.30+$1.40+$1.20)/4 = $1.35 → ₹113

UPDATE teas SET anchor_price = 1.50, current_price = 1.50 WHERE symbol = 'JAL-BOP';
UPDATE teas SET anchor_price = 1.30, current_price = 1.30 WHERE symbol = 'JAL-BP';
-- JAL-DUST ($1.40) is close enough
UPDATE teas SET anchor_price = 1.20, current_price = 1.20 WHERE symbol = 'JAL-PF';

-- ─── GUWAHATI ────────────────────────────────────────────────────────────────
-- Already reasonable ($2.38 avg → ₹198 vs real ₹200-250). Minor bump to GUW-OF.
UPDATE teas SET anchor_price = 3.30, current_price = 3.30 WHERE symbol = 'GUW-OF';

-- ─── CLEAN UP INFLATED PRICE HISTORY ─────────────────────────────────────────
-- Delete all price_history rows for affected Indian teas. The market-ticker will
-- regenerate data at the correct price levels within minutes.
-- Also delete INDEX-level rows which were computed from the inflated tea prices.

DELETE FROM price_history WHERE symbol IN (
    'IND-ASM', 'IND-DRJ', 'KOL-SF', 'KOL-AUT', 'KOL-GOLD',
    'SIL-DRJ', 'SIL-BOP', 'SIL-DUST', 'SIL-FNGS',
    'COC-BOP', 'COC-OP',
    'CMB-BOP', 'CMB-BP', 'CMB-OP',
    'COO-BOP', 'COO-OP', 'COO-DUST', 'COO-PF',
    'JAL-BOP', 'JAL-BP', 'JAL-PF',
    'GUW-OF'
);

-- Delete index-level price_history for all Indian indexes (they'll be
-- recomputed from the corrected constituent tea prices).
DELETE FROM price_history WHERE symbol IN (
    'KOLKATA', 'INDIA', 'SILIGURI', 'COCHIN', 'COIMBATORE',
    'COONOOR', 'JALPAIGURI', 'GUWAHATI'
);

-- Re-backfill index price_history from auction_results (correct USD conversion).
-- auction_results.avg_price_inr ÷ 83.5 (INR/USD) = USD price for price_history.
INSERT INTO price_history (symbol, price, volume, recorded_at, is_simulated)
SELECT
    ar.centre,
    ar.avg_price_inr / 83.5,
    0,
    ar.auction_date + INTERVAL '12 hours',
    false
FROM auction_results ar
WHERE ar.centre IN (
    'KOLKATA', 'GUWAHATI', 'SILIGURI', 'COCHIN', 'COIMBATORE',
    'COONOOR', 'JALPAIGURI', 'INDIA'
)
ON CONFLICT DO NOTHING;
