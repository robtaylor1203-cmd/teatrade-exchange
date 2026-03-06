// check news
require("dotenv").config({ path: "scraper/.env" });
const { createClient } = require("@supabase/supabase-js");
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
    const { data, error } = await supabase.from('news').select('*').limit(1);
    console.log(JSON.stringify(data[0] || {}, null, 2));
}
run();
