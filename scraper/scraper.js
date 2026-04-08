require('dotenv').config();
const fs = require('fs');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');
// OpenAI removed — extraction is now 100% free via deterministic Cheerio parsing.

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

const targets = JSON.parse(fs.readFileSync('./targets.json', 'utf8'));

async function logError(targetId, errorMsg) {
    console.error(`[${targetId}] Error:`, errorMsg);
    try {
        await supabase.from('scraper_logs').insert([{ target_id: targetId, error_message: errorMsg }]);
    } catch (e) {
        console.error('Failed to log error to Supabase:', e.message);
    }
}

/**
 * Deterministic, zero-cost extraction using Cheerio.
 * Each source has a targeted parsing block keyed by target.id.
 * Add a new else-if block when onboarding a new auction source.
 */
async function extractDeterministically(rawHtml, targetId) {
    const $ = cheerio.load(rawHtml);
    const results = [];
    const today = new Date().toISOString().split('T')[0];

    const parseNum = (str) => parseFloat((str || '').replace(/[^0-9.]/g, '')) || null;
    const parseVol = (str) => parseInt((str || '').replace(/[^0-9]/g, ''), 10) || null;

    if (targetId === 'tea_board_india') {
        // Tea Board India: HTML table — cols: Symbol | Avg Price (INR/kg) | Volume (kg)
        $('table tr').each((i, row) => {
            if (i === 0) return; // skip header
            const cols = $(row).find('td');
            if (cols.length < 2) return;
            const symbol = $(cols[0]).text().trim();
            const price = parseNum($(cols[1]).text());
            const volume = cols.length >= 3 ? parseVol($(cols[2]).text()) : null;
            if (symbol && price) results.push({ symbol, price, volume, auction_date: today });
        });

    } else if (targetId === 'atb_ltd') {
        // ATBL: same general HTML table structure
        $('table tr').each((i, row) => {
            if (i === 0) return;
            const cols = $(row).find('td');
            if (cols.length < 2) return;
            const symbol = $(cols[0]).text().trim();
            const price = parseNum($(cols[1]).text());
            const volume = cols.length >= 3 ? parseVol($(cols[2]).text()) : null;
            if (symbol && price) results.push({ symbol, price, volume, auction_date: today });
        });

    } else if (targetId === 'j_thomas_india') {
        // J Thomas: cascaded report page — each centre's table follows the same pattern
        $('table tr').each((i, row) => {
            if (i === 0) return;
            const cols = $(row).find('td');
            if (cols.length < 2) return;
            const symbol = $(cols[0]).text().trim();
            const price = parseNum($(cols[1]).text());
            const volume = cols.length >= 3 ? parseVol($(cols[2]).text()) : null;
            if (symbol && price) results.push({ symbol, price, volume, auction_date: today });
        });

    } else if (targetId === 'ceylon_tea_brokers') {
        // Ceylon Tea Brokers: HTML report — look for rows with a valid price column
        $('table tr').each((i, row) => {
            if (i === 0) return;
            const cols = $(row).find('td');
            if (cols.length < 2) return;
            const symbol = $(cols[0]).text().trim();
            const price = parseNum($(cols[1]).text());
            const volume = cols.length >= 3 ? parseVol($(cols[2]).text()) : null;
            if (symbol && price) results.push({ symbol, price, volume, auction_date: today });
        });

    } else if (targetId === 'van_rees') {
        // Van Rees: generic table fallback after cookie acceptance
        $('table tr').each((i, row) => {
            if (i === 0) return;
            const cols = $(row).find('td');
            if (cols.length < 2) return;
            const symbol = $(cols[0]).text().trim();
            const price = parseNum($(cols[1]).text());
            const volume = cols.length >= 3 ? parseVol($(cols[2]).text()) : null;
            if (symbol && price) results.push({ symbol, price, volume, auction_date: today });
        });

    } else {
        console.warn(`[${targetId}] No deterministic parser defined for this target. Skipping.`);
    }

    return results.filter(r => r.symbol && r.price !== null && !isNaN(r.price));
}

