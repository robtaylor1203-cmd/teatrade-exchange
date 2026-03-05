async function testYahoo() {
    try {
        const targetUrl = encodeURIComponent('https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?interval=1d&range=5d');
        const url = `https://corsproxy.io/?${targetUrl}`;
        console.log("Fetching: " + url);
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        console.log("Status: " + resp.status);
        const data = await resp.text();
        console.log(data.substring(0, 300));
    } catch (e) {
        console.error(e);
    }
}

testYahoo();
