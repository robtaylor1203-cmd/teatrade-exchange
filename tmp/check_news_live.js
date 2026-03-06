const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE vars");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
    console.log("Checking tables...");

    // We can select from information_schema
    // but using the JS client we can only query exposed tables.
    // Wait, let's just do a blind call or test table reflection.

    // Let's actually use a node script using `pg` if we had the DB url, but we don't.
    // Instead, let's just query a known working table. And check if news works at all.

    const { data, error } = await supabase.from('news').select('*').limit(1);
    console.log("news table fetch result:", { data, error });
}
run();
