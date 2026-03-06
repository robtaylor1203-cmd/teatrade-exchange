// check schema
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE vars");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
    const { data, error } = await supabase.rpc('get_schema_info_for_table', { table_name: 'news' }).catch(() => ({}));
    if (error || !data) {
        // fallback
        const res = await supabase.from('news').select('*').limit(1);
        console.log('Sample row:', res.data);
    } else {
        console.log('Schema:', data);
    }
}

run();
