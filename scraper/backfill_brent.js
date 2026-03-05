require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Run inside scraper folder.");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function backfillBrent() {
    try {
        console.log("Fetching Brent Crude history from Yahoo Finance...");
        const url = 'https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?interval=1d&range=5d';
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });

        if (!resp.ok) {
            throw new Error(`Yahoo returned ${resp.status}`);
        }

        const data = await resp.json();
        const result = data?.chart?.result?.[0];
        const timestamps = result?.timestamp ?? [];
        let closes = [];
        if (result?.indicators?.quote?.[0]?.close) {
            closes = result.indicators.quote[0].close;
        }

        const historyRows = [];
        for (let i = 0; i < timestamps.length; i++) {
            const ts = timestamps[i];
            const price = closes[i];
            if (ts != null && price != null) {
                const recorded_at = new Date(ts * 1000).toISOString();
                historyRows.push({
                    symbol: 'brent_crude',
                    price: price,
                    volume: 0,
                    recorded_at: recorded_at,
                    is_simulated: false
                });
            }
        }

        if (historyRows.length === 0) {
            console.log("No valid rows parsed from Yahoo.");
            return;
        }

        console.log(`Inserting ${historyRows.length} rows into price_history...`);
        const { error } = await supabase.from('price_history').insert(historyRows);

        if (error) {
            console.error("Supabase insert error:", error);
        } else {
            console.log("Successfully backfilled brent_crude history!");
        }
    } catch (e) {
        console.error("Backfill failed:", e);
    }
}

backfillBrent();
