-- Performance index for chart/price-cache queries.
-- The frontend fetches history as: WHERE symbol = ? AND is_simulated = ?
--   AND recorded_at >= ? ORDER BY recorded_at DESC LIMIT ?
-- The existing (symbol, recorded_at DESC) index leaves is_simulated as a
-- post-filter; on a large price_history table this can hit statement_timeout
-- and surface to the client as HTTP 500. This composite index makes those
-- queries index-only and fast.
--
-- NOTE: If price_history is very large in production, build this CONCURRENTLY
-- from the SQL editor instead (cannot run inside a migration transaction):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_price_history_sym_sim_time
--       ON price_history (symbol, is_simulated, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_price_history_sym_sim_time
    ON price_history (symbol, is_simulated, recorded_at DESC);

ANALYZE price_history;
