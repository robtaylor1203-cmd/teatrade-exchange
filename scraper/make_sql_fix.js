const fs = require('fs');
const path = require('path');

const srcFile = path.join(__dirname, '..', 'supabase', 'migrations', '20260301000000_admin_analytics_v2.sql');
let code = fs.readFileSync(srcFile, 'utf8');

// Replace using regex to handle whitespace issues
code = code.replace(/SELECT target_id, error_message, records_updated, created_at[\s\S]*?FROM scraper_logs[\s\S]*?ORDER BY created_at DESC/g,
    \`SELECT target_id, error_message, NULL as records_updated, run_time as created_at
            FROM scraper_logs
            ORDER BY run_time DESC\`);

const destFile = path.join(__dirname, 'fix_admin_logs.sql');
fs.writeFileSync(destFile, code);
console.log("Created fix_admin_logs.sql properly now");
