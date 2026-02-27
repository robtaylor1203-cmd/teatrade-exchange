// =============================================
// MACRO INDICATOR DETAIL POPOUT
// Fetches 7-day forex history from @fawazahmed0/currency-api (free, no key)
// =============================================

const MACRO_DEFS = {
    usdkes: {
        stateKey:    'usd_kes',
        base:        'usd',
        quote:       'kes',
        name:        'USD / KES',
        fullName:    'Kenyan Shilling',
        flagIso:     'ke',
        type:        'forex',
        decimals:    2,
        spreadPct:   0.04,
        unit:        'KES per USD',
        centralBank: 'Central Bank of Kenya',
        cbRate:      '12.50%',
        nextReview:  'Apr 2026',
        correlation: 'High positive',
        corrNote:    'Tea ≈ 26% of Kenya export earnings',
        insight:     'A weaker KES makes Kenyan auction teas cheaper in USD terms, driving higher volumes at the Mombasa auction. Watch this pair closely before any weekly auction — a sharp KES move can shift competitive bids significantly.',
        impactLabel: 'Mombasa Auction',
        impactIcon:  '🍃',
        trivia:      'Kenya is the world\'s largest exporter of black CTC teas, primarily priced in USD at the Mombasa exchange.',
    },
    usdinr: {
        stateKey:    'usd_inr',
        base:        'usd',
        quote:       'inr',
        name:        'USD / INR',
        fullName:    'Indian Rupee',
        flagIso:     'in',
        type:        'forex',
        decimals:    2,
        spreadPct:   0.03,
        unit:        'INR per USD',
        centralBank: 'Reserve Bank of India',
        cbRate:      '6.50%',
        nextReview:  'Apr 2026',
        correlation: 'Moderate positive',
        corrNote:    'Tea ≈ 3% of India export earnings',
        insight:     'INR weakness boosts the USD value of Darjeeling and Assam teas for overseas buyers. India also consumes ~80% of its own crop, so INR strength raises domestic demand and reduces export surplus.',
        impactLabel: 'Kolkata Auction',
        impactIcon:  '🫖',
        trivia:      'India is the world\'s second-largest tea producer. Darjeeling First Flush, priced in INR, commands a global premium.',
    },
    usdlkr: {
        stateKey:    'usd_lkr',
        base:        'usd',
        quote:       'lkr',
        name:        'USD / LKR',
        fullName:    'Sri Lankan Rupee',
        flagIso:     'lk',
        type:        'forex',
        decimals:    2,
        spreadPct:   0.12,
        unit:        'LKR per USD',
        centralBank: 'Central Bank of Sri Lanka',
        cbRate:      '8.00%',
        nextReview:  'Mar 2026',
        correlation: 'High positive',
        corrNote:    'Tea ≈ 15% of Sri Lanka export earnings',
        insight:     'Ceylon tea is heavily dependent on USD export revenue. LKR volatility (which has been extreme since 2022) can devastate or boost local grower margins. A sharp LKR depreciation temporarily boosts USD-denominated competitiveness.',
        impactLabel: 'Colombo Auction',
        impactIcon:  '🌿',
        trivia:      'Sri Lanka\'s tea sector employs over 1 million people. The 2022 LKR crisis forced a structural reset in auction pricing.',
    },
    usdcny: {
        stateKey:    'usd_cny',
        base:        'usd',
        quote:       'cny',
        name:        'USD / CNY',
        fullName:    'Chinese Yuan',
        flagIso:     'cn',
        type:        'forex',
        decimals:    4,
        spreadPct:   0.02,
        unit:        'CNY per USD',
        centralBank: 'People\'s Bank of China',
        cbRate:      '3.45%',
        nextReview:  'Ongoing (managed)',
        correlation: 'Moderate',
        corrNote:    'China is the world\'s largest tea producer',
        insight:     'A stronger CNY increases Chinese purchasing power for imported specialty teas. As the world\'s largest producer and consumer, China\'s currency moves ripple across global tea commodity markets.',
        impactLabel: 'Global Tea Supply',
        impactIcon:  '🍵',
        trivia:      'China produces ≈47% of global tea output. The yuan is a managed float — PBoC sets a daily midpoint rate limiting daily moves to ±2%.',
    },
    oil: {
        stateKey:    'brent_crude',
        base:        null,
        quote:       null,
        name:        'Brent Crude',
        fullName:    'ICE Brent · $/bbl',
        flagIso:     null,
        flagFallback: '🛢️',
        type:        'commodity',
        decimals:    2,
        spreadPct:   0.05,
        unit:        'USD per barrel',
        centralBank: 'OPEC+',
        cbRate:      '~9Mb/d cuts',
        nextReview:  'Jun 2026',
        correlation: 'High negative',
        corrNote:    'Higher oil raises freight & packaging costs',
        insight:     'Brent Crude is the global shipping cost proxy for tea. A $10/bbl rise increases freight costs from East Africa to Europe by approximately 4–7%. This directly compresses margins on bulk tea shipments and raises insurance premiums for commodity cargo.',
        impactLabel: 'Freight & Logistics',
        impactIcon:  '🚢',
        trivia:      'A single container of bulk tea shipped from Mombasa to Rotterdam consumes roughly 2 tonnes of bunker fuel. Bunker fuel prices track Brent closely.',
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
            const url = 'https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?interval=1d&range=5d';
            const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (resp.ok) {
                const data = await resp.json();
                const result     = data?.chart?.result?.[0];
                const timestamps = result?.timestamp ?? [];
                const closes     = result?.indicators?.quote?.[0]?.close ?? [];
                history = timestamps.map((ts, i) => ({
                    date: new Date(ts * 1000).toISOString().split('T')[0],
                    rate: closes[i] ?? null
                })).filter(d => d.rate != null);
            }
        } catch (_) { /* fall through to empty */ }
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
    const fillId  = `spark-fill-${Math.random().toString(36).slice(2, 7)}`;

    const pathD = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const areaD = pathD + ` L${W},${H} L0,${H} Z`;

    const labels = history.map(d => {
        const date = new Date(d.date + 'T12:00:00');
        return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][date.getDay()];
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
    const cls  = _changeClass(pct);
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
    const raw  = state?.macroIndicators?.[def.stateKey];
    const prev = state?.macroBaseline?.[def.stateKey] ?? state?.previousMacro?.[def.stateKey];
    const price = Number(raw);

    const pct = (!isNaN(price) && !isNaN(Number(prev)) && Number(prev) !== 0)
        ? ((price - Number(prev)) / Number(prev)) * 100
        : null;

    // Bid / ask
    const half   = (def.spreadPct / 100) * price / 2;
    const bid    = (price - half).toFixed(def.decimals);
    const ask    = (price + half).toFixed(def.decimals);
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
    pop.style.top  = Math.max(60, rect.top - 20) + 'px';

    requestAnimationFrame(() => {
        const popH = pop.offsetHeight;
        const vh   = window.innerHeight;
        const top  = parseFloat(pop.style.top);
        if (top + popH > vh - 10) {
            pop.style.top = Math.max(60, vh - popH - 10) + 'px';
        }
    });
}

function closeMacroPopout() {
    const pop     = document.getElementById('macro-popout');
    const overlay = document.getElementById('macro-popout-overlay');
    if (pop)     pop.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
}
