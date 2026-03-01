import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://uznxzyuknigzlxecjgtb.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6bnh6eXVrbmlnemx4ZWNqZ3RiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDkzNzk4NSwiZXhwIjoyMDg2NTEzOTg1fQ.GDHUqRUefcE5iTpMbk8-a00Yd6QT-5d2Pqve4Ze5ryY';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function run() {
    console.log('Fetching teas...');
    const { data: teas, error: teasErr } = await supabase.from('teas').select('id, symbol, current_price');
    if (teasErr) {
        console.error('Error fetching teas:', teasErr);
        return;
    }

    const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const startTime = now - TWO_YEARS_MS;

    console.log(`Generating fake price history for ${teas.length} instruments...`);

    for (const tea of teas) {
        console.log(`Processing ${tea.symbol}...`);
        const historyRows = [];
        let currentSimPrice = tea.current_price * (Math.random() * (1.5 - 0.5) + 0.5);

        // Generate daily points
        for (let time = startTime; time < now; time += 24 * 60 * 60 * 1000) {
            const dailyVolatility = (Math.random() * 0.04) - 0.02;
            currentSimPrice = currentSimPrice * (1 + dailyVolatility);

            if (currentSimPrice < 0.1) currentSimPrice = 0.1;

            historyRows.push({
                symbol: tea.symbol,
                price: currentSimPrice,
                recorded_at: new Date(time).toISOString()
            });
        }

        // Insert in batches of 500
        for (let i = 0; i < historyRows.length; i += 500) {
            const batch = historyRows.slice(i, i + 500);
            const { error: insErr } = await supabase.from('price_history').insert(batch);
            if (insErr) {
                console.error(`Error inserting batch for ${tea.symbol} at offset ${i}:`, insErr);
            }
        }
    }

    console.log('Historical backfill complete.');
}

run();
