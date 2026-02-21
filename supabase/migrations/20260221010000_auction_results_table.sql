-- ═══════════════════════════════════════════════════════════════════════════════
-- AUCTION RESULTS TABLE
-- Stores real weekly weighted-average auction prices (INR) by centre.
-- Used to anchor simulated prices and populate historical charts.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS auction_results (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    auction_date    DATE NOT NULL,
    centre          TEXT NOT NULL,
    avg_price_inr   NUMERIC NOT NULL,
    prev_year_inr   NUMERIC,
    currency        TEXT NOT NULL DEFAULT 'INR',
    source          TEXT NOT NULL DEFAULT 'india_tea_board',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (auction_date, centre)
);

CREATE INDEX IF NOT EXISTS idx_auction_centre_date
    ON auction_results (centre, auction_date DESC);

ALTER TABLE auction_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auction results readable by all"
    ON auction_results FOR SELECT USING (true);

-- ─── SEED: India auction data (Jan–Feb 2026) ────────────────────────────────
-- Centres: KOLKATA, GUWAHATI, SILIGURI, JALPAIGURI, COCHIN, COONOOR, COIMBATORE
-- Prices are weighted average INR/kg. NS = No Sale (omitted).

INSERT INTO auction_results (auction_date, centre, avg_price_inr, prev_year_inr) VALUES
    -- 03/01/2026
    ('2026-01-03', 'KOLKATA',    200.24, 190.21),
    ('2026-01-03', 'GUWAHATI',   177.52, 158.81),
    ('2026-01-03', 'SILIGURI',   176.28, 152.42),
    ('2026-01-03', 'COCHIN',     174.62, NULL),
    ('2026-01-03', 'COONOOR',    112.44, 128.75),
    ('2026-01-03', 'COIMBATORE', 151.01, 151.06),
    -- 10/01/2026
    ('2026-01-10', 'KOLKATA',    197.72, 177.59),
    ('2026-01-10', 'GUWAHATI',   170.53, 157.15),
    ('2026-01-10', 'SILIGURI',   162.86, 150.88),
    ('2026-01-10', 'COCHIN',     180.05, 171.51),
    ('2026-01-10', 'COONOOR',    114.01, 126.56),
    ('2026-01-10', 'COIMBATORE', 152.58, 148.74),
    -- 17/01/2026
    ('2026-01-17', 'KOLKATA',    189.11, 164.38),
    ('2026-01-17', 'SILIGURI',   153.26, 149.39),
    ('2026-01-17', 'COCHIN',     182.81, 172.42),
    ('2026-01-17', 'COONOOR',    114.64, 124.73),
    ('2026-01-17', 'COIMBATORE', 155.33, 147.27),
    -- 24/01/2026
    ('2026-01-24', 'KOLKATA',    183.65, 159.22),
    ('2026-01-24', 'GUWAHATI',   163.67, 147.23),
    ('2026-01-24', 'SILIGURI',   144.31, 149.27),
    ('2026-01-24', 'COCHIN',     180.36, 172.92),
    ('2026-01-24', 'COONOOR',    114.97, 124.15),
    ('2026-01-24', 'COIMBATORE', 158.75, 149.49),
    -- 31/01/2026
    ('2026-01-31', 'KOLKATA',    175.15, 154.73),
    ('2026-01-31', 'GUWAHATI',   157.78, 150.39),
    ('2026-01-31', 'SILIGURI',   133.87, 139.71),
    ('2026-01-31', 'COCHIN',     181.87, 171.40),
    ('2026-01-31', 'COONOOR',    115.46, 124.01),
    ('2026-01-31', 'COIMBATORE', 159.01, 146.82),
    -- 07/02/2026
    ('2026-02-07', 'KOLKATA',    180.71, 145.65),
    ('2026-02-07', 'GUWAHATI',   155.93, 151.74),
    ('2026-02-07', 'SILIGURI',   130.44, 135.99),
    ('2026-02-07', 'COCHIN',     182.05, 169.09),
    ('2026-02-07', 'COONOOR',    116.34, 123.58),
    ('2026-02-07', 'COIMBATORE', 158.91, 143.65)
ON CONFLICT (auction_date, centre) DO UPDATE
    SET avg_price_inr = EXCLUDED.avg_price_inr,
        prev_year_inr = EXCLUDED.prev_year_inr;

-- ─── BACKFILL price_history from auction results ────────────────────────────
-- Insert one price_history row per auction result so charts can plot real
-- auction data alongside simulated ticks. Price is converted from INR to
-- USD using the INR multiplier (≈87.50) stored in the indexes table.
-- We use the INDEX symbol (e.g. 'KOLKATA') as the price_history symbol.
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
