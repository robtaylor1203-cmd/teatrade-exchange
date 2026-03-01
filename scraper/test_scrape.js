const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();
    const results = [];

    const urls = [
        "https://jthomasindia.com/auction_prices.php",
        "https://www.teaboard.gov.in/WEEKLYPRICES/2026",
        "https://www.atbltd.com/Docs/auctionprices",
        "https://www.tbeal.net/download-category/country-averages-auction-statistics/",
        "https://ceylonteabrokers.com/market-reports/",
        "https://vanrees.com/market-info/"
    ];

    for (const url of urls) {
        try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
            const html = await page.content();

            const selects = await page.$$eval('select', els => els.map(e => e.id || e.name || e.className));
            const inputs = await page.$$eval('input', els => els.map(e => e.type + ' ' + (e.id || e.name)));
            const links = await page.$$eval('a', els => els.map(e => ({ href: e.href, text: e.innerText.trim() })).filter(h => h.href && h.href.toLowerCase().includes('.pdf')).slice(0, 5));
            const tables = await page.$$eval('table', els => els.length);

            results.push({ url, status: 'success', selects, tables, inputs, pdfLinks: links });
        } catch (e) {
            results.push({ url, status: 'error', message: e.message });
        }
    }
    fs.writeFileSync('results.json', JSON.stringify(results, null, 2));
    await browser.close();
})();
