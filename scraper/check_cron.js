require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
    console.log("Checking price_history...");
    const { data: prices, error: err1 } = await supabase
        .from('price_history')
        .select('symbol, recorded_at')
        .order('recorded_at', { ascending: false })
        .limit(10);

    if (err1) console.error("Error fetching prices:", err1);
    else console.log("Latest prices:", prices);

    console.log("\nChecking scraper_logs...");
    const { data: logs, error: err2 } = await supabase
        .from('scraper_logs')
        .select('*')
        .limit(5);

    if (err2) console.error("Error fetching logs:", err2);
    else console.log("Latest logs length:", logs.length);

    require('fs').writeFileSync('cron_db_check.json', JSON.stringify({ prices, logs }, null, 2), 'utf8');
}

check();
