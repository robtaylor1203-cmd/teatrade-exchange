-- ═══════════════════════════════════════════════════════════════════════════════
-- DAILY SIMULATED PRICE HISTORY FOR ALL TEAS
--
-- Wide chart timeframes (1W/1M/3M/1Y) need daily resolution. The earlier backfill
-- (migration 120000) only laid down WEEKLY points, and non-Indian origins rely on
-- it entirely — so weeks look sparse and the composite indexes stop at the last
-- couple of days of live bot ticks.
--
-- This lays down ONE daily point per tea for the last 400 days (matching the
-- 400-day fetch floor in apiFetchPriceHistory). The series is anchored to each
-- tea's anchor_price and wanders organically via layered sinusoids + light noise,
-- so it reads like a real price line rather than random spikes.
--
-- Idempotent: a day is only filled if that tea has NO simulated row that day, so
-- re-running is safe and it never touches live or auction-derived rows.
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO price_history (symbol, price, volume, recorded_at, is_simulated)
SELECT
    t.symbol,
    GREATEST(
        t.anchor_price * 0.65,
        t.anchor_price * (
            1.0
            + 0.080 * sin(2 * pi() * (EXTRACT(EPOCH FROM d) / 86400.0) / 74.0)
            + 0.050 * sin(2 * pi() * (EXTRACT(EPOCH FROM d) / 86400.0) / 182.0 + 1.1)
            + 0.030 * sin(2 * pi() * (EXTRACT(EPOCH FROM d) / 86400.0) / 26.0 + 2.3)
            + (random() * 0.020 - 0.010)
        )
    ),
    0,
    d + INTERVAL '12 hours',
    true
FROM teas t
CROSS JOIN generate_series(
    CURRENT_DATE - INTERVAL '400 days',
    CURRENT_DATE,
    '1 day'::interval
) AS d
WHERE t.anchor_price > 0
  AND NOT EXISTS (
      SELECT 1 FROM price_history ph
      WHERE ph.symbol = t.symbol
        AND ph.is_simulated = true
        AND ph.recorded_at >= d
        AND ph.recorded_at <  d + INTERVAL '1 day'
  );
