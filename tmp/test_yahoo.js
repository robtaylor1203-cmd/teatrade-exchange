async function testYahoo() {
    try {
        const url = 'https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?interval=1d&range=5d';
        console.log("Fetching: " + url);
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        console.log("Status: " + resp.status);
        const data = await resp.text();
        console.log("Body: " + data.substring(0, 200));
    } catch (e) {
        console.error(e);
    }
}

testYahoo();
