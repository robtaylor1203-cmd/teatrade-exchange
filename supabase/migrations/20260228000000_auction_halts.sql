-- Migration for daily/weekly auction halt schedules
-- Auctions halt the symbol roughly 1 hour before, and are released 
-- manually (or by the scraper) when the new VWAP anchor is snapped.

-- Halt Mombasa 
-- Mombasa auctions occur on Tuesday approx 08:30 EAT (05:30 UTC)
-- We halt trading early Tuesday morning
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.schedule(
            'halt_mombasa_auction',
            '30 4 * * 2', -- 04:30 UTC every Tuesday
            $$UPDATE teas SET trading_mode = 'HALTED' WHERE symbol IN ('KEN-BP1', 'KEN-PF1', 'KEN-DUST', 'KEN-PD', 'KEN-BMF', 'KEN-FNGS', 'KENYA', 'MOMBASA');$$
        );
    END IF;
END $$;

-- Halt Kolkata 
-- Kolkata auctions occur on Wednesday approx 09:00 IST (03:30 UTC)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.schedule(
            'halt_kolkata_auction',
            '30 2 * * 3', -- 02:30 UTC every Wednesday
            $$UPDATE teas SET trading_mode = 'HALTED' WHERE symbol IN ('IND-ASM', 'IND-DRJ', 'KOL-SF', 'KOL-AUT', 'KOL-GOLD', 'INDIA', 'KOLKATA');$$
        );
    END IF;
END $$;

-- Halt Colombo
-- Colombo auctions occur on Wednesday approx 08:00 IST (02:30 UTC)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.schedule(
            'halt_colombo_auction',
            '30 1 * * 3', -- 01:30 UTC every Wednesday
            $$UPDATE teas SET trading_mode = 'HALTED' WHERE symbol IN ('SRI-BOP', 'SRI-PEK', 'SRI-OP', 'SRI-FBOP', 'SRI-DUST', 'SRI-BOP1', 'CEYLON', 'COLOMBO');$$
        );
    END IF;
END $$;

-- Halt Jakarta
-- Jakarta auctions occur on Wednesday approx 09:30 WIB (02:30 UTC)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.schedule(
            'halt_jakarta_auction',
            '30 1 * * 3', -- 01:30 UTC every Wednesday
            $$UPDATE teas SET trading_mode = 'HALTED' WHERE symbol IN ('IDN-BOP', 'IDN-PF', 'IDN-DUST', 'IDN-BT', 'INDONESIA', 'JAKARTA');$$
        );
    END IF;
END $$;
