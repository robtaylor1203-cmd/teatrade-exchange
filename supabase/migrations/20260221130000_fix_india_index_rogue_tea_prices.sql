-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX: Remove rogue tea-level price_history generated from the INDIA country
-- index (multiplier = 1) in the tea_level_price_backfill migration.
--
-- Root cause: migration 110000 iterates ALL rows in `indexes`, including the
-- INDIA country index whose multiplier is 1 (USD display).  The formula
--   tea_price = anchor × (avg_price_inr / GREATEST(multiplier, 1)) / avg_anchor
-- divides INR by 1 instead of 83.5, producing prices 80–90× too high.
-- These inflated rows exist alongside correct rows from regional indexes
-- (KOLKATA, COIMBATORE, etc.) and cause massive spikes in composite charts.
--
-- Fix strategy:
--   1. Delete ALL tea-level price_history for every Indian tea symbol
--   2. Delete ALL index-level price_history for Indian indexes + INDIA
--   3. Re-backfill index-level data from auction_results ÷ 83.5
--   4. Re-backfill tea-level data from REGIONAL indexes only (not INDIA)
--   5. Fill remaining gaps with clean synthetic weekly data
--   6. Reset current_price = anchor_price for affected teas
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── 1. NUKE ALL INDIAN TEA-LEVEL price_history ────────────────────────────
DELETE FROM price_history WHERE symbol IN (
    'IND-ASM', 'IND-DRJ', 'KOL-SF', 'KOL-AUT', 'KOL-GOLD',
    'GUW-BOP', 'GUW-BP', 'GUW-OF', 'GUW-PF',
    'JAL-BOP', 'JAL-BP', 'JAL-DUST', 'JAL-PF',
    'COC-BOP', 'COC-OP', 'COC-DUST', 'COC-PF',
    'CMB-BOP', 'CMB-BP', 'CMB-DUST', 'CMB-OP',
    'SIL-DRJ', 'SIL-BOP', 'SIL-DUST', 'SIL-FNGS',
    'COO-BOP', 'COO-OP', 'COO-DUST', 'COO-PF'
);

-- ─── 2. NUKE ALL INDIAN INDEX-LEVEL price_history ──────────────────────────
DELETE FROM price_history WHERE symbol IN (
    'KOLKATA', 'GUWAHATI', 'SILIGURI', 'COCHIN',
    'COIMBATORE', 'COONOOR', 'JALPAIGURI', 'INDIA'
);

-- ─── 3. ENSURE ANCHOR PRICES ARE CORRECT ───────────────────────────────────
-- (Idempotent — repeats the values from migration 090000)
UPDATE teas SET anchor_price = 1.80, current_price = 1.80 WHERE symbol = 'IND-ASM';
UPDATE teas SET anchor_price = 2.80, current_price = 2.80 WHERE symbol = 'IND-DRJ';
UPDATE teas SET anchor_price = 3.50, current_price = 3.50 WHERE symbol = 'KOL-SF';
UPDATE teas SET anchor_price = 2.30, current_price = 2.30 WHERE symbol = 'KOL-AUT';
UPDATE teas SET anchor_price = 3.40, current_price = 3.40 WHERE symbol = 'KOL-GOLD';
UPDATE teas SET anchor_price = 3.00, current_price = 3.00 WHERE symbol = 'SIL-DRJ';
UPDATE teas SET anchor_price = 2.10, current_price = 2.10 WHERE symbol = 'SIL-BOP';
UPDATE teas SET anchor_price = 1.50, current_price = 1.50 WHERE symbol = 'SIL-DUST';
UPDATE teas SET anchor_price = 1.30, current_price = 1.30 WHERE symbol = 'SIL-FNGS';
UPDATE teas SET anchor_price = 2.00, current_price = 2.00 WHERE symbol = 'COC-BOP';
UPDATE teas SET anchor_price = 2.30, current_price = 2.30 WHERE symbol = 'COC-OP';
UPDATE teas SET anchor_price = 1.60, current_price = 1.60 WHERE symbol = 'COC-DUST';
UPDATE teas SET anchor_price = 1.90, current_price = 1.90 WHERE symbol = 'COC-PF';
UPDATE teas SET anchor_price = 1.70, current_price = 1.70 WHERE symbol = 'CMB-BOP';
UPDATE teas SET anchor_price = 1.50, current_price = 1.50 WHERE symbol = 'CMB-BP';
UPDATE teas SET anchor_price = 1.50, current_price = 1.50 WHERE symbol = 'CMB-DUST';
UPDATE teas SET anchor_price = 1.80, current_price = 1.80 WHERE symbol = 'CMB-OP';
UPDATE teas SET anchor_price = 1.40, current_price = 1.40 WHERE symbol = 'COO-BOP';
UPDATE teas SET anchor_price = 1.50, current_price = 1.50 WHERE symbol = 'COO-OP';
UPDATE teas SET anchor_price = 1.10, current_price = 1.10 WHERE symbol = 'COO-DUST';
UPDATE teas SET anchor_price = 1.25, current_price = 1.25 WHERE symbol = 'COO-PF';
UPDATE teas SET anchor_price = 1.50, current_price = 1.50 WHERE symbol = 'JAL-BOP';
UPDATE teas SET anchor_price = 1.30, current_price = 1.30 WHERE symbol = 'JAL-BP';
UPDATE teas SET anchor_price = 1.40, current_price = 1.40 WHERE symbol = 'JAL-DUST';
UPDATE teas SET anchor_price = 1.20, current_price = 1.20 WHERE symbol = 'JAL-PF';
UPDATE teas SET anchor_price = 2.50, current_price = 2.50 WHERE symbol = 'GUW-BOP';
UPDATE teas SET anchor_price = 2.20, current_price = 2.20 WHERE symbol = 'GUW-BP';
UPDATE teas SET anchor_price = 3.30, current_price = 3.30 WHERE symbol = 'GUW-OF';
UPDATE teas SET anchor_price = 1.80, current_price = 1.80 WHERE symbol = 'GUW-PF';

