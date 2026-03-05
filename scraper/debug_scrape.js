const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();
    const result = { atbl: {}, ceylon: {} };

    console.log("=== ATBL ===");
    try {
        await page.goto("https://www.atbltd.com/Docs/auctionprices", { waitUntil: 'networkidle2' });
        await new Promise(r => setTimeout(r, 3000));
        result.atbl.frames = page.frames().length;
        result.atbl.bodyText = await page.$eval('body', el => el.innerText.substring(0, 1000));
        result.atbl.tableLengths = await page.$$eval('table', els => els.map(e => e.innerText.length));
    } catch (e) {
        result.atbl.error = e.message;
    }

    console.log("\n=== CEYLON ===");
    try {
        await page.goto("https://ceylonteabrokers.com/market-reports/", { waitUntil: 'networkidle2' });
        await new Promise(r => setTimeout(r, 3000));
        const links = await page.$$eval('a', els => els.map(e => ({ href: e.href, text: e.innerText })));
        result.ceylon.reportLinks = links.filter(l => l.href.includes('report') || l.href.includes('pdf')).slice(0, 20);
    } catch (e) {
        result.ceylon.error = e.message;
    }

    fs.writeFileSync('debug_output.json', JSON.stringify(result, null, 2));
    await browser.close();
})();
