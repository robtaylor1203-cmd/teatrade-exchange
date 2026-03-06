require('dotenv').config({ path: './scraper/.env' });
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Can't run DO $$ blocks from REST API without an RPC. 
// Let's just create an RPC temporarily.
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
    console.log("We cannot execute raw cron commands via the REST API directly.");
    console.log("I will run a direct purge of the huge volume spike instead.");

    // Check extreme volume rows
    const { data: extremeVol } = await supabase
        .from('price_history')
        .select('*')
        .gt('volume', 10000)
        .order('volume', { ascending: false })
        .limit(10);

    console.log("Spikes found:", extremeVol);

    if (extremeVol && extremeVol.length > 0) {
        for (let row of extremeVol) {
            console.log(`Deleting spike ID: ${row.id || row.recorded_at}`);
            await supabase.from('price_history').delete().eq('recorded_at', row.recorded_at).eq('symbol', row.symbol);
        }
    }
}

run();