-- ─── 4. RE-BACKFILL INDEX-LEVEL FROM auction_results ÷ 83.5 ────────────────
-- Hardcode 83.5 — do NOT rely on indexes.multiplier (INDIA has multiplier=1)
INSERT INTO price_history (symbol, price, volume, recorded_at, is_simulated)
SELECT
    ar.centre,
    ar.avg_price_inr / 83.5,
    0,
    ar.auction_date + INTERVAL '12 hours',
    false
FROM auction_results ar
WHERE ar.centre IN (
    'KOLKATA', 'GUWAHATI', 'SILIGURI', 'COCHIN',
    'COIMBATORE', 'COONOOR', 'JALPAIGURI', 'INDIA'
)
ON CONFLICT DO NOTHING;

-- ─── 5. RE-BACKFILL TEA-LEVEL FROM REGIONAL INDEXES ONLY ───────────────────
-- Process ONLY the 7 regional auction centres (multiplier = 83.5).
-- EXCLUDE country-level indexes (INDIA, ASIA, AFRICA, etc.) whose
-- multiplier ≠ 83.5 and would corrupt the INR → USD conversion.
INSERT INTO price_history (symbol, price, volume, recorded_at, is_simulated)
SELECT
    t.symbol,
    GREATEST(
        0.10,
        t.anchor_price
        * (ar.avg_price_inr / 83.5)
        / NULLIF(idx_avg.avg_anchor, 0)
        * (0.97 + random() * 0.06)
    ),
    0,
    ar.auction_date + INTERVAL '12 hours',
    true
FROM indexes i
CROSS JOIN LATERAL unnest(i.teas) AS tea_sym
JOIN teas t ON t.symbol = tea_sym AND t.anchor_price > 0
JOIN auction_results ar ON ar.centre = i.symbol
CROSS JOIN LATERAL (
    SELECT AVG(t2.anchor_price) AS avg_anchor
    FROM unnest(i.teas) AS ts2
    JOIN teas t2 ON t2.symbol = ts2 AND t2.anchor_price > 0
) idx_avg
WHERE i.symbol IN (
    'KOLKATA', 'GUWAHATI', 'SILIGURI', 'COCHIN',
    'COIMBATORE', 'COONOOR', 'JALPAIGURI'
)
AND idx_avg.avg_anchor > 0
ON CONFLICT DO NOTHING;

-- ─── 6. FILL GAPS WITH CLEAN SYNTHETIC WEEKLY DATA ─────────────────────────
-- ±10% seasonal + random variation around anchor_price, 3 years of weekly data.
-- ON CONFLICT DO NOTHING preserves the auction-derived rows above.
INSERT INTO price_history (symbol, price, volume, recorded_at, is_simulated)
SELECT
    t.symbol,
    GREATEST(
        t.anchor_price * 0.70,
        t.anchor_price * (
            1.0
            + 0.06 * sin(2 * pi() * EXTRACT(DOY FROM d::date) / 365.0)
            + 0.03 * sin(2 * pi() * EXTRACT(DOY FROM d::date) / 180.0 + 1.3)
            + (random() * 0.08 - 0.04)
        )
    ),
    0,
    d + INTERVAL '12 hours',
    true
FROM teas t
CROSS JOIN generate_series(
    '2022-06-01'::date,
    CURRENT_DATE,
    '7 days'::interval
) AS d
WHERE t.symbol IN (
    'IND-ASM', 'IND-DRJ', 'KOL-SF', 'KOL-AUT', 'KOL-GOLD',
    'GUW-BOP', 'GUW-BP', 'GUW-OF', 'GUW-PF',
    'JAL-BOP', 'JAL-BP', 'JAL-DUST', 'JAL-PF',
    'COC-BOP', 'COC-OP', 'COC-DUST', 'COC-PF',
    'CMB-BOP', 'CMB-BP', 'CMB-DUST', 'CMB-OP',
    'SIL-DRJ', 'SIL-BOP', 'SIL-DUST', 'SIL-FNGS',
    'COO-BOP', 'COO-OP', 'COO-DUST', 'COO-PF'
)
AND t.anchor_price > 0
ON CONFLICT DO NOTHING;
