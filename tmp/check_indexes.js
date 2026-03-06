require('dotenv').config({ path: './scraper/.env' });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
    const { data, error } = await supabase
        .from('indexes')
        .select('*')
        .eq('symbol', 'KENYA');

    if (error) {
        console.error('Error:', error);
    } else {
        console.log(JSON.stringify(data[0], null, 2));
    }
}
run();
