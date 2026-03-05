// =============================================
// MACRO INDICATOR DETAIL POPOUT
// Fetches 7-day forex history from @fawazahmed0/currency-api (free, no key)
// =============================================

const MACRO_DEFS = {
    usdkes: {
        stateKey: 'usd_kes',
        base: 'usd',
        quote: 'kes',
        name: 'USD / KES',
        fullName: 'Kenyan Shilling',
        flagIso: 'ke',
        type: 'forex',
        decimals: 2,
        spreadPct: 0.04,
        unit: 'KES per USD',
        centralBank: 'Central Bank of Kenya',
        cbRate: '12.50%',
        nextReview: 'Apr 2026',
        correlation: 'High positive',
        corrNote: 'Tea ≈ 26% of Kenya export earnings',
        insight: 'A weaker KES makes Kenyan auction teas cheaper in USD terms, driving higher volumes at the Mombasa auction. Watch this pair closely before any weekly auction — a sharp KES move can shift competitive bids significantly.',
        impactLabel: 'Mombasa Auction',
        impactIcon: '🍃',
        trivia: 'Kenya is the world\'s largest exporter of black CTC teas, primarily priced in USD at the Mombasa exchange.',
    },
    usdinr: {
        stateKey: 'usd_inr',
        base: 'usd',
        quote: 'inr',
        name: 'USD / INR',
        fullName: 'Indian Rupee',
        flagIso: 'in',
        type: 'forex',
        decimals: 2,
        spreadPct: 0.03,
        unit: 'INR per USD',
        centralBank: 'Reserve Bank of India',
        cbRate: '6.50%',
        nextReview: 'Apr 2026',
        correlation: 'Moderate positive',
        corrNote: 'Tea ≈ 3% of India export earnings',
        insight: 'INR weakness boosts the USD value of Darjeeling and Assam teas for overseas buyers. India also consumes ~80% of its own crop, so INR strength raises domestic demand and reduces export surplus.',
        impactLabel: 'Kolkata Auction',
        impactIcon: '🫖',
        trivia: 'India is the world\'s second-largest tea producer. Darjeeling First Flush, priced in INR, commands a global premium.',
    },
    usdlkr: {
        stateKey: 'usd_lkr',
        base: 'usd',
        quote: 'lkr',
        name: 'USD / LKR',
        fullName: 'Sri Lankan Rupee',
        flagIso: 'lk',
        type: 'forex',
        decimals: 2,
        spreadPct: 0.12,
        unit: 'LKR per USD',
        centralBank: 'Central Bank of Sri Lanka',
        cbRate: '8.00%',
        nextReview: 'Mar 2026',
        correlation: 'High positive',
        corrNote: 'Tea ≈ 15% of Sri Lanka export earnings',
        insight: 'Ceylon tea is heavily dependent on USD export revenue. LKR volatility (which has been extreme since 2022) can devastate or boost local grower margins. A sharp LKR depreciation temporarily boosts USD-denominated competitiveness.',
        impactLabel: 'Colombo Auction',
        impactIcon: '🌿',
        trivia: 'Sri Lanka\'s tea sector employs over 1 million people. The 2022 LKR crisis forced a structural reset in auction pricing.',
    },
    usdcny: {
        stateKey: 'usd_cny',
        base: 'usd',
        quote: 'cny',
        name: 'USD / CNY',
        fullName: 'Chinese Yuan',
        flagIso: 'cn',
        type: 'forex',
        decimals: 4,
        spreadPct: 0.02,
        unit: 'CNY per USD',
        centralBank: 'People\'s Bank of China',
        cbRate: '3.45%',
        nextReview: 'Ongoing (managed)',
        correlation: 'Moderate',
        corrNote: 'China is the world\'s largest tea producer',
        insight: 'A stronger CNY increases Chinese purchasing power for imported specialty teas. As the world\'s largest producer and consumer, China\'s currency moves ripple across global tea commodity markets.',
        impactLabel: 'Global Tea Supply',
        impactIcon: '🍵',
        trivia: 'China produces ≈47% of global tea output. The yuan is a managed float — PBoC sets a daily midpoint rate limiting daily moves to ±2%.',
    },
    oil: {
        stateKey: 'brent_crude',
        base: null,
        quote: null,
        name: 'Brent Crude',
        fullName: 'ICE Brent · $/bbl',
        flagIso: null,
        flagFallback: '🛢️',
        type: 'commodity',
        decimals: 2,
        spreadPct: 0.05,
        unit: 'USD per barrel',
        centralBank: 'OPEC+',
        cbRate: '~9Mb/d cuts',
        nextReview: 'Jun 2026',
        correlation: 'High negative',
        corrNote: 'Higher oil raises freight & packaging costs',
        insight: 'Brent Crude is the global shipping cost proxy for tea. A $10/bbl rise increases freight costs from East Africa to Europe by approximately 4–7%. This directly compresses margins on bulk tea shipments and raises insurance premiums for commodity cargo.',
        impactLabel: 'Freight & Logistics',
        impactIcon: '🚢',
        trivia: 'A single container of bulk tea shipped from Mombasa to Rotterdam consumes roughly 2 tonnes of bunker fuel. Bunker fuel prices track Brent closely.',
    },
};