async function scrapeTarget(target, browser) {
    console.log(`\nScraping target: ${target.name} (${target.type})`);
    const page = await browser.newPage();
    let rawText = '';

    try {
        await page.goto(target.url, { waitUntil: 'networkidle2', timeout: 45000 });

        switch (target.type) {
            case 'html_table': {
                // E.g., Tea Board India, ATBL
                const content = await page.content();
                const $ = cheerio.load(content);
                rawText = $(target.selector).text();
                // If it's empty (like recent ATBL updates), we will bypass instead of throwing
                if (!rawText || rawText.length < 50) {
                    console.warn(`[Warning] No valid data at selector: ${target.selector}`);
                    return; // Skip this target gracefully without throwing a failure
                }
                break;
            }

            case 'custom_jthomas': {
                // J Thomas requires cascading dropdown selections
                console.log("WAITING for JThomas dropdowns...");
                await page.waitForSelector('#cbocentre');
                const centres = await page.$$eval('#cbocentre option', opts => opts.map(o => o.value).filter(v => v !== '0'));

                rawText = "";
                for (let i = 0; i < centres.length; i++) {
                    console.log(`Selecting J Thomas centre: ${centres[i]}`);
                    await page.select('#cbocentre', centres[i]);
                    await new Promise(r => setTimeout(r, 2000)); // Wait for AJAX cascade

                    const sales = await page.$$eval('#cbosale option', opts => opts.map(o => o.value).filter(v => v !== '0'));
                    if (sales.length > 0) {
                        await page.select('#cbosale', sales[0]);
                        await new Promise(r => setTimeout(r, 2000)); // Wait for report to load

                        const content = await page.content();
                        const $ = cheerio.load(content);
                        // Append this centre's data to the rawText
                        rawText += `\n--- Centre: ${centres[i]} ---\n` + $('body').text();
                    }
                }
                break;
            }
            case 'custom_ceylon_html': {
                // Ceylon embeds links to HTML report pages instead of PDFs now
                await new Promise(r => setTimeout(r, 3000));

                const reportUrl = await page.$$eval('a', links => {
                    const l = links.find(l => l.href && (l.href.includes('report') || l.href.includes('pdf')) && l.innerText && l.innerText.length > 5);
                    return l ? l.href : null;
                });

                if (!reportUrl) throw new Error("Could not find a valid HTML report link on the page.");

                console.log(`Navigating to report HTML at ${reportUrl}...`);
                await page.goto(reportUrl, { waitUntil: 'networkidle2', timeout: 45000 });
                await new Promise(r => setTimeout(r, 2000));

                const content = await page.content();
                const $ = cheerio.load(content);
                rawText = $('body').text();

                if (!rawText || rawText.length < 50) throw new Error("Extracted HTML report text was empty.");
                break;
            }

            case 'custom_vanrees_cookie': {
                // Van Rees requires accepting a cookie modal before the data is accessible
                try {
                    const cookieBtn = await page.waitForSelector('.cmplz-accept', { timeout: 5000 });
                    if (cookieBtn) {
                        console.log("Accepting cookies...");
                        await cookieBtn.click();
                        await new Promise(r => setTimeout(r, 2000));
                    }
                } catch (e) {
                    console.log("No cookie banner found or timed out.");
                }
                const content = await page.content();
                rawText = cheerio.load(content)('body').text();
                break;
            }

            default:
                throw new Error(`Unknown scraper type: ${target.type}`);
        }

        if (!rawText || rawText.trim() === '') {
            throw new Error('Extracted text was empty or failed.');
        }

        // Grab the full HTML for deterministic parsing (rawText is plain-text for jthomas multi-centre)
        const pageContent = target.type === 'custom_jthomas' ? rawText : await page.content();
        console.log(`Extracted ${rawText.length} chars. Running deterministic parser...`);
        const extractedData = await extractDeterministically(pageContent, target.id);

        if (!extractedData || extractedData.length === 0) {
            throw new Error('Deterministic parser returned no usable data. Check table selectors for this source.');
        }

        console.log(`Parsed ${extractedData.length} records. Injecting to Supabase...`);
        const { error } = await supabase
            .from('price_history')
            .upsert(extractedData, { onConflict: 'symbol,auction_date' });

        if (error) throw error;
        console.log(`Successfully upserted data for: ${target.name}`);

        // FIX: Lift the HALTED trading mode for symbols that were just scraped.
        // Without this, the cron-imposed HALT is never reversed and the market
        // stays frozen even after fresh auction prices have been published.
        const symbolsScraped = extractedData.map(d => d.symbol).filter(Boolean);
        if (symbolsScraped.length > 0) {
            console.log(`Lifting HALT for ${symbolsScraped.length} symbols: ${symbolsScraped.slice(0, 5).join(', ')}...`);
            const { error: resumeError } = await supabase
                .from('teas')
                .update({ trading_mode: 'FULL' })
                .in('symbol', symbolsScraped);
            if (resumeError) {
                console.error('Failed to lift HALT:', resumeError.message);
            } else {
                console.log('Market HALT lifted. Trading resumed for scraped symbols.');
            }
        }

        // Log success to the database so the admin dashboard knows it worked
        try {
            await supabase.from('scraper_logs').insert([{
                target_id: target.id,
                records_updated: extractedData.length,
                error_message: null
            }]);
        } catch (e) {
            console.error('Failed to log success to Supabase:', e.message);
        }

    } catch (error) {
        await logError(target.id, error.message);
    } finally {
        await page.close();
    }
}

async function run() {
    console.log('Starting Advanced Scraper Pipeline...');
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        for (const target of targets) {
            await scrapeTarget(target, browser);
        }
    } catch (error) {
        console.error('Fatal Scraper Error:', error);
        try {
            await supabase.from('scraper_logs').insert([{ target_id: 'SYSTEM_FATAL', error_message: error.message }]);
        } catch (e) {}
    } finally {
        if (browser) await browser.close();
        console.log('\nScraping Script Finished.');
    }
}

run();
