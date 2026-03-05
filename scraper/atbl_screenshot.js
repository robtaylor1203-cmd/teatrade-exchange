const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();
    try {
        await page.goto("https://www.atbltd.com/Docs/auctionprices", { waitUntil: 'networkidle0', timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000));
        await page.screenshot({ path: 'atbl_debug.png' });
        console.log("Screenshot saved.");
    } catch (e) {
        console.error("Error:", e.message);
    }
    await browser.close();
})();
