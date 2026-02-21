-- FIX: Double-multiplier bug in index price_history
--
-- The market-ticker edge function was storing index prices as:
--   avg_usd * idx.multiplier  (i.e. already converted to local currency)
-- But the chart rendering layer (charts.js, hub.js) ALSO multiplies by the
-- live forex rate for display, causing double-conversion:
--   KOLKATA: $8 * 83 (ticker) * 87.5 (chart) ≈ ₹58,000  (should be ~₹700)
--   COLOMBO: $4.6 * 305 (ticker) * 305 (chart) ≈ Rs428,000  (should be ~₹1,400)
--
-- Fix: market-ticker now stores raw USD averages (no multiplier).
-- This migration cleans up existing corrupted rows and re-backfills auction data.

-- Step 1: Delete ALL index price_history (both corrupted ticker rows and
--         auction backfill rows — we'll re-insert the auction data cleanly)
DELETE FROM price_history
WHERE symbol IN (SELECT symbol FROM indexes);

-- INDIA is used as an auction centre but isn't in the indexes table
DELETE FROM price_history WHERE symbol = 'INDIA';

-- Step 2: Re-backfill from auction_results (correct USD conversion)
INSERT INTO price_history (symbol, price, volume, recorded_at, is_simulated)
SELECT
    ar.centre,
    ar.avg_price_inr / COALESCE(i.multiplier, 87.50),
    0,
    ar.auction_date + INTERVAL '12 hours',
    false
FROM auction_results ar
LEFT JOIN indexes i ON i.symbol = ar.centre
ON CONFLICT DO NOTHING;
