-- ═══════════════════════════════════════════════════════════════════════════════
-- CLEAN UP: Delete all INDEX-level price_history rows written by the old
-- market-ticker Edge Function that stored `avg * idx.multiplier` instead of
-- raw USD averages.  The fix was deployed (market-ticker now stores USD), but
-- any rows written between the previous migration and the deployment are
-- double-multiplied and corrupt the chart Y-axis.
--
-- Also resets tea current_price = anchor_price for affected teas in case
-- drift accumulated from the contaminated period.
--
-- Strategy:
--   1. Delete ALL INDEX-level price_history (both contaminated ticker rows
--      and correct auction-backfill rows — simpler than surgical deletion).
--   2. Re-backfill auction data in correct USD.
--   3. Reset tea current_prices to anchor_prices so the new edge function
--      starts from a clean baseline.
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Wipe ALL index-level price_history
DELETE FROM price_history
WHERE symbol IN (SELECT symbol FROM indexes);

DELETE FROM price_history WHERE symbol = 'INDIA';

-- 2. Re-backfill from auction_results (divide INR by 83.5 to get USD)
INSERT INTO price_history (symbol, price, volume, recorded_at, is_simulated)
SELECT
    ar.centre,
    ar.avg_price_inr / 83.5,
    0,
    ar.auction_date + INTERVAL '12 hours',
    false
FROM auction_results ar
WHERE ar.centre IN (
    SELECT symbol FROM indexes
    UNION SELECT 'INDIA'
)
ON CONFLICT DO NOTHING;

-- 3. Reset tea current_prices to their anchor prices
UPDATE teas SET current_price = anchor_price
WHERE current_price <> anchor_price;
