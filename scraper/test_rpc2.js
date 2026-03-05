require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
    try {
        const { data, error } = await supabase.rpc('admin_analytics');
        console.log("RPC result:", JSON.stringify({ data, error }, null, 2));
    } catch (e) {
        console.error("RPC Error:", e);
    }
}
check();
