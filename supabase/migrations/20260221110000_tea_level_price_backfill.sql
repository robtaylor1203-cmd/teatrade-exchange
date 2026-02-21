-- ═══════════════════════════════════════════════════════════════════════════════
-- TEA-LEVEL PRICE HISTORY BACKFILL
--
-- The composite chart path builds index OHLC from constituent TEA-level
-- price_history rows.  After previous cleanup migrations deleted all tea-level
-- data, charts had only a handful of market-ticker ticks (minutes old) and
-- showed a single bunched point on every timeframe.
--
-- This migration generates historical tea-level price_history from the
-- existing auction_results data.  For each auction date and each constituent
-- tea of the auctioned index, it creates a row whose price is proportional
-- to the tea's anchor_price and scaled so the cross-tea average matches the
-- actual auction realisation in USD.
--
-- Result: every Indian index chart immediately has 2+ years of weekly data
-- across all timeframes (1D through ALL), giving meaningful OHLC candles.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Remove any previously simulated tea-level rows to avoid duplicates
DELETE FROM price_history WHERE is_simulated = true
  AND symbol NOT IN (SELECT symbol FROM indexes)
  AND symbol <> 'INDIA';

-- Generate tea-level rows.
-- For each (index, auction_date), each constituent tea gets a price:
--   tea_price = tea.anchor_price × (auction_usd / avg_anchor) × (0.97 + rand*0.06)
-- where auction_usd = avg_price_inr / index.multiplier
-- This ensures the cross-tea average ≈ the auction realisation in USD.
INSERT INTO price_history (symbol, price, volume, recorded_at, is_simulated)
SELECT
    t.symbol,
    GREATEST(
        0.10,
        t.anchor_price
        * (ar.avg_price_inr / GREATEST(i.multiplier, 1))
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
WHERE idx_avg.avg_anchor > 0
ON CONFLICT DO NOTHING;
