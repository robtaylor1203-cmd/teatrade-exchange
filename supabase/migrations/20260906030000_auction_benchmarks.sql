-- ═══════════════════════════════════════════════════════════════════════════════
-- AUCTION BENCHMARKS
-- Monthly global tea auction benchmark prices (USD/kg) sourced from the
-- World Bank "Pink Sheet" (Commodity Markets), published under CC BY 4.0.
-- Populated by scraper/benchmark_ingest.js via a monthly GitHub Action.
-- Purely aggregated, attributed, non-granular data — no per-lot / broker detail.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS auction_benchmarks (
    id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    series        TEXT        NOT NULL,          -- 'GLOBAL' | 'MOMBASA' | 'COLOMBO' | 'KOLKATA'
    period_date   DATE        NOT NULL,          -- first day of the reported month
    price_usd_kg  NUMERIC     NOT NULL,
    source        TEXT        NOT NULL DEFAULT 'worldbank_pinksheet',
    source_url    TEXT,
    fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (series, period_date)
);

CREATE INDEX IF NOT EXISTS idx_auction_benchmarks_series_date
    ON auction_benchmarks (series, period_date DESC);

ALTER TABLE auction_benchmarks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Auction benchmarks readable by all" ON auction_benchmarks;
CREATE POLICY "Auction benchmarks readable by all"
    ON auction_benchmarks FOR SELECT USING (true);
