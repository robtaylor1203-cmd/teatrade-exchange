require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
    try {
        const { data, error } = await supabase.from('scraper_logs').select('target_id, error_message, records_updated, created_at').order('created_at', { ascending: false }).limit(5);
        console.log("Query result:", JSON.stringify({ data, error }, null, 2));
    } catch (e) {
        console.error("Query Error:", e);
    }
}
check();
