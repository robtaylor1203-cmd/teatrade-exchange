-- ═══════════════════════════════════════════════════════════════════════════════
-- INTRADAY SIMULATED HISTORY (last 14 days, every 2 hours)
--
-- The 1W chart needs intraday detail, not one point per day. This lays down a
-- 2-hourly synthetic point per tea for the last 14 days so 1W/short views show a
-- rich line. Anchored to anchor_price with the same low-frequency wander as the
-- daily backfill plus a gentle intraday component, so it blends seamlessly.
--
-- Idempotent: only fills a 2h slot with no existing simulated row, so it won't
-- duplicate the daily noon points or touch live/auction rows.
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO price_history (symbol, price, volume, recorded_at, is_simulated)
SELECT
    t.symbol,
    GREATEST(
        t.anchor_price * 0.65,
        t.anchor_price * (
            1.0
            + 0.060 * sin(2 * pi() * (EXTRACT(EPOCH FROM d) / 86400.0) / 74.0)
            + 0.030 * sin(2 * pi() * (EXTRACT(EPOCH FROM d) / 86400.0) / 26.0 + 2.3)
            + 0.018 * sin(2 * pi() * (EXTRACT(EPOCH FROM d) / 3600.0) / 17.0 + 1.7)
            + (random() * 0.014 - 0.007)
        )
    ),
    0,
    d,
    true
FROM teas t
CROSS JOIN generate_series(
    date_trunc('hour', NOW()) - INTERVAL '14 days',
    date_trunc('hour', NOW()),
    '2 hours'::interval
) AS d
WHERE t.anchor_price > 0
  AND NOT EXISTS (
      SELECT 1 FROM price_history ph
      WHERE ph.symbol = t.symbol
        AND ph.is_simulated = true
        AND ph.recorded_at >= d
        AND ph.recorded_at <  d + INTERVAL '2 hours'
  );