// Cache: { key → { fetchedAt, history[] } }
const _macroHistoryCache = {};

// ─── History fetch ─────────────────────────────────────────────────────────

async function _fetchForexHistory(base, quote, days = 7) {
    const today = new Date();
    const fetches = Array.from({ length: days }, (_, i) => {
        const d = new Date(today);
        d.setDate(d.getDate() - (days - 1 - i));
        const dateStr = d.toISOString().split('T')[0];
        const url = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${dateStr}/v1/currencies/${base}.min.json`;
        return fetch(url)
            .then(r => r.json())
            .then(data => ({ date: dateStr, rate: data?.[base]?.[quote] ?? null }))
            .catch(() => ({ date: dateStr, rate: null }));
    });
    return Promise.all(fetches);
}

async function _getHistory(def) {
    const cached = _macroHistoryCache[def.stateKey];
    if (cached && Date.now() - cached.fetchedAt < 30 * 60 * 1000) return cached.history;

    let history = [];
    if (def.type === 'forex' && def.base && def.quote) {
        history = await _fetchForexHistory(def.base, def.quote, 7);
    } else if (def.type === 'commodity' && def.stateKey === 'brent_crude') {
        // Brent crude: try to fetch 5-day chart from Yahoo Finance
        try {
            // Rather than fetching from Yahoo Finance directly (which blocks frontend CORS),
            // the Supabase market-ticker now saves "brent_crude" directly to the price_history table.
            // We fetch the latest 5 days (1440 rows at 5-minute intervals) and downsample
            // to daily closing prices for the sparkline.

            const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
            const { data, error } = await apiFetchPriceHistory('brent_crude', 1500, fiveDaysAgo);

            if (!error && data && data.length > 0) {
                // We have 5-min candles. We just need 1 per day for the sparkline.
                // Group by day (YYYY-MM-DD):
                const dailyMap = {};
                data.forEach(row => {
                    const dateRaw = row.recorded_at ? row.recorded_at.split('T')[0] : null;
                    if (dateRaw && row.price) {
                        // The last row processed for a given date will natural act as the 'close' price
                        dailyMap[dateRaw] = row.price;
                    }
                });

                // Convert back to sorted array
                history = Object.keys(dailyMap).sort().map(d => ({
                    date: d,
                    rate: dailyMap[d]
                }));
            }
        } catch (e) {
            console.error('[MacroPopout] Brent crude fetch error:', e);
        }
    }
    _macroHistoryCache[def.stateKey] = { fetchedAt: Date.now(), history };
    return history;
}

// ─── Sparkline SVG ─────────────────────────────────────────────────────────

function _buildSparkline(history, W = 258, H = 52) {
    const pts = history.map(d => d.rate).filter(v => v != null);
    if (pts.length < 2) return `<div class="mp-spark-nodata">Insufficient history</div>`;

    const lo = Math.min(...pts), hi = Math.max(...pts);
    const range = hi - lo || lo * 0.001;

    const coords = pts.map((v, i) => {
        const x = (i / (pts.length - 1)) * W;
        const y = H - 4 - ((v - lo) / range) * (H - 10);
        return [x, y];
    });

    const isUp = pts[pts.length - 1] >= pts[0];
    const stroke = isUp ? '#10b981' : '#ef4444';
    const fillId = `spark-fill-${Math.random().toString(36).slice(2, 7)}`;

    const pathD = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const areaD = pathD + ` L${W},${H} L0,${H} Z`;

    const labels = history.map(d => {
        const date = new Date(d.date + 'T12:00:00');
        return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
    });

    const labelSpacing = W / (labels.length - 1);
    const labelEls = labels.map((l, i) =>
        `<text x="${(i * labelSpacing).toFixed(1)}" y="${H + 13}" text-anchor="middle" class="spark-label">${l}</text>`
    ).join('');

    // Dot on last point
    const [lx, ly] = coords[coords.length - 1];
    const loLabel = `${lo.toFixed(2)}`;
    const hiLabel = `${hi.toFixed(2)}`;

    return `
    <svg width="${W}" height="${H + 16}" viewBox="0 0 ${W} ${H + 16}" class="mp-sparkline">
        <defs>
            <linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="${stroke}" stop-opacity="0.18"/>
                <stop offset="100%" stop-color="${stroke}" stop-opacity="0"/>
            </linearGradient>
        </defs>
        <path d="${areaD}" fill="url(#${fillId})"/>
        <path d="${pathD}" fill="none" stroke="${stroke}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3" fill="${stroke}"/>
        <text x="2" y="${H - 2}" class="spark-range-label">${hiLabel}</text>
        <text x="2" y="${H - 2 + (H > 30 ? H - 12 : 12)}" class="spark-range-label" style="dominant-baseline:auto">${loLabel}</text>
        ${labelEls}
    </svg>`;
}

// ─── Popout build ──────────────────────────────────────────────────────────

function _changeClass(pct) {
    if (pct > 0) return 'up';
    if (pct < 0) return 'down';
    return '';
}

function _pctBadge(pct) {
    if (pct == null || isNaN(pct)) return '<span class="mp-badge neutral">—</span>';
    const sign = pct > 0 ? '+' : '';
    const cls = _changeClass(pct);
    const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '';
    return `<span class="mp-badge ${cls}">${arrow} ${sign}${pct.toFixed(3)}%</span>`;
}

async function openMacroPopout(id, rowEl) {
    const def = MACRO_DEFS[id];
    if (!def) return;

    const pop = document.getElementById('macro-popout');
    const overlay = document.getElementById('macro-popout-overlay');
    if (!pop || !overlay) return;

    // Get current price from state
    const raw = state?.macroIndicators?.[def.stateKey];
    const prev = state?.macroBaseline?.[def.stateKey] ?? state?.previousMacro?.[def.stateKey];
    const price = Number(raw);

    const pct = (!isNaN(price) && !isNaN(Number(prev)) && Number(prev) !== 0)
        ? ((price - Number(prev)) / Number(prev)) * 100
        : null;

    // Bid / ask
    const half = (def.spreadPct / 100) * price / 2;
    const bid = (price - half).toFixed(def.decimals);
    const ask = (price + half).toFixed(def.decimals);
    const spread = (price * def.spreadPct / 100).toFixed(def.decimals);

    // Show loading state immediately
    pop.style.display = 'block';
    overlay.style.display = 'block';
    _positionPopout(pop, rowEl);

    pop.innerHTML = `
    <div class="mp-close-btn" onclick="closeMacroPopout()">✕</div>

    <div class="mp-header">
        <div class="mp-title-row">
            <span class="mp-flag">${def.flagIso ? flagImg(def.flagIso, 28) : (def.flagFallback || '')}</span>
            <div>
                <div class="mp-name">${def.name}</div>
                <div class="mp-fullname">${def.fullName}</div>
            </div>
            <div class="mp-price-block">
                <span class="mp-price ${_changeClass(pct)}">${isNaN(price) ? '—' : price.toFixed(def.decimals)}</span>
                ${_pctBadge(pct)}
            </div>
        </div>
        <div class="mp-unit-row">${def.unit}</div>
    </div>

    <div class="mp-metrics-row">
        <div class="mp-metric-sm">
            <span class="mp-metric-sm-label">Bid</span>
            <span class="mp-metric-sm-val">${isNaN(price) ? '—' : bid}</span>
        </div>
        <div class="mp-metric-sm">
            <span class="mp-metric-sm-label">Ask</span>
            <span class="mp-metric-sm-val">${isNaN(price) ? '—' : ask}</span>
        </div>
        <div class="mp-metric-sm">
            <span class="mp-metric-sm-label">Spread</span>
            <span class="mp-metric-sm-val">${isNaN(price) ? '—' : spread}</span>
        </div>
        <div class="mp-metric-sm">
            <span class="mp-metric-sm-label">Type</span>
            <span class="mp-metric-sm-val">${def.type === 'forex' ? 'FX Spot' : 'Commodity'}</span>
        </div>
    </div>

    <div class="mp-chart-section">
        <div class="mp-section-title">7-Day Price History</div>
        <div id="mp-spark-container" class="mp-spark-container">
            <div class="mp-spark-loading">Loading chart…</div>
        </div>
    </div>

    <div class="mp-insight-box">
        <div class="mp-insight-header">${def.impactIcon} ${def.impactLabel} — Tea Trader Insight</div>
        <div class="mp-insight-text">${def.insight}</div>
    </div>

    <div class="mp-info-grid">
        <div class="mp-info-cell">
            <span class="mp-info-label">${def.type === 'commodity' ? 'Cartel / Body' : 'Central Bank'}</span>
            <span class="mp-info-val">${def.centralBank}</span>
        </div>
        <div class="mp-info-cell">
            <span class="mp-info-label">${def.type === 'commodity' ? 'Production Cuts' : 'Policy Rate'}</span>
            <span class="mp-info-val">${def.cbRate}</span>
        </div>
        <div class="mp-info-cell">
            <span class="mp-info-label">Next Review</span>
            <span class="mp-info-val">${def.nextReview}</span>
        </div>
        <div class="mp-info-cell">
            <span class="mp-info-label">Tea Correlation</span>
            <span class="mp-info-val mp-corr ${def.correlation.startsWith('High') ? (def.correlation.includes('neg') ? 'corr-neg' : 'corr-pos') : 'corr-mod'}">${def.correlation}</span>
        </div>
    </div>

    <div class="mp-trivia">
        <span class="mp-trivia-icon">💡</span>
        <span>${def.trivia}</span>
    </div>

    <div class="mp-footer">Live · TeaTrade Exchange · Updates on market tick</div>`;

    _positionPopout(pop, rowEl);

    // Async: fetch history and replace chart
    const history = await _getHistory(def);
    const sparkContainer = document.getElementById('mp-spark-container');
    if (sparkContainer && pop.style.display !== 'none') {
        if (history.length > 0) {
            sparkContainer.innerHTML = _buildSparkline(history);
        } else {
            sparkContainer.innerHTML = `<div class="mp-spark-nodata">No historical data for this instrument</div>`;
        }
    }
}

function _positionPopout(pop, anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const sidebar = document.querySelector('.sidebar');
    const sidebarRight = sidebar ? sidebar.getBoundingClientRect().right : rect.right;

    pop.style.left = (sidebarRight + 10) + 'px';
    pop.style.top = Math.max(60, rect.top - 20) + 'px';

    requestAnimationFrame(() => {
        const popH = pop.offsetHeight;
        const vh = window.innerHeight;
        const top = parseFloat(pop.style.top);
        if (top + popH > vh - 10) {
            pop.style.top = Math.max(60, vh - popH - 10) + 'px';
        }
    });
}

function closeMacroPopout() {
    const pop = document.getElementById('macro-popout');
    const overlay = document.getElementById('macro-popout-overlay');
    if (pop) pop.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
}

// =============================================
// AUCTION STATUS POPOUT
// =============================================

const AUCTION_DEFS = {
    mombasa: {
        id: 'MOMBASA', name: 'Mombasa Auction', country: 'Kenya', flagIso: 'ke', prefix: 'KEN', currency: '$',
        insight: 'Mombasa is the world\'s largest black CTC tea auction center. Over 70% of Kenyan tea is exported through this hub. Prices here set the global benchmark for standard black tea.',
        metrics: { lots: '~12,000 / week', buyers: 'Global packeteers, UK/Egypt/Pakistan buyers' }
    },
    kolkata: {
        id: 'KOLKATA', name: 'Kolkata Auction', country: 'India', flagIso: 'in', prefix: 'KOL', currency: '\u20B9',
        insight: 'Kolkata handles premium Assam and Darjeeling orthodox teas. Strong domestic Indian consumption provides a high price floor compared to export-heavy centers.',
        metrics: { lots: '~8,000 / week', buyers: 'Domestic blenders, CIS, UK premium buyers' }
    },
    colombo: {
        id: 'COLOMBO', name: 'Colombo Auction', country: 'Sri Lanka', flagIso: 'lk', prefix: 'SRI', currency: 'Rs', multiplier: 305, forexKey: 'usd_lkr',
        insight: 'Colombo is the world\'s largest single-origin tea auction. Orthodox Ceylon teas traded here are prized for their unique aromatics in the Middle East and Russia.',
        metrics: { lots: '~10,000 / week', buyers: 'Middle East, Russia, Specialty traders' }
    },
    jakarta: {
        id: 'JAKARTA', name: 'Jakarta Auction', country: 'Indonesia', flagIso: 'id', prefix: 'IDN', currency: 'Rp', multiplier: 15700, forexKey: 'usd_idr',
        insight: 'Jakarta trades primarily Java and Sumatra teas. While volume is lower than Mombasa, these teas are critical for global blending and RTD (ready-to-drink) manufacturing.',
        metrics: { lots: '~1,500 / week', buyers: 'RTD beverage makers, Global blenders' }
    },
    guwahati: {
        id: 'GUWAHATI', name: 'Guwahati Auction', country: 'India', flagIso: 'in', prefix: 'GUW', currency: '\u20B9', multiplier: 83.5, forexKey: 'usd_inr',
        insight: 'Located in the heart of Assam, Guwahati is one of the busiest CTC tea auction centers in the world, catering heavily to the massive Indian domestic market.',
        metrics: { lots: '~15,000 / week', buyers: 'Mass-market Indian brands' }
    },
    siliguri: {
        id: 'SILIGURI', name: 'Siliguri Auction', country: 'India', flagIso: 'in', prefix: 'SIL', currency: '\u20B9', multiplier: 83.5, forexKey: 'usd_inr',
        insight: 'Handling teas from the Dooars and Terai regions, Siliguri bridges the gap between premium Darjeeling and bulk Assam CTC.',
        metrics: { lots: '~5,000 / week', buyers: 'Domestic blenders' }
    },
    coonoor: {
        id: 'COONOOR', name: 'Coonoor Auction', country: 'India', flagIso: 'in', prefix: 'COO', currency: '\u20B9', multiplier: 83.5, forexKey: 'usd_inr',
        insight: 'Serving the Nilgiri hills in South India, Coonoor auctions are known for fragrant, brisk teas that are popular in Russian and Eastern European markets.',
        metrics: { lots: '~4,000 / week', buyers: 'CIS, Domestic brands' }
    },
    cochin: {
        id: 'COCHIN', name: 'Cochin Auction', country: 'India', flagIso: 'in', prefix: 'COC', currency: '\u20B9', multiplier: 83.5, forexKey: 'usd_inr',
        insight: 'Cochin handles a significant volume of South Indian orthodox and CTC teas, with strong export links through its major port.',
        metrics: { lots: '~6,000 / week', buyers: 'Global exporters, Domestic blenders' }
    }
};

const AUCTION_SCHEDULES = {
    mombasa: { day: 2, hour: 5, minute: 30, localString: "Tue 08:30", durationHours: 4 },
    kolkata: { day: 3, hour: 3, minute: 30, localString: "Wed 09:00", durationHours: 4 },
    colombo: { day: 3, hour: 2, minute: 30, localString: "Wed 08:00", durationHours: 4 },
    jakarta: { day: 3, hour: 2, minute: 30, localString: "Wed 09:30", durationHours: 4 },
    guwahati: { day: 2, hour: 3, minute: 0, localString: "Tue 08:30", durationHours: 4 },
    siliguri: { day: 3, hour: 4, minute: 0, localString: "Wed 09:30", durationHours: 4 },
    coonoor: { day: 4, hour: 3, minute: 30, localString: "Thu 09:00", durationHours: 4 },
    cochin: { day: 4, hour: 5, minute: 0, localString: "Thu 10:30", durationHours: 4 }
};

function updateAuctionCalendars() {
    if (typeof state === 'undefined' || !state.teas) return;
    const now = new Date();

    Object.keys(AUCTION_SCHEDULES).forEach(key => {
        const sched = AUCTION_SCHEDULES[key];
        const def = AUCTION_DEFS[key];
        if (!def) return;

        let nextDate = new Date();
        nextDate.setUTCHours(sched.hour, sched.minute, 0, 0);

        const currentUtcDay = nextDate.getUTCDay();
        let dayOffset = sched.day - currentUtcDay;

        if (dayOffset < 0 || (dayOffset === 0 && now.getTime() > nextDate.getTime() + sched.durationHours * 3600000)) {
            dayOffset += 7;
        }

        nextDate.setUTCDate(nextDate.getUTCDate() + dayOffset);

        const isLive = state.teas.some(t => {
            const isTarget = t.symbol.startsWith(def.prefix) || (def.id === 'KOLKATA' && t.symbol.startsWith('IND-'));
            return isTarget && t.trading_mode === 'HALTED';
        });

        const dayEl = document.getElementById(`calendar-day-${key}`);
        if (dayEl) dayEl.textContent = String(nextDate.getDate()).padStart(2, '0');

        const monthEl = dayEl ? dayEl.nextElementSibling : null;
        if (monthEl) monthEl.textContent = nextDate.toLocaleString('default', { month: 'short' });

        const statusEl = document.getElementById(`auction-timer-${key}`);
        const progressFill = statusEl && statusEl.nextElementSibling ? statusEl.nextElementSibling.firstElementChild : null;

        if (statusEl) {
            if (isLive) {
                // Calculate dynamic progress if inside the schedule window
                let progressPct = 85;
                let startWindow = new Date();
                startWindow.setUTCHours(sched.hour, sched.minute, 0, 0);

                let currentUtcDay2 = startWindow.getUTCDay();
                let dayOffset2 = sched.day - currentUtcDay2;

                // Find nearest past start time
                if (dayOffset2 > 0 || (dayOffset2 === 0 && now.getTime() < startWindow.getTime())) {
                    dayOffset2 -= 7;
                }
                startWindow.setUTCDate(startWindow.getUTCDate() + dayOffset2);

                if (now.getTime() >= startWindow.getTime()) {
                    let elapsedMs = now.getTime() - startWindow.getTime();
                    let totalMs = sched.durationHours * 3600000;
                    progressPct = Math.min((elapsedMs / totalMs) * 100, 99); // Cap at 99% until officially cleared by scraper
                }

                statusEl.className = 'calendar-status live';
                statusEl.textContent = 'LIVE';
                if (progressFill) progressFill.style.width = progressPct.toFixed(1) + '%';
            } else {
                statusEl.className = 'calendar-status upcoming';
                statusEl.textContent = sched.localString;
                if (progressFill) progressFill.style.width = '0%';
            }
        }
    });
}
setInterval(updateAuctionCalendars, 5000);
function openAuctionPopout(auctionKey, rowEl) {
    const def = AUCTION_DEFS[auctionKey];
    if (!def) return;

    const pop = document.getElementById('auction-popout');
    const overlay = document.getElementById('auction-popout-overlay');
    if (!pop || !overlay) return;

    let indexPrice = 0;
    let change = 0;

    // Retrieve from regional calculations, apply forex scaling if available
    if (typeof calculateRegionalIndexes === 'function') {
        const indexes = calculateRegionalIndexes();
        const found = indexes.find(i => i.symbol === def.id);
        if (found) {
            indexPrice = found.price;
            change = found.change;
            if (def.currency !== '$' && def.forexKey && state.macroIndicators && state.macroIndicators[def.forexKey]) {
                indexPrice = indexPrice * Number(state.macroIndicators[def.forexKey]);
            } else if (def.multiplier && def.multiplier !== 1) {
                indexPrice = indexPrice * def.multiplier;
            }
        }
    }

    let localTeas = (state.teas || []).filter(t => t.symbol.startsWith(def.prefix) || (t.symbol.startsWith('IND-') && def.id === 'KOLKATA'));
    localTeas.sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0));
    const topTeas = localTeas.slice(0, 3);

    const teaHtml = topTeas.map(t => {
        const pChange = t.previous_price ? ((t.current_price - t.previous_price) / t.previous_price * 100) : 0;
        const cls = pChange >= 0 ? 'up' : 'down';
        const sign = pChange >= 0 ? '+' : '';
        const curr = def.currency === '$' ? '$' : '';

        let localPrice = t.current_price;
        if (def.currency !== '$' && def.forexKey && state.macroIndicators && state.macroIndicators[def.forexKey]) {
            localPrice = localPrice * Number(state.macroIndicators[def.forexKey]);
        } else if (def.multiplier && def.multiplier !== 1) {
            localPrice = localPrice * def.multiplier;
        }

        return `
            <div style="display:flex; justify-content:space-between; margin-bottom: 6px; font-size: 13px;">
                <span style="color:var(--text-primary); font-weight:500;">${t.symbol}</span>
                <span class="${cls}">${def.currency}${localPrice.toFixed(2)} (${sign}${pChange.toFixed(1)}%)</span>
            </div>
        `;
    }).join('') || '<div style="color:var(--text-muted); font-size:12px;">Data syncing or market halted...</div>';

    pop.innerHTML = `
    <div class="mp-close-btn" onclick="closeAuctionPopout()">✕</div>

    <div class="mp-header">
        <div class="mp-title-row">
            <span class="mp-flag">${def.flagIso ? flagImg(def.flagIso, 28) : ''}</span>
            <div>
                <div class="mp-name">${def.name}</div>
                <div class="mp-fullname">${def.country}</div>
            </div>
            <div class="mp-price-block">
                <span class="mp-price ${_changeClass(change)}">${def.currency}${indexPrice.toFixed(2)}</span>
                ${_pctBadge(change)}
            </div>
        </div>
        <div class="mp-unit-row">Index Average (${def.currency}/kg)</div>
    </div>

    <div class="mp-chart-section" style="padding-top: 10px;">
        <div class="mp-section-title">Top Traded Instruments</div>
        <div style="background: var(--bg-primary); padding: 12px; border-radius: 6px; border: 1px solid var(--border);">
            ${teaHtml}
        </div>
    </div>

    <div class="mp-insight-box" style="margin-top:16px;">
        <div class="mp-insight-header">⚖️ Auction Mechanics</div>
        <div class="mp-insight-text">During live auction hours, all local instruments are set to <strong style="color:var(--accent-red)">HALTED</strong>. When brokers clear data, real-world prices are injected, and markets snap to these values—establishing a true baseline for the week's trading simulation.</div>
    </div>

    <div class="mp-insight-box" style="margin-top:12px; border-left-color: var(--accent-blue);">
        <div class="mp-insight-header">🌍 Regional Insight</div>
        <div class="mp-insight-text">${def.insight}</div>
    </div>

    <div class="mp-info-grid">
        <div class="mp-info-cell">
            <span class="mp-info-label">Average Weekly lots</span>
            <span class="mp-info-val">${def.metrics.lots}</span>
        </div>
        <div class="mp-info-cell">
            <span class="mp-info-label">Key Demographics</span>
            <span class="mp-info-val" style="font-size: 11px; white-space: normal;">${def.metrics.buyers}</span>
        </div>
    </div>
    <div class="mp-footer">Live · TeaTrade Exchange · Automated Sync</div>`;

    pop.style.display = 'block';
    overlay.style.display = 'block';
    _positionPopout(pop, rowEl);
}

function closeAuctionPopout() {
    const pop = document.getElementById('auction-popout');
    const overlay = document.getElementById('auction-popout-overlay');
    if (pop) pop.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
}
