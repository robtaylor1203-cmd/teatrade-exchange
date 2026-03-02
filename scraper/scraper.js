require('dotenv').config();
const fs = require('fs');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const targets = JSON.parse(fs.readFileSync('./targets.json', 'utf8'));

async function logError(targetId, errorMsg) {
    console.error(`[${targetId}] Error:`, errorMsg);
    try {
        await supabase.from('scraper_logs').insert([{ target_id: targetId, error_message: errorMsg }]);
    } catch (e) {
        console.error('Failed to log error to Supabase:', e.message);
    }
}

async function extractWithLLM(rawText, targetId) {
    const prompt = `
You are a reliable data extractor for a tea trading platform. Extract the tea auction data from the following raw text.
Return ONLY a strictly formatted JSON array containing objects that match the following schema.
If a data point is missing, try to estimate based on table headers or context, otherwise return null.

Schema:
{
  "symbol": "string (e.g., KEN-BP1, IND-ASM)",
  "price": number (the average, average closing, or sold price),
  "volume": number (total volume sold in kg),
  "auction_date": "YYYY-MM-DD"
}

Raw Text from ${targetId}:
---
${rawText.substring(0, 15000)}
---
`;

    const response = await openai.chat.completions.create({
        model: "gpt-4-turbo-preview",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" }
    });

    const parsedContent = JSON.parse(response.choices[0].message.content);
    const dataArray = Array.isArray(parsedContent) ? parsedContent : (parsedContent.data || Object.values(parsedContent)[0]);
    return Array.isArray(dataArray) ? dataArray : [];
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
                // Note: Without knowing exactly which dropdown values to select for the specific report, 
                // we will extract the available options and attempt to pull the first valid report.
                await page.waitForSelector('#cbocentre');
                const centres = await page.$$eval('#cbocentre option', opts => opts.map(o => o.value).filter(v => v !== '0'));
                if (centres.length > 0) {
                    await page.select('#cbocentre', centres[0]);
                    await new Promise(r => setTimeout(r, 2000)); // Wait for AJAX cascade
                    // Assuming 'cbosale' cascades next
                    const sales = await page.$$eval('#cbosale option', opts => opts.map(o => o.value).filter(v => v !== '0'));
                    if (sales.length > 0) await page.select('#cbosale', sales[0]);
                }
                const content = await page.content();
                const $ = cheerio.load(content);
                rawText = $('body').text(); // Grab everything, the LLM will parse it out
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

        console.log(`Extracted ${rawText.length} characters. Sending to LLM...`);
        const extractedData = await extractWithLLM(rawText, target.id);

        if (!extractedData || extractedData.length === 0) {
            throw new Error('LLM returned no usable JSON data.');
        }

        console.log(`LLM extracted ${extractedData.length} records. Injecting to Supabase...`);
        const { error } = await supabase
            .from('price_history')
            .upsert(extractedData, { onConflict: 'symbol,auction_date' });

        if (error) throw error;
        console.log(`Successfully completed: ${target.name}`);

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
    } finally {
        if (browser) await browser.close();
        console.log('\nScraping Script Finished.');
    }
}

run();
