-- ═══════════════════════════════════════════════════════════════════════════════
-- SYNTHETIC WEEKLY PRICE HISTORY FOR ALL TEAS
--
-- The auction-based backfill (migration 110000) only covers Indian indexes.
-- Non-Indian teas (Kenya, Sri Lanka, Indonesia, Bangladesh, Malawi) have no
-- historical data at all, leaving their charts empty or showing a single
-- bunched point on every timeframe.
--
-- This generates 3 years of weekly price_history for EVERY tea, using
-- anchor_price as the baseline with seasonal and random variation (±10%).
-- ON CONFLICT DO NOTHING ensures it never overwrites the more-accurate
-- auction-derived rows that already exist for Indian teas.
-- ═══════════════════════════════════════════════════════════════════════════════

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
WHERE t.anchor_price > 0
ON CONFLICT DO NOTHING;
