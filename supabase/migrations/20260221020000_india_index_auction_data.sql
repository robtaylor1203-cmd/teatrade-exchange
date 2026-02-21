-- ═══════════════════════════════════════════════════════════════════════════════
-- ALL INDIA weighted average auction prices → INDIA index price_history
-- Source: Tea Board of India weekly reports (ALL INDIA column)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Store in auction_results for record-keeping
INSERT INTO auction_results (auction_date, centre, avg_price_inr, prev_year_inr) VALUES
    ('2026-01-03', 'INDIA', 161.38, 162.07),
    ('2026-01-10', 'INDIA', 169.40, 158.10),
    ('2026-01-17', 'INDIA', 164.75, 152.36),
    ('2026-01-24', 'INDIA', 160.32, 149.61),
    ('2026-01-31', 'INDIA', 153.96, 146.03),
    ('2026-02-07', 'INDIA', 156.07, 142.93)
ON CONFLICT (auction_date, centre) DO UPDATE
    SET avg_price_inr = EXCLUDED.avg_price_inr,
        prev_year_inr = EXCLUDED.prev_year_inr;

-- Backfill into price_history so the INDIA index chart shows real auction data.
-- Convert INR → USD using the INDIA index multiplier from the indexes table.
INSERT INTO price_history (symbol, price, volume, recorded_at, is_simulated)
SELECT
    'INDIA',
    ar.avg_price_inr / COALESCE(i.multiplier, 87.50),
    0,
    ar.auction_date + INTERVAL '12 hours',
    false
FROM auction_results ar
LEFT JOIN indexes i ON i.symbol = 'INDIA'
WHERE ar.centre = 'INDIA'
ON CONFLICT DO NOTHING;
