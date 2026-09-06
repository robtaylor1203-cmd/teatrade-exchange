/**
 * TeaTrade Exchange — Auction Benchmark Ingester
 * =============================================
 * Pulls monthly global tea auction benchmark prices (USD/kg) from the
 * World Bank "Pink Sheet" (Commodity Markets), published under CC BY 4.0:
 *   https://www.worldbank.org/en/research/commodity-markets
 *
 * We extract four aggregated series only:
 *   GLOBAL  = "Tea, avg 3 auctions"
 *   MOMBASA = "Tea, Mombasa"
 *   COLOMBO = "Tea, Colombo"
 *   KOLKATA = "Tea, Kolkata"
 *
 * This is aggregated, attributed, non-granular data — no per-lot or broker
 * detail is stored or displayed. Attribution is shown on the Auctions page.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Run: npm run benchmarks
 */

const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const LANDING_PAGE = 'https://www.worldbank.org/en/research/commodity-markets';

// Map the World Bank column headers to our series keys.
const SERIES_MAP = {
    'tea, avg 3 auctions': 'GLOBAL',
    'tea, mombasa': 'MOMBASA',
    'tea, colombo': 'COLOMBO',
    'tea, kolkata': 'KOLKATA',
};

// Only keep the most recent N months to stay lean.
const MONTHS_TO_KEEP = 60;

async function resolveWorkbookUrl() {
    // The monthly XLSX link on the landing page carries a rotating hash, so we
    // discover it dynamically rather than hard-coding a URL that will break.
    const res = await fetch(LANDING_PAGE, { headers: { 'User-Agent': 'Mozilla/5.0 (TeaTrade benchmark ingester)' } });
    if (!res.ok) throw new Error(`Landing page fetch failed: ${res.status}`);
    const html = await res.text();
    const match = html.match(/https:\/\/[^"']*CMO-Historical-Data-Monthly\.xlsx/i);
    if (!match) throw new Error('Could not locate CMO-Historical-Data-Monthly.xlsx link on landing page');
    return match[0];
}

function parsePeriod(cell) {
    // World Bank periods look like "1960M01" or "2026M07".
    const m = String(cell).trim().match(/^(\d{4})M(\d{2})$/);
    if (!m) return null;
    return `${m[1]}-${m[2]}-01`;
}

async function main() {
    const url = await resolveWorkbookUrl();
    console.log('Workbook:', url);

    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (TeaTrade benchmark ingester)' } });
    if (!res.ok) throw new Error(`Workbook fetch failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheetName = wb.SheetNames.find(n => /monthly/i.test(n)) || wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, blankrows: false });

    // Locate the header row that names the tea columns.
    let headerRowIdx = -1;
    const colToSeries = {}; // column index -> series key
    for (let r = 0; r < Math.min(rows.length, 20); r++) {
        const row = rows[r] || [];
        for (let c = 0; c < row.length; c++) {
            const key = String(row[c] || '').trim().toLowerCase();
            if (SERIES_MAP[key]) {
                colToSeries[c] = SERIES_MAP[key];
                headerRowIdx = r;
            }
        }
        if (Object.keys(colToSeries).length >= 4) break;
    }
    if (headerRowIdx === -1 || Object.keys(colToSeries).length === 0) {
        throw new Error('Could not find tea columns in the Monthly Prices sheet');
    }
    console.log('Tea columns:', colToSeries);

    // Collect data rows (period in column 0).
    const records = [];
    for (let r = headerRowIdx + 1; r < rows.length; r++) {
        const row = rows[r] || [];
        const period = parsePeriod(row[0]);
        if (!period) continue;
        for (const c of Object.keys(colToSeries)) {
            const raw = row[c];
            const val = typeof raw === 'number' ? raw : parseFloat(raw);
            if (!Number.isFinite(val) || val <= 0) continue;
            records.push({
                series: colToSeries[c],
                period_date: period,
                price_usd_kg: Number(val.toFixed(4)),
                source: 'worldbank_pinksheet',
                source_url: url,
            });
        }
    }

    // Keep only the most recent MONTHS_TO_KEEP months per series.
    records.sort((a, b) => (a.period_date < b.period_date ? 1 : -1));
    const perSeriesCount = {};
    const trimmed = records.filter(rec => {
        perSeriesCount[rec.series] = (perSeriesCount[rec.series] || 0) + 1;
        return perSeriesCount[rec.series] <= MONTHS_TO_KEEP;
    });

    console.log(`Upserting ${trimmed.length} benchmark rows...`);
    const { error } = await supabase
        .from('auction_benchmarks')
        .upsert(trimmed, { onConflict: 'series,period_date' });
    if (error) throw error;

    console.log('Done. Latest per series:');
    for (const s of ['GLOBAL', 'MOMBASA', 'COLOMBO', 'KOLKATA']) {
        const latest = trimmed.filter(r => r.series === s)[0];
        if (latest) console.log(`  ${s}: ${latest.price_usd_kg} USD/kg (${latest.period_date})`);
    }
}

main().catch(err => {
    console.error('Benchmark ingest failed:', err.message);
    process.exit(1);
});
