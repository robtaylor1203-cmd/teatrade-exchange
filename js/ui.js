/**
 * TeaTrade Exchange - Core UI Updates (ui.js)
 * ============================================
 * Handles all core DOM updates: auction table, quote board, watchlist,
 * market depth, macro indicators, tea selects, and mobile menu.
 *
 * Globals used from config.js  : state, teaDisplayData, cardData, isIndexSymbol
 * Globals used from market.js  : calculateRegionalIndexes
 * Globals used from utils.js   : showToast
 * Globals from hub.js          : openHubForSymbol
 *
 * Functions called from other files (available at runtime as globals):
 *   updateTradeSummary, updateTradeButton, updateHubOrderPreview,
 *   openPriceAlertModal
 */

// CDN flag image helper (Windows doesn't render flag emojis)
function flagImg(iso, size = 20) {
    if (!iso) return '';
    return `<img src="https://flagcdn.com/w40/${iso}.png" alt="" class="flag-img" style="width:${size}px;height:auto;">`;
}

function getOriginFlag(origin) {
    if (!origin) return flagImg('gb', 20);
    const flags = { 'Kenya': 'ke', 'India': 'in', 'Sri Lanka': 'lk', 'Rwanda': 'rw', 'China': 'cn', 'Vietnam': 'vn', 'Japan': 'jp' };
    for (const [key, iso] of Object.entries(flags)) {
        if (origin.includes(key)) return flagImg(iso, 20);
    }
    return flagImg('gb', 20);
}

// Country prefix → flag ISO + display label
const COUNTRY_MAP = {
    KEN: { iso: 'ke', label: 'Kenya'      },
    IND: { iso: 'in', label: 'India'      },
    SRI: { iso: 'lk', label: 'Sri Lanka'  },
    MLW: { iso: 'mw', label: 'Malawi'     },
    RWA: { iso: 'rw', label: 'Rwanda'     },
    UGA: { iso: 'ug', label: 'Uganda'     },
    TZA: { iso: 'tz', label: 'Tanzania'   },
    VIE: { iso: 'vn', label: 'Vietnam'    },
    JPN: { iso: 'jp', label: 'Japan'      },
    BGD: { iso: 'bd', label: 'Bangladesh' },
    IDN: { iso: 'id', label: 'Indonesia'  },
    KOL: { iso: 'in', label: 'Kolkata'    },
    GUW: { iso: 'in', label: 'Guwahati'   },
    JAL: { iso: 'in', label: 'Jalpaiguri' },
    COC: { iso: 'in', label: 'Cochin'     },
    CMB: { iso: 'in', label: 'Coimbatore' },
    SIL: { iso: 'in', label: 'Siliguri'   },
    COO: { iso: 'in', label: 'Coonoor'    },
};

// =============================================
// SKELETON PLACEHOLDERS (pre-fill containers before data arrives)
// =============================================

function injectSkeletons() {
    _injectWatchlistSkeleton();
    _injectWeatherSkeleton();
    _injectQuoteBoardSkeleton();
    _injectAuctionSkeleton();
}

function _skeletonRow() {
    return `<div class="skeleton-row">
        <div class="skeleton skeleton-circle"></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:6px;">
            <div class="skeleton skeleton-line w60"></div>
            <div class="skeleton skeleton-line w30 h8"></div>
        </div>
        <div class="skeleton sparkline-placeholder"></div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
            <div class="skeleton skeleton-line" style="width:52px;height:14px;"></div>
            <div class="skeleton skeleton-line" style="width:36px;height:10px;"></div>
        </div>
    </div>`;
}

function _injectWatchlistSkeleton() {
    var el = document.getElementById('watchlist-teas');
    if (!el || el.children.length > 0) return;
    var rows = '';
    for (var i = 0; i < 5; i++) rows += _skeletonRow();
    el.innerHTML = rows;
}

function _injectWeatherSkeleton() {
    var el = document.getElementById('weather-cards');
    if (!el) return;
    var hasReal = el.querySelector('.t212-weather-card:not(.weather-skeleton)');
    if (hasReal) return;
    var cards = '';
    for (var i = 0; i < 5; i++) {
        cards += '<div class="skeleton weather-placeholder"></div>';
    }
    el.innerHTML = cards;
}

function _injectQuoteBoardSkeleton() {
    var el = document.getElementById('quote-board');
    if (!el || el.children.length > 0) return;
    var tiles = '';
    for (var i = 0; i < 10; i++) {
        tiles += '<div class="skeleton skeleton-quote-tile"></div>';
    }
    el.innerHTML = tiles;
}

function _injectAuctionSkeleton() {
    var el = document.getElementById('auction-table-body');
    if (!el || el.children.length > 0) return;
    var rows = '';
    for (var i = 0; i < 8; i++) {
        rows += `<tr><td colspan="7" style="padding:0;">
            <div class="skeleton skeleton-line w100" style="height:36px;border-radius:0;"></div>
        </td></tr>`;
    }
    el.innerHTML = rows;
}

// =============================================
// TRADABLE INSTRUMENTS TABLE
// =============================================

let _instrumentFilter = 'all';

const ORIGIN_FILTER_MAP = {
    kenya: ['Kenya'],
    india: ['India'],
    srilanka: ['Sri Lanka'],
    other: ['Indonesia', 'Bangladesh', 'Malawi', 'Rwanda']
};

function filterInstruments(filter) {
    _instrumentFilter = filter;
    document.querySelectorAll('#grade-filters .filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.trim().toLowerCase().replace(/\s/g, '') === filter || (filter === 'all' && btn.textContent.trim() === 'All'));
    });
    updateAuctionTable();
}

function getTeaWatchlist() {
    if (!state.teaWatchlist) {
        try { state.teaWatchlist = JSON.parse(localStorage.getItem('tt_tea_watchlist')) || []; }
        catch { state.teaWatchlist = []; }
    }
    return state.teaWatchlist;
}

function saveTeaWatchlist() {
    localStorage.setItem('tt_tea_watchlist', JSON.stringify(state.teaWatchlist || []));
}

function toggleTeaWatchlist(symbol) {
    const wl = getTeaWatchlist();
    const idx = wl.indexOf(symbol);
    if (idx >= 0) wl.splice(idx, 1);
    else wl.push(symbol);
    state.teaWatchlist = wl;
    saveTeaWatchlist();
    updateAuctionTable();
    updateWatchlistTeas();
}

function updateAuctionTable() {
    const tbody = document.getElementById('auction-table-body');
    if (!tbody || !state.teas.length) return;

    const wl = getTeaWatchlist();

    let items = state.teas.map(tea => {
        const dd = teaDisplayData[tea.symbol];
        const origin = dd?.origin || tea.name?.split(' ')[0] || '';
        return { tea, origin, dd };
    });

    if (_instrumentFilter !== 'all') {
        const allowed = ORIGIN_FILTER_MAP[_instrumentFilter] || [];
        items = items.filter(i => allowed.includes(i.origin));
    }

    items.sort((a, b) => {
        const aStarred = wl.includes(a.tea.symbol) ? 0 : 1;
        const bStarred = wl.includes(b.tea.symbol) ? 0 : 1;
        if (aStarred !== bStarred) return aStarred - bStarred;
        return (a.origin || '').localeCompare(b.origin || '') || a.tea.symbol.localeCompare(b.tea.symbol);
    });

    const changedTeas = {};
    items.forEach(({ tea }) => {
        if (state.previousAuctionPrices[tea.symbol] !== undefined &&
            state.previousAuctionPrices[tea.symbol] !== tea.current_price) {
            changedTeas[tea.symbol] = tea.current_price > state.previousAuctionPrices[tea.symbol] ? 'up' : 'down';
        }
        state.previousAuctionPrices[tea.symbol] = tea.current_price;
    });

    tbody.innerHTML = items.map(({ tea, origin }) => {
        const price = Number(tea.current_price) || 0;
        const prev = Number(tea.previous_price) || price;
        const change = prev > 0 ? ((price - prev) / prev * 100) : 0;
        const changeStr = change !== 0 ? `${change >= 0 ? '+' : ''}${change.toFixed(1)}%` : '\u2014';
        const changeClass = change > 0 ? 'up' : change < 0 ? 'down' : '';
        const flashClass = changedTeas[tea.symbol] ? `flash-${changedTeas[tea.symbol]}` : '';
        const volume = Number(tea.volume_24h) || 0;
        const volStr = volume >= 1000 ? `${Math.round(volume / 1000)}K` : String(volume);

        // Dynamic spread from risk management columns
        const bSpread = Number(tea.base_spread) || 0.01;
        const vMult = Number(tea.volatility_multiplier) || 1.0;
        const dynSpread = bSpread * vMult;
        const askPrice = price * (1 + dynSpread / 2);
        const bidPrice = price * (1 - dynSpread / 2);
        const spreadVal = askPrice - bidPrice;
        const spreadElevated = vMult > 1.05;

        // Trading mode badge
        const tMode = tea.trading_mode || 'FULL';
        let modeBadge = '';
        if (tMode === 'HALTED')     modeBadge = '<span class="mode-badge mode-halted" title="Circuit breaker active">HALTED</span>';
        else if (tMode === 'CLOSE_ONLY') modeBadge = '<span class="mode-badge mode-close-only" title="Close-only mode">CLOSE ONLY</span>';

        const isStarred = wl.includes(tea.symbol);
        const parts = tea.symbol.split('-');
        const shortSym = parts[1] || tea.symbol;
        const prefix = parts[0];

        return `
            <tr onclick="openHubForSymbol('${escapeHtml(tea.symbol)}')" style="cursor:pointer;" class="${tMode === 'HALTED' ? 'row-halted' : ''}">
                <td style="font-family:'JetBrains Mono',monospace;font-weight:600;white-space:nowrap;">
                    <span style="color:var(--text-muted);font-size:10px;vertical-align:baseline;">${escapeHtml(prefix)}-</span>${escapeHtml(shortSym)}
                    ${modeBadge}
                </td>
                <td>${escapeHtml(tea.name || tea.symbol)}</td>
                <td class="auction-center">${escapeHtml(origin)}</td>
                <td class="price-cell ${changeClass} ${flashClass}" data-tea="${escapeHtml(tea.symbol)}">$${price.toFixed(2)}</td>
                <td class="${changeClass}">${changeStr}</td>
                <td style="color:var(--text-muted);">${volStr}</td>
                <td style="font-family:'JetBrains Mono',monospace;font-size:11px;color:${spreadElevated ? 'var(--accent-orange)' : 'var(--text-muted)'};">$${spreadVal.toFixed(3)}${spreadElevated ? ' (' + vMult.toFixed(1) + 'x)' : ''}</td>
                <td style="text-align:center;">
                    <button class="watchlist-star-btn ${isStarred ? 'starred' : ''}" onclick="event.stopPropagation(); toggleTeaWatchlist('${escapeHtml(tea.symbol)}')" title="${isStarred ? 'Remove from watchlist' : 'Add to watchlist'}">
                        ${isStarred ? '\u2605' : '\u2606'}
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

// =============================================
// TEA SELECT (Trade Form)
// =============================================

function populateTeaSelect() {
    const select = document.getElementById('trade-tea-select');

    // Preserve current selection
    const currentValue = select.value;
    const currentQty = document.getElementById('trade-qty')?.value;

    // Skip full rebuild if user is actively using the form
    if (state.isTradeFormActive && currentValue) {
        // Just update the prices in existing options without rebuilding
        state.teas.forEach(tea => {
            const option = select.querySelector(`option[value="${tea.id}"]`);
            if (option) {
                const change = tea.previous_price ? ((tea.current_price - tea.previous_price) / tea.previous_price * 100).toFixed(1) : '0.0';
                const changeSign = change >= 0 ? '+' : '';
                option.textContent = `${tea.symbol} - $${tea.current_price.toFixed(2)} (${changeSign}${change}%)`;
                option.dataset.price = tea.current_price;
            }
        });

        // Also update index prices (crucial for live trading)
        const indexes = calculateRegionalIndexes();
        if (indexes && indexes.length > 0) {
            indexes.forEach(idx => {
                const option = select.querySelector(`option[value="INDEX_${idx.symbol}"]`);
                if (option) {
                    const changeSign = idx.change >= 0 ? '+' : '';
                    option.textContent = `${idx.symbol} Index - $${idx.price.toFixed(2)} (${changeSign}${idx.change.toFixed(1)}%)`;
                    option.dataset.price = idx.price;
                }
            });
        }

        updateTradeSummary();
        return;
    }

    select.innerHTML = '<option value="">Select Tea...</option>';

    // Add teas
    const teaOptgroup = document.createElement('optgroup');
    teaOptgroup.label = 'Teas';
    state.teas.forEach(tea => {
        const change = tea.previous_price ? ((tea.current_price - tea.previous_price) / tea.previous_price * 100).toFixed(1) : '0.0';
        const changeSign = change >= 0 ? '+' : '';
        const option = document.createElement('option');
        option.value = tea.id;
        option.textContent = `${tea.symbol} - $${tea.current_price.toFixed(2)} (${changeSign}${change}%)`;
        option.dataset.price = tea.current_price;
        option.dataset.type = 'tea';
        teaOptgroup.appendChild(option);
    });
    select.appendChild(teaOptgroup);

    // Add regional indexes
    const indexes = calculateRegionalIndexes();
    if (indexes && indexes.length > 0) {
        const indexOptgroup = document.createElement('optgroup');
        indexOptgroup.label = 'Indexes';
        indexes.forEach(idx => {
            const changeSign = idx.change >= 0 ? '+' : '';
            const option = document.createElement('option');
            option.value = `INDEX_${idx.symbol}`;
            option.textContent = `${idx.symbol} Index - $${idx.price.toFixed(2)} (${changeSign}${idx.change.toFixed(1)}%)`;
            option.dataset.price = idx.price;
            option.dataset.type = 'index';
            indexOptgroup.appendChild(option);
        });
        select.appendChild(indexOptgroup);
    }

    // Restore selection if it still exists
    if (currentValue) {
        select.value = currentValue;
        if (currentQty && document.getElementById('trade-qty')) {
            document.getElementById('trade-qty').value = currentQty;
        }
        updateTradeSummary();
    }
}

// =============================================
// HUB TEA SELECTS (Trading Hub)
// =============================================

function populateHubTeaSelects() {
    const buySelect = document.getElementById('hub-buy-symbol');
    const sellSelect = document.getElementById('hub-sell-symbol');

    if (!buySelect || !sellSelect) return;

    // Store current values
    const currentBuy = buySelect.value;
    const currentSell = sellSelect.value;

    // Clear and rebuild
    buySelect.innerHTML = '';
    sellSelect.innerHTML = '';

    // Add teas
    if (state.teas && state.teas.length) {
        const teaOptgroup = document.createElement('optgroup');
        teaOptgroup.label = 'Teas';
        const sellTeaOptgroup = document.createElement('optgroup');
        sellTeaOptgroup.label = 'Teas';

        state.teas.forEach(tea => {
            const buyOption = document.createElement('option');
            buyOption.value = tea.symbol;
            buyOption.textContent = `${tea.symbol} ($${(tea.current_price || 0).toFixed(2)})`;
            teaOptgroup.appendChild(buyOption);

            const sellOption = document.createElement('option');
            sellOption.value = tea.symbol;
            sellOption.textContent = `${tea.symbol} ($${(tea.current_price || 0).toFixed(2)})`;
            sellTeaOptgroup.appendChild(sellOption);
        });

        buySelect.appendChild(teaOptgroup);
        sellSelect.appendChild(sellTeaOptgroup);
    }

    // Build tradable index list from dbIndexes (all indexes are tradable)
    const regionalCalc = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
    const priceMap = {};
    regionalCalc.forEach(r => { priceMap[r.symbol] = r; });
    const indexes = (state.dbIndexes || defaultDbIndexes || []).map(idx => priceMap[idx.symbol] || idx);
    if (indexes && indexes.length > 0) {
        const indexOptgroup = document.createElement('optgroup');
        indexOptgroup.label = 'Indexes';
        const sellIndexOptgroup = document.createElement('optgroup');
        sellIndexOptgroup.label = 'Indexes';

        indexes.forEach(idx => {
            const c = typeof getCurrencyForSymbol === 'function' ? getCurrencyForSymbol(idx.symbol) : '$';
            const fk = idx.forexKey;
            const mult = (fk && state.macroIndicators?.[fk]) ? Number(state.macroIndicators[fk]) : 1;
            const displayPrice = (idx.price || 0) * mult;
            const pStr = displayPrice >= 100 ? displayPrice.toFixed(1) : displayPrice.toFixed(2);

            const buyOption = document.createElement('option');
            buyOption.value = idx.symbol;
            buyOption.textContent = `${idx.symbol} Index (${c}${pStr})`;
            indexOptgroup.appendChild(buyOption);

            const sellOption = document.createElement('option');
            sellOption.value = idx.symbol;
            sellOption.textContent = `${idx.symbol} Index (${c}${pStr})`;
            sellIndexOptgroup.appendChild(sellOption);
        });

        buySelect.appendChild(indexOptgroup);
        sellSelect.appendChild(sellIndexOptgroup);
    }

    // Restore selections if valid
    if (currentBuy && [...buySelect.options].some(o => o.value === currentBuy)) {
        buySelect.value = currentBuy;
    }
    if (currentSell && [...sellSelect.options].some(o => o.value === currentSell)) {
        sellSelect.value = currentSell;
    }

    updateHubOrderPreview();
}

// =============================================
// WATCHLIST
// =============================================

function _buildSparklineSvg(symbol, currentPrice, openPrice) {
    const history = typeof getPriceHistorySync === 'function'
        ? getPriceHistorySync(symbol, 'tea') : [];
    const closes = history.slice(-20).map(c => c.close ?? c.price ?? c);
    if (closes.length < 2) return '<div class="skeleton sparkline-placeholder"></div>';

    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const range = max - min || 1;
    const w = 80, h = 28;

    const points = closes.map((v, i) => {
        const x = (i / (closes.length - 1)) * w;
        const y = h - ((v - min) / range) * (h - 4) - 2;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

    const baseline = (openPrice && openPrice > 0) ? openPrice : closes[0];
    const trending = closes[closes.length - 1] >= baseline;
    const color = trending ? 'var(--accent-green)' : 'var(--accent-red)';

    return `<svg class="t212-sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
}

function updateWatchlistTeas() {
    const container = document.getElementById('watchlist-teas');
    if (!container || !state.teas || state.teas.length === 0) return;

    const wl = getTeaWatchlist();
    let watchlistTeas;

    if (wl.length > 0) {
        watchlistTeas = wl.map(sym => state.teas.find(t => t.symbol === sym)).filter(Boolean);
    } else {
        watchlistTeas = state.teas.slice(0, 5);
    }

    if (watchlistTeas.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:12px 0;text-align:center;">Star instruments below to add them here</div>';
        return;
    }

    const isMobile = window.innerWidth <= 768;
    let html = '';

    watchlistTeas.forEach(tea => {
        const change = tea.previous_price > 0
            ? ((tea.current_price - tea.previous_price) / tea.previous_price) * 100
            : (tea.price_change_24h || 0);
        const isUp = change >= 0;
        const shortSymbol = tea.symbol.split('-')[1] || tea.symbol;
        const originCode = tea.symbol.split('-')[0] || '';
        const priceVal = Number(tea.current_price) || 0;
        const changeVal = Number(change) || 0;
        const countryInfo = COUNTRY_MAP[originCode] || { iso: null, label: originCode };

        if (isMobile) {
            const openPx = Number(tea.previous_price) || 0;
            const sparkline = _buildSparklineSvg(tea.symbol, priceVal, openPx);
            html += `
            <div class="t212-market-row" onclick="openWatchlistChart('${escapeHtml(tea.symbol)}')" data-symbol="${escapeHtml(tea.symbol)}">
                <div class="t212-row-left">
                    <div class="t212-flag-circle">${flagImg(countryInfo.iso, 22)}</div>
                    <div class="t212-symbol-stack">
                        <span class="t212-symbol-name">${escapeHtml(shortSymbol)}</span>
                        <span class="t212-symbol-desc">${escapeHtml(tea.name || countryInfo.label + ' ' + shortSymbol)}</span>
                    </div>
                </div>
                <div class="t212-sparkline-wrap">${sparkline}</div>
                <div class="t212-row-right">
                    <span class="t212-price-text">$${priceVal.toFixed(2)}</span>
                    <span class="t212-change-pill ${isUp ? 'up' : 'down'}">${isUp ? '+' : ''}${changeVal.toFixed(1)}%</span>
                </div>
            </div>`;
        } else {
            html += `
            <div class="watchlist-item" onclick="openWatchlistChart('${escapeHtml(tea.symbol)}')" data-symbol="${escapeHtml(tea.symbol)}">
                <div>
                    <div class="watchlist-name">${escapeHtml(tea.name || shortSymbol)}</div>
                    <div class="watchlist-grade">${escapeHtml(originCode)} ${escapeHtml(tea.grade || shortSymbol)}</div>
                </div>
                <div class="watchlist-price">
                    <div class="watchlist-value">$${priceVal.toFixed(2)}</div>
                    <div class="watchlist-change ${isUp ? 'up' : 'down'}">${isUp ? '+' : ''}${changeVal.toFixed(1)}%</div>
                </div>
            </div>`;
        }
    });

    container.innerHTML = html;
}

function openWatchlistChart(symbol) {
    openHubForSymbol(symbol);
}

function switchWatchlistTab(tab) {
    document.querySelectorAll('.watchlist-tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');

    document.getElementById('watchlist-teas').style.display = tab === 'teas' ? 'block' : 'none';
    document.getElementById('watchlist-macro').style.display = tab === 'macro' ? 'block' : 'none';

    if (tab === 'macro') {
        renderMacroWatchlist();
        _prefetchMacroSparklines();
    }
}

// ── Macro watchlist: T212-style rows with flags + sparklines ──

const MACRO_ROW_DEFS = [
    { id: 'usdkes', key: 'usd_kes', iso: 'ke', name: 'USD / KES', desc: 'Kenyan Shilling',   prefix: '',  decimals: 2 },
    { id: 'usdinr', key: 'usd_inr', iso: 'in', name: 'USD / INR', desc: 'Indian Rupee',       prefix: '',  decimals: 2 },
    { id: 'usdlkr', key: 'usd_lkr', iso: 'lk', name: 'USD / LKR', desc: 'Sri Lankan Rupee',   prefix: '',  decimals: 2 },
    { id: 'usdcny', key: 'usd_cny', iso: 'cn', name: 'USD / CNY', desc: 'Chinese Yuan',       prefix: '',  decimals: 4 },
    { id: 'oil',    key: 'brent_crude', iso: null, name: 'Brent Crude', desc: 'Shipping & logistics', prefix: '$', decimals: 2, oilIcon: true },
];

function _buildMacroSparkline(stateKey) {
    const cache = (typeof _macroHistoryCache !== 'undefined') ? _macroHistoryCache[stateKey] : null;
    const history = cache?.history || [];
    const rates = history.map(h => h.rate).filter(r => r != null);
    if (rates.length < 2) return '';

    const min = Math.min(...rates);
    const max = Math.max(...rates);
    const range = max - min || 1;
    const w = 80, h = 28;

    const points = rates.map((v, i) => {
        const x = (i / (rates.length - 1)) * w;
        const y = h - ((v - min) / range) * (h - 4) - 2;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

    const trending = rates[rates.length - 1] >= rates[0];
    const color = trending ? 'var(--accent-green)' : 'var(--accent-red)';

    return `<svg class="t212-sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
}

async function _prefetchMacroSparklines() {
    if (typeof MACRO_DEFS === 'undefined' || typeof _getHistory !== 'function') return;
    for (const id of Object.keys(MACRO_DEFS)) {
        await _getHistory(MACRO_DEFS[id]);
    }
    renderMacroWatchlist();
}

function renderMacroWatchlist() {
    const container = document.getElementById('watchlist-macro');
    if (!container) return;
    if (window.innerWidth > 768) return;

    const DASH = '\u2014';
    let html = '';

    MACRO_ROW_DEFS.forEach(def => {
        const raw = state.macroIndicators?.[def.key];
        const value = Number(raw);
        const baseline = state.macroBaseline?.[def.key];
        const prev = (baseline != null && !isNaN(Number(baseline))) ? Number(baseline) : Number(state.previousMacro?.[def.key]);

        const priceStr = (!isNaN(value)) ? `${def.prefix}${value.toFixed(def.decimals)}` : DASH;

        let changePct = 0;
        let changeClass = '';
        let changeStr = DASH;
        if (!isNaN(value) && !isNaN(prev) && prev !== 0) {
            changePct = ((value - prev) / prev) * 100;
            changeClass = changePct > 0 ? 'up' : changePct < 0 ? 'down' : '';
            const arrow = changePct > 0 ? '\u25B2' : changePct < 0 ? '\u25BC' : '';
            changeStr = `${arrow} ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`;
        }

        const flagCircle = def.iso
            ? `<div class="t212-flag-circle">${flagImg(def.iso, 22)}</div>`
            : `<div class="t212-flag-circle" style="font-size:18px;">🛢️</div>`;

        const sparkline = _buildMacroSparkline(def.key);

        html += `
        <div class="t212-market-row" onclick="openMacroPopout('${def.id}', this)">
            <div class="t212-row-left">
                ${flagCircle}
                <div class="t212-symbol-stack">
                    <span class="t212-symbol-name">${def.name}</span>
                    <span class="t212-symbol-desc">${def.desc}</span>
                </div>
            </div>
            <div class="t212-sparkline-wrap">${sparkline}</div>
            <div class="t212-row-right">
                <span class="t212-price-text">${priceStr}</span>
                <span class="t212-change-pill ${changeClass}">${changeStr}</span>
            </div>
        </div>`;
    });

    container.innerHTML = html;
}

// =============================================
// MARKET DEPTH & MACRO INDICATORS
// =============================================

function updateMarketDepth() {
    const bidsEl  = document.getElementById('depth-bids');
    const asksEl  = document.getElementById('depth-asks');
    const ratioEl = document.getElementById('depth-ratio');
    if (!bidsEl || !asksEl) return;

    // Resolve the focused symbol — dropdown values may be numeric tea IDs
    // (e.g. "3") or prefixed indexes (e.g. "INDEX_KENYA").  Normalise to
    // the plain symbol that market_pressure uses as its key.
    const select = document.getElementById('trade-tea-select');
    let focusedSymbol = state.selectedQuoteSymbol || select?.value || null;
    if (focusedSymbol) {
        if (focusedSymbol.startsWith('INDEX_')) {
            focusedSymbol = focusedSymbol.replace('INDEX_', '');
        } else if (/^\d+$/.test(focusedSymbol)) {
            const tea = state.teas?.find(t => t.id === parseInt(focusedSymbol));
            if (tea) focusedSymbol = tea.symbol;
        }
    }

    // ── Aggregate real order-flow from market_pressure ───────────────────
    // Try the focused symbol first; if no data, aggregate ALL symbols so
    // the bar always reflects actual trading activity when bots/users trade.
    let bidVol = 0, askVol = 0, usingLiveFlow = false;
    const mp = state.marketPressure || {};

    const tryPressure = (sym) => {
        const p = mp[sym];
        if (!p) return false;
        if (p.buy5m > 0 || p.sell5m > 0) {
            bidVol += p.buy5m;  askVol += p.sell5m;  return true;
        }
        if (p.buy30m > 0 || p.sell30m > 0) {
            bidVol += p.buy30m; askVol += p.sell30m;  return true;
        }
        return false;
    };

    if (focusedSymbol && tryPressure(focusedSymbol)) {
        usingLiveFlow = true;
    } else {
        // Aggregate across every symbol with live pressure data
        for (const sym of Object.keys(mp)) {
            if (tryPressure(sym)) usingLiveFlow = true;
        }
    }

    let bidPct;
    if (usingLiveFlow && (bidVol + askVol) > 0) {
        bidPct = (bidVol / (bidVol + askVol)) * 100;
    } else {
        let ups = 0, downs = 0;
        state.teas.forEach(tea => {
            if (tea.previous_price && tea.current_price > tea.previous_price) ups++;
            else if (tea.previous_price && tea.current_price < tea.previous_price) downs++;
        });
        const total = ups + downs;
        if (total > 0) {
            const targetBids = (ups / total) * 100;
            state.marketDepthBids = state.marketDepthBids * 0.8 + targetBids * 0.2;
        }
        state.marketDepthBids = Math.max(25, Math.min(75, state.marketDepthBids));
        bidPct = state.marketDepthBids;
        const totalVol = state.teas.reduce((sum, t) => sum + (t.volume_24h || 0), 0);
        bidVol = Math.round(totalVol * (bidPct / 100));
        askVol = Math.round(totalVol * ((100 - bidPct) / 100));
    }

    // Clamp to visible range
    bidPct = Math.max(5, Math.min(95, bidPct));
    const askPct = 100 - bidPct;

    // ── Update DOM ───────────────────────────────────────────────────────
    bidsEl.style.width = `${bidPct}%`;
    bidsEl.querySelector('.depth-label').textContent = `BIDS ${Math.round(bidPct)}%`;
    asksEl.style.width = `${askPct}%`;
    asksEl.querySelector('.depth-label').textContent = `ASKS ${Math.round(askPct)}%`;

    const ratio = askPct > 0 ? (bidPct / askPct).toFixed(2) : '—';
    ratioEl.textContent = `Bid/Ask: ${ratio}`;

    // Colour the bars to visually signal dominance
    bidsEl.style.background = bidPct > 55 ? 'var(--accent-green)' : bidPct < 45 ? 'rgba(16,185,129,0.4)' : 'var(--accent-green)';
    asksEl.style.background = askPct > 55 ? 'var(--accent-red)'   : askPct < 45 ? 'rgba(239,68,68,0.4)'  : 'var(--accent-red)';

    // Format volumes
    const fmt = v => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M kg` : v >= 1000 ? `${(v / 1000).toFixed(1)}K kg` : `${v} kg`;
    document.getElementById('depth-bid-volume').textContent = `Vol: ${fmt(bidVol)}`;
    document.getElementById('depth-ask-volume').textContent = `Vol: ${fmt(askVol)}`;

    // Show LIVE badge on depth title when driven by real order flow
    const titleEl = document.getElementById('depth-title') || document.querySelector('.market-depth-title');
    if (titleEl) {
        const existingBadge = titleEl.querySelector('.depth-live-badge');
        if (usingLiveFlow && !existingBadge) {
            const badge = document.createElement('span');
            badge.className = 'depth-live-badge live-badge';
            badge.textContent = 'LIVE';
            titleEl.appendChild(badge);
        } else if (!usingLiveFlow && existingBadge) {
            existingBadge.remove();
        }
    }

    // Mid price from selected tea
    const selectedTea = state.teas.find(t => t.symbol === (focusedSymbol || select?.value));
    const midPrice = (selectedTea?.current_price || 0).toFixed(2);
    document.getElementById('depth-mid-price').textContent = `Mid: $${midPrice}`;
}

function _flashMacroPrice(el, direction) {
    el.classList.remove('macro-flash-up', 'macro-flash-down');
    void el.offsetWidth; // force reflow to restart animation
    el.classList.add(direction > 0 ? 'macro-flash-up' : 'macro-flash-down');
    setTimeout(() => el.classList.remove('macro-flash-up', 'macro-flash-down'), 700);
}

function updateMacroIndicators() {
    const indicators = [
        { key: 'usd_kes',      elId: 'macro-usdkes',  changeId: 'macro-usdkes-change',  rowId: 'macro-row-usdkes',  prefix: '',  decimals: 2 },
        { key: 'usd_inr',      elId: 'macro-usdinr',  changeId: 'macro-usdinr-change',  rowId: 'macro-row-usdinr',  prefix: '',  decimals: 2 },
        { key: 'usd_lkr',      elId: 'macro-usdlkr',  changeId: 'macro-usdlkr-change',  rowId: 'macro-row-usdlkr',  prefix: '',  decimals: 2 },
        { key: 'usd_cny',      elId: 'macro-usdcny',  changeId: 'macro-usdcny-change',  rowId: 'macro-row-usdcny',  prefix: '',  decimals: 4 },
        { key: 'brent_crude',  elId: 'macro-oil',     changeId: 'macro-oil-change',     rowId: 'macro-row-oil',     prefix: '$', decimals: 2 },
    ];

    const DASH = '\u2014';

    indicators.forEach(ind => {
        const raw   = state.macroIndicators?.[ind.key];
        const value = Number(raw);
        // Use the session-start baseline (set by startLiveForexFeed on first fetch)
        // for a meaningful "daily-style" change rather than tick-to-tick noise.
        const baselineVal = state.macroBaseline?.[ind.key];
        const prev = (baselineVal != null && !isNaN(Number(baselineVal)))
            ? Number(baselineVal)
            : Number(state.previousMacro?.[ind.key]);

        const priceEl  = document.getElementById(ind.elId);
        const changeEl = document.getElementById(ind.changeId);
        if (!priceEl) return;

        if (raw == null || isNaN(value)) {
            priceEl.textContent = DASH;
            if (changeEl) { changeEl.textContent = DASH; changeEl.className = 'macro-change'; }
            return;
        }

        const newText = `${ind.prefix}${value.toFixed(ind.decimals)}`;

        // Flash price element if value changed since last tick
        if (!isNaN(prev) && prev !== 0 && value !== prev) {
            const direction = value > prev ? 1 : -1;
            priceEl.textContent = newText;
            _flashMacroPrice(priceEl, direction);
        } else {
            priceEl.textContent = newText;
        }

        // Compute and display percentage change vs previous snapshot
        if (changeEl) {
            if (!isNaN(prev) && prev !== 0) {
                const pctChange = ((value - prev) / prev) * 100;
                const arrow = pctChange > 0 ? '\u25B2' : pctChange < 0 ? '\u25BC' : '';
                const sign  = pctChange > 0 ? '+' : '';
                changeEl.textContent = `${arrow} ${sign}${pctChange.toFixed(2)}%`;
                changeEl.className   = 'macro-change ' + (pctChange > 0 ? 'up' : pctChange < 0 ? 'down' : '');
            } else {
                changeEl.textContent = DASH;
                changeEl.className   = 'macro-change';
            }
        }
    });

    // Snapshot current values as previous for the next tick
    if (state.macroIndicators) {
        state.previousMacro = { ...state.macroIndicators };
    }

    // Re-render mobile T212-style macro rows if the macro tab is visible
    if (window.innerWidth <= 768) {
        const macroPanel = document.getElementById('watchlist-macro');
        if (macroPanel && macroPanel.style.display !== 'none') {
            renderMacroWatchlist();
        }
    }
}

// =============================================
// DATA SOURCE INDICATOR (Live vs Simulated)
// =============================================

function updateDataSourceIndicator() {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (!dot || !text) return;

    const source = state.dataSource;
    const lastTick = state.lastTick;

    // Check staleness: if last_tick is a valid timestamp and older than threshold, mark closed
    const STALE_MS = (typeof STALE_THRESHOLD_MS !== 'undefined') ? STALE_THRESHOLD_MS : 120000;
    let isStale = false;

    if (lastTick) {
        const tickTime = new Date(lastTick).getTime();
        if (!isNaN(tickTime)) {
            isStale = (Date.now() - tickTime) > STALE_MS;
        }
    }

    if (isStale) {
        dot.className = 'status-dot closed';
        text.textContent = 'Feed Offline';
    } else if (source === 'LIVE_FULL') {
        dot.className = 'status-dot live';
        text.textContent = 'Live · Forex + Brent';
    } else if (source === 'LIVE_FOREX' || source === 'LIVE_API') {
        dot.className = 'status-dot live';
        text.textContent = 'Live · Forex (open.er-api.com)';
    } else if (source === 'SIMULATED') {
        dot.className = 'status-dot simulated';
        text.textContent = 'Simulated (Safe Mode)';
    } else {
        dot.className = 'status-dot waiting';
        text.textContent = 'Connecting...';
    }
}

// =============================================
// GLOBAL TICKER TAPE (JS-driven seamless scroll)
// =============================================

const _ticker = { offset: 0, halfWidth: 0, lastHtml: '', animId: null, speed: 0.5 };

function _startTickerScroll() {
    const track = document.getElementById('global-ticker-track');
    if (!track || _ticker.animId) return;
    _ticker.halfWidth = track.scrollWidth / 2;

    function tick() {
        _ticker.offset += _ticker.speed;
        if (_ticker.halfWidth > 0 && _ticker.offset >= _ticker.halfWidth) {
            _ticker.offset -= _ticker.halfWidth;
        }
        track.style.transform = 'translateX(-' + _ticker.offset + 'px)';
        _ticker.animId = requestAnimationFrame(tick);
    }
    _ticker.animId = requestAnimationFrame(tick);
}

function updateGlobalTicker() {
    const track = document.getElementById('global-ticker-track');
    if (!track) return;

    const DASH = '\u2014';

    const macroItems = [
        { iso: 'ke', label: 'KES',  key: 'usd_kes',     prefix: '',  decimals: 2 },
        { iso: 'in', label: 'INR',  key: 'usd_inr',     prefix: '',  decimals: 2 },
        { iso: 'lk', label: 'LKR',  key: 'usd_lkr',     prefix: '',  decimals: 2 },
        { iso: 'cn', label: 'CNY',  key: 'usd_cny',     prefix: '',  decimals: 4 },
        { iso: null, label: 'OIL',  key: 'brent_crude', prefix: '$', decimals: 2, fallback: '\uD83D\uDEE2\uFE0F' }
    ];

    const hasData = macroItems.some(t => {
        const v = state.macroIndicators?.[t.key];
        return v != null && !isNaN(Number(v));
    });

    if (!hasData && (!state.teas || state.teas.length === 0)) {
        if (!_ticker.lastHtml) {
            track.innerHTML = '<div class="ticker-item ticker-loading"><span class="ticker-symbol">Waiting for market data...</span></div>';
        }
        return;
    }

    function buildMacroItems() {
        return macroItems.map(t => {
            const raw = state.macroIndicators?.[t.key];
            const val = Number(raw);
            const baseline = Number(state.macroBaseline?.[t.key]);

            const tickerFlag = t.iso ? flagImg(t.iso, 14) : (t.fallback || '');

            if (raw == null || isNaN(val)) {
                return `<div class="ticker-item">` +
                    `<span class="ticker-flag">${tickerFlag}</span>` +
                    `<span class="ticker-symbol">${t.label}</span>` +
                    `<span class="ticker-price">${DASH}</span>` +
                    `</div>`;
            }

            const priceStr = `${t.prefix}${val.toFixed(t.decimals)}`;
            let changePct = 0;
            if (!isNaN(baseline) && baseline > 0) {
                changePct = ((val - baseline) / baseline) * 100;
            }
            const changeClass = changePct > 0 ? 'up' : changePct < 0 ? 'down' : '';
            const changeStr = changePct !== 0
                ? `${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%`
                : `${DASH}`;

            return `<div class="ticker-item">` +
                `<span class="ticker-flag">${tickerFlag}</span>` +
                `<span class="ticker-symbol">${t.label}</span>` +
                `<span class="ticker-price ${changeClass}">${priceStr}</span>` +
                `<span class="ticker-change ${changeClass}">${changeStr}</span>` +
                `</div>`;
        }).join('');
    }

    function buildTeaItems() {
        if (!state.teas || state.teas.length === 0) return '';
        return state.teas.map(tea => {
            const price = Number(tea.current_price) || 0;
            const prev = Number(tea.previous_price) || price;
            const changePct = prev > 0 ? ((price - prev) / prev) * 100 : 0;
            const changeClass = changePct > 0.01 ? 'up' : changePct < -0.01 ? 'down' : '';
            const changeStr = Math.abs(changePct) > 0.01
                ? `${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%`
                : '+0.0%';
            const symbol = tea.symbol || '';
            return `<div class="ticker-item ticker-tea" onclick="openHubForSymbol('${escapeHtml(symbol)}')" style="cursor:pointer;">` +
                `<span class="ticker-symbol">${escapeHtml(symbol)}</span>` +
                `<span class="ticker-price ${changeClass}">$${price.toFixed(2)}</span>` +
                `<span class="ticker-change ${changeClass}">${changeStr}</span>` +
                `</div>`;
        }).join('');
    }

    function buildIndexItems() {
        const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
        if (indexes.length === 0) return '';
        const topIdx = indexes.filter(i => ['KENYA', 'INDIA', 'CEYLON', 'AFRICA', 'ASIA', 'FUTURES', 'INDONESIA', 'BANGLADESH'].includes(i.symbol));
        return topIdx.map(idx => {
            const price = idx.price || 0;
            const prev = idx.previousPrice || price;
            const changePct = prev > 0 ? ((price - prev) / prev) * 100 : 0;
            const changeClass = changePct > 0.01 ? 'up' : changePct < -0.01 ? 'down' : '';
            const changeStr = Math.abs(changePct) > 0.01
                ? `${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%`
                : '+0.0%';
            return `<div class="ticker-item ticker-index" onclick="openHubForSymbol('${escapeHtml(idx.symbol)}')" style="cursor:pointer;">` +
                `<span class="ticker-symbol">${escapeHtml(idx.symbol)}</span>` +
                `<span class="ticker-price ${changeClass}">$${price.toFixed(2)}</span>` +
                `<span class="ticker-change ${changeClass}">${changeStr}</span>` +
                `</div>`;
        }).join('');
    }

    const sep = '<div class="ticker-separator">\u2502</div>';
    const macro = buildMacroItems();
    const indexes = buildIndexItems();
    const teas = buildTeaItems();

    const onePass = macro + sep + indexes + sep + teas;

    if (onePass === _ticker.lastHtml) return;
    _ticker.lastHtml = onePass;

    const pctDone = _ticker.halfWidth > 0 ? _ticker.offset / _ticker.halfWidth : 0;

    track.innerHTML = onePass + onePass;
    _ticker.halfWidth = track.scrollWidth / 2;
    _ticker.offset = pctDone * _ticker.halfWidth;

    if (!_ticker.animId) _startTickerScroll();
}

// =============================================
// FLASH QUOTE BOARD
// =============================================

function initQuoteBoard() {
    updateQuoteBoard();
}

function updateQuoteBoard() {
    const board = document.getElementById('quote-board');
    if (!board || !state.teas || state.teas.length === 0) return;

    // Show 10 teas for 2 complete rows of 5
    const topTeas = state.teas.slice(0, 10);

    board.innerHTML = topTeas.map(tea => {
        const parts  = tea.symbol.split('-');
        const prefix = parts[0];
        const symbol = parts[1] || tea.symbol;
        const price = Number(tea.current_price) || 0;
        const prev = Number(tea.previous_price) || price;
        const change = prev > 0 ? ((price - prev) / prev * 100) : 0;
        const volume = Number(tea.volume_24h) || 0;
        const isUp = change >= 0;
        const prevPrice = state.previousQuotePrices[tea.symbol];
        let flashClass = '';
        const selectedClass = state.selectedQuoteSymbol === tea.symbol ? 'selected' : '';

        if (prevPrice !== undefined && prevPrice !== price) {
            flashClass = price > prevPrice ? 'flash-green' : 'flash-red';
        }
        state.previousQuotePrices[tea.symbol] = price;

        const volDisplay = volume >= 1000 ? `${Math.round(volume / 1000)}K` : volume.toString();
        const country = COUNTRY_MAP[prefix];
        const countryHtml = country
            ? `<div class="quote-country" title="${country.label}"><span class="quote-country-flag">${flagImg(country.iso, 16)}</span><span class="quote-country-code">${prefix}</span></div>`
            : `<div class="quote-country" style="visibility:hidden;"><span class="quote-country-code">${prefix}</span></div>`;

        return `
            <div class="quote-card ${flashClass} ${selectedClass}" onclick="selectTeaForTrading('${escapeHtml(tea.symbol)}')">
                <div class="quote-symbol">${escapeHtml(symbol)}</div>
                ${countryHtml}
                <div class="quote-price ${isUp ? 'up' : 'down'}">$${price.toFixed(2)}</div>
                <div class="quote-change ${isUp ? 'up' : 'down'}">${isUp ? '\u25B2' : '\u25BC'} ${change >= 0 ? '+' : ''}${change.toFixed(1)}%</div>
                <div class="quote-volume">Vol: ${volDisplay}</div>
            </div>
        `;
    }).join('');
}

function selectTeaForTrading(symbol) {
    state.selectedQuoteSymbol = symbol;
    openHubForSymbol(symbol);
}

// =============================================
// MOBILE MENU
// =============================================

function toggleMobileMenu() {
    const sidebar = document.getElementById('mobile-sidebar');
    const overlay = document.getElementById('mobile-overlay');

    if (sidebar.classList.contains('mobile-open')) {
        closeMobileMenu();
    } else {
        sidebar.classList.add('mobile-open');
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
}

function closeMobileMenu() {
    const sidebar = document.getElementById('mobile-sidebar');
    const overlay = document.getElementById('mobile-overlay');

    sidebar.classList.remove('mobile-open');
    overlay.classList.remove('active');
    document.body.style.overflow = '';
}

function switchMobileSidebarTab(panel) {
    document.querySelectorAll('.mobile-sidebar-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.panel === panel);
    });
    const menuPanel = document.getElementById('mobile-panel-menu');
    const acctPanel = document.getElementById('mobile-panel-account');
    if (menuPanel) menuPanel.style.display = panel === 'menu' ? 'block' : 'none';
    if (acctPanel) acctPanel.style.display = panel === 'account' ? 'block' : 'none';
}

// Close mobile menu on window resize to desktop
window.addEventListener('resize', () => {
    if (window.innerWidth > 1200) {
        closeMobileMenu();
    }
    adjustViewportScale();
});

function adjustViewportScale() {
    const minDesignedWidth = 1200;
    const viewportWidth = window.innerWidth;

    // For screens wider than design width, no scaling
    if (viewportWidth >= minDesignedWidth) {
        document.body.style.transform = '';
        document.body.style.transformOrigin = '';
        document.body.style.width = '';
        return;
    }

    // For mobile breakpoint, let CSS handle it
    if (viewportWidth <= 768) {
        document.body.style.transform = '';
        document.body.style.transformOrigin = '';
        document.body.style.width = '';
        return;
    }

    // Scale down for intermediate screens (768px to 1200px)
    const scale = viewportWidth / minDesignedWidth;
    const adjustedScale = Math.max(0.7, scale);

    // Let CSS media queries handle it by default
}

// =============================================
// TOP TRADERS THIS WEEK
// =============================================

async function loadTopTraders() {
    const container = document.getElementById('top-traders-list');
    if (!container) return;
    try {
        const traders = await apiFetchTopTraders(5);
        if (!traders || traders.length === 0) {
            container.innerHTML = '<div style="padding: 12px 0; color: var(--text-muted); text-align: center;">No trades this week yet</div>';
            return;
        }
        container.innerHTML = traders.map((t, i) => {
            const vol = t.total_volume;
            let label;
            if (vol >= 1e6) label = (vol / 1e6).toFixed(1) + 'M kg';
            else if (vol >= 1e3) label = (vol / 1e3).toFixed(0) + 'K kg';
            else label = vol.toLocaleString() + ' kg';
            const border = i < traders.length - 1 ? 'border-bottom: 1px solid var(--border);' : '';
            const name = t.username || t.user_id?.slice(0, 8) || 'Anon';
            return `<div style="display: flex; justify-content: space-between; padding: 8px 0; ${border}">
                <span>${i + 1}. ${name}</span>
                <span style="font-family: 'JetBrains Mono', monospace;">${label}</span>
            </div>`;
        }).join('');
    } catch (e) {
        console.warn('loadTopTraders error:', e);
    }
}

// Run on page load
adjustViewportScale();

// =============================================
// MOBILE: Populate leaderboard in sidebar
// =============================================

function updateMobileLeaderboard(leaders) {
    const container = document.getElementById('mobile-leaderboard-list');
    const dateEl = document.getElementById('mobile-lb-date');
    if (!container) return;

    if (dateEl) {
        const now = new Date();
        dateEl.textContent = now.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }).toUpperCase();
    }

    if (!leaders || leaders.length === 0) {
        container.innerHTML = '<div style="padding:12px 0;color:var(--text-muted);text-align:center;font-size:12px;">No traders yet</div>';
        return;
    }

    container.innerHTML = leaders.slice(0, 10).map((user, i) => {
        const rank = i + 1;
        let rankClass = '';
        if (rank === 1) rankClass = 'gold';
        else if (rank === 2) rankClass = 'silver';
        else if (rank === 3) rankClass = 'bronze';
        const pct = user.return_pct || 0;
        const pctClass = pct >= 0 ? 'up' : 'down';
        const sign = pct >= 0 ? '+' : '';
        return `<div class="mobile-lb-item" onclick="openTraderProfile('${user.username}', ${pct}, ${user.total_value || 0}, ${rank}); closeMobileMenu();">
            <div class="mobile-lb-rank ${rankClass}">${rank}</div>
            <div class="mobile-lb-name">${escapeHtml(user.username)}</div>
            <div class="mobile-lb-return ${pctClass}">${sign}${pct.toFixed(1)}%</div>
        </div>`;
    }).join('');
}

// =============================================
// MOBILE: Account section state management
// =============================================

function updateMobileAccountSection() {
    const balEl = document.getElementById('mobile-account-balance');
    const amtEl = document.getElementById('mobile-balance-amount');
    const logoutBtn = document.getElementById('mobile-logout-btn');
    const isLoggedIn = !!state.currentUser;

    if (balEl) balEl.style.display = isLoggedIn ? 'flex' : 'none';
    if (logoutBtn) logoutBtn.style.display = isLoggedIn ? 'flex' : 'none';

    if (isLoggedIn && amtEl) {
        const bal = getActiveBalance();
        amtEl.textContent = '$' + bal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
}

// =============================================
// MOBILE: Chart fullscreen rotate prompt
// =============================================

const _origToggleMaximize = typeof toggleMaximize === 'function' ? toggleMaximize : null;

function _mobileChartFullscreenWatch() {
    const isMaximized = !!state.maximizedPanel;
    const isMobile = window.innerWidth <= 768;

    if (isMaximized && isMobile) {
        document.body.classList.add('chart-fullscreen-active');
    } else {
        document.body.classList.remove('chart-fullscreen-active');
    }
}

window.addEventListener('resize', _mobileChartFullscreenWatch);
window.addEventListener('orientationchange', _mobileChartFullscreenWatch);

// =============================================
// MOBILE BOTTOM NAV: Section Switching
// =============================================

let _activeMobileSection = 'markets';

function switchMobileSection(section) {
    _activeMobileSection = section;

    document.body.classList.remove(
        'mobile-section-markets',
        'mobile-section-chart',
        'mobile-section-portfolio',
        'mobile-section-chat',
        'mobile-section-social',
        'mobile-section-more'
    );
    document.body.classList.add('mobile-section-' + section);

    const viewMap = {
        markets:   'view-markets',
        chart:     'view-chart',
        portfolio: 'view-portfolio',
        chat:      'view-chat',
        social:    'view-social',
        more:      'view-more'
    };
    document.querySelectorAll('.app-view').forEach(v => v.classList.remove('active'));
    const targetView = document.getElementById(viewMap[section]);
    if (targetView) targetView.classList.add('active');

    document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.section === section);
    });

    if (section === 'portfolio') {
        const el = document.getElementById('portfolio-section');
        if (el) el.style.display = 'block';
        if (typeof loadUserTrades === 'function') loadUserTrades();
        if (typeof updatePortfolioDisplay === 'function') updatePortfolioDisplay();
    }

    if (section === 'chart') {
        if (typeof resizeCanvas === 'function') setTimeout(resizeCanvas, 50);
    }

    if (section === 'chat') {
        syncChatView();
        if (typeof clearChatNotifications === 'function') clearChatNotifications();
    }

    if (section === 'social') {
        populateSocialLeaderboard();
    }

    if (section === 'more') {
        closeMoreSubScreen();
    }
}

// =============================================
// MOBILE BUY/SELL BAR: Live Price Updates
// =============================================

function updateMobileTradePrices() {
    const buyEl = document.getElementById('mobile-buy-price');
    const sellEl = document.getElementById('mobile-sell-price');
    if (!buyEl || !sellEl) return;
    if (window.innerWidth > 768) return;

    const SPREAD_PCT = 0.01;
    let marketPrice = 0;

    if (state.mainChartData && state.mainChartData.symbol) {
        const sym = state.mainChartData.symbol;
        const isIdx = state.mainChartData.isIndex;

        if (isIdx) {
            const indexes = typeof calculateRegionalIndexes === 'function'
                ? calculateRegionalIndexes() : [];
            const idx = indexes.find(i => i.symbol === sym);
            marketPrice = idx?.price || 0;
        } else {
            const tea = (state.teas || []).find(t => t.symbol === sym);
            marketPrice = tea?.current_price || 0;
        }
    }

    if (marketPrice <= 0) {
        const select = document.getElementById('trade-tea-select');
        const selectValue = select?.value;
        if (selectValue) {
            if (selectValue.startsWith('INDEX_')) {
                const s = selectValue.replace('INDEX_', '');
                const indexes = typeof calculateRegionalIndexes === 'function'
                    ? calculateRegionalIndexes() : [];
                const idx = indexes.find(i => i.symbol === s);
                marketPrice = idx?.price || 0;
            } else {
                const teaId = parseInt(selectValue);
                const tea = state.teas?.find(t => t.id === teaId);
                marketPrice = tea?.current_price || 0;
            }
        }
    }

    if (marketPrice > 0) {
        const askPrice = marketPrice * (1 + SPREAD_PCT / 2);
        const bidPrice = marketPrice * (1 - SPREAD_PCT / 2);
        buyEl.textContent = '$' + askPrice.toFixed(2);
        sellEl.textContent = '$' + bidPrice.toFixed(2);
    } else {
        buyEl.textContent = '\u2014';
        sellEl.textContent = '\u2014';
    }
}

function executeMobileQuickTrade() {
    const select = document.getElementById('trade-tea-select');
    if (!select?.value) {
        if (typeof showToast === 'function') showToast('Select an instrument first', '', true);
        return;
    }
    const qtyEl = document.getElementById('trade-qty');
    if (!qtyEl?.value || parseFloat(qtyEl.value) <= 0) {
        qtyEl.value = '100';
        if (typeof updateTradeSummary === 'function') updateTradeSummary();
    }
    if (typeof executeTrade === 'function') executeTrade();
}

// Refresh mobile trade bar prices periodically
setInterval(updateMobileTradePrices, 1000);

// =============================================
// MOBILE BOTTOM NAV: Initialisation
// =============================================

function initMobileNavigation() {
    const nav = document.getElementById('mobile-bottom-nav');
    if (!nav) return;

    nav.querySelectorAll('.mobile-nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const section = btn.dataset.section;
            if (!section) return;
            switchMobileSection(section);
        });
    });

    // Set default active view on load
    switchMobileSection(_activeMobileSection || 'markets');
}

document.addEventListener('DOMContentLoaded', initMobileNavigation);

// =============================================
// MOBILE: Open QQ Bottom Sheet from Trade Bar
// =============================================

function openMobileTradeSheet(side) {
    const select = document.getElementById('trade-tea-select');
    const selectValue = select?.value;

    let tea = null;

    if (selectValue) {
        if (selectValue.startsWith('INDEX_')) {
            const sym = selectValue.replace('INDEX_', '');
            const indexes = typeof calculateRegionalIndexes === 'function'
                ? calculateRegionalIndexes() : [];
            const idx = indexes.find(i => i.symbol === sym);
            if (idx) {
                tea = {
                    symbol: idx.symbol,
                    name: idx.name,
                    current_price: idx.price,
                    price_change_24h: idx.change || 0,
                    isIndex: true
                };
            }
        } else {
            const teaId = parseInt(selectValue);
            tea = state.teas?.find(t => t.id === teaId);
        }
    }

    if (!tea && state.mainChartData?.symbol) {
        const sym = state.mainChartData.symbol;
        tea = state.teas?.find(t => t.symbol === sym);
        if (!tea) {
            const indexes = typeof calculateRegionalIndexes === 'function'
                ? calculateRegionalIndexes() : [];
            const idx = indexes.find(i => i.symbol === sym);
            if (idx) {
                tea = {
                    symbol: idx.symbol,
                    name: idx.name,
                    current_price: idx.price,
                    price_change_24h: idx.change || 0,
                    isIndex: true
                };
            }
        }
    }

    if (!tea) {
        if (typeof showToast === 'function') showToast('Select an instrument first', '', true);
        return;
    }

    if (typeof openQuickQuoteModal === 'function') {
        openQuickQuoteModal(tea);
    }
    if (typeof setQuickTradeType === 'function') {
        setQuickTradeType(side);
    }
}

// =============================================
// MOBILE: Auto-switch to Chart on asset click
// =============================================

document.addEventListener('DOMContentLoaded', function () {
    const orig = window.openHubForSymbol;
    if (typeof orig !== 'function') return;

    window.openHubForSymbol = function () {
        if (window.innerWidth <= 768) {
            switchMobileSection('chart');
            var chartView = document.getElementById('view-chart');
            if (chartView) chartView.scrollTop = 0;
            var header = document.getElementById('mobile-top-header');
            if (header) header.classList.remove('header-hidden');
            document.body.classList.remove('mth-header-hidden');
        }
        return orig.apply(this, arguments);
    };
});

// (Account view removed — profile/auth handled by hamburger header menu)

// ========================================================
// FORCE NATIVE MOBILE APP ROUTING & TRADE SHEET
// ========================================================

window.switchMobileSection = function(section) {
    if (window.innerWidth > 768) return;

    document.body.classList.remove(
        'mobile-section-markets',
        'mobile-section-chart',
        'mobile-section-portfolio',
        'mobile-section-chat',
        'mobile-section-social',
        'mobile-section-more'
    );
    document.body.classList.add('mobile-section-' + section);

    document.querySelectorAll('.app-view').forEach(v => {
        v.classList.remove('active');
        v.style.removeProperty('display');
    });

    var targetView = document.getElementById('view-' + section);
    if (targetView) targetView.classList.add('active');

    document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.section === section);
    });

    if (section === 'chart' && typeof resizeCanvas === 'function') {
        setTimeout(resizeCanvas, 100);
    }
    if (section === 'chat') {
        if (typeof syncChatView === 'function') syncChatView();
        if (typeof clearChatNotifications === 'function') clearChatNotifications();
    }
    if (section === 'social' && typeof populateSocialLeaderboard === 'function') {
        populateSocialLeaderboard();
    }
    if (section === 'more' && typeof closeMoreSubScreen === 'function') {
        closeMoreSubScreen();
    }
};

window.initMobileNavigation = function() {
    const nav = document.getElementById('mobile-bottom-nav');
    if (!nav) return;

    // Attach click listeners strictly
    nav.querySelectorAll('.mobile-nav-btn').forEach(btn => {
        btn.onclick = function(e) {
            e.preventDefault();
            const section = this.dataset.section;
            if (section) window.switchMobileSection(section);
        };
    });

    // Set default active view on load
    if (window.innerWidth <= 768) {
        window.switchMobileSection('markets');
    }
};

// Ensure routing initializes
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.initMobileNavigation);
} else {
    window.initMobileNavigation();
}

// Intercept asset clicks to auto-route to the Chart tab and scroll to top
const _originalOpenHub = window.openHubForSymbol;
window.openHubForSymbol = function(symbol) {
    if (window.innerWidth <= 768) {
        window.switchMobileSection('chart');
        var chartView = document.getElementById('view-chart');
        if (chartView) chartView.scrollTop = 0;
        var header = document.getElementById('mobile-top-header');
        if (header) header.classList.remove('header-hidden');
        document.body.classList.remove('mth-header-hidden');
    }
    if (typeof _originalOpenHub === 'function') {
        return _originalOpenHub.apply(this, arguments);
    }
};

// Connect the Sticky Buy/Sell Buttons to the native Bottom Sheet
window.openMobileTradeSheet = function(side) {
    var overlay = document.getElementById('qq-mobile-trade-overlay');
    var form = document.getElementById('qq-mobile-trade-form');
    if (!overlay || !form) return;

    // 1. Always resolve from the chart the user is viewing
    var tea = null;
    if (state.mainChartData && state.mainChartData.symbol) {
        var sym = state.mainChartData.symbol;
        var isIdx = state.mainChartData.isIndex;
        if (isIdx) {
            var indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
            var idx = indexes.find(function(i) { return i.symbol === sym; });
            if (idx) {
                tea = { symbol: idx.symbol, name: idx.name, current_price: idx.price, isIndex: true };
            }
        } else {
            tea = (state.teas || []).find(function(t) { return t.symbol === sym; });
        }
    }
    if (!tea) tea = state.qqCurrentTea || null;
    if (!tea) {
        if (typeof showToast === 'function') showToast('Select an instrument first', '', true);
        return;
    }
    state.qqCurrentTea = tea;

    // 2. Calculate execution price with spread (mirrors updateQuickTradeSummary)
    var SPREAD_PCT = 0.01;
    var marketPrice = 0;
    if (tea.isIndex || (typeof isIndexSymbol === 'function' && isIndexSymbol(tea.symbol))) {
        var idxs = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
        var match = idxs.find(function(i) { return i.symbol === tea.symbol; });
        marketPrice = match ? match.price : (tea.current_price || 0);
    } else {
        var liveTea = (state.teas || []).find(function(t) { return t.symbol === tea.symbol; });
        marketPrice = liveTea ? liveTea.current_price : (tea.current_price || 0);
    }
    var isBuy = side === 'BUY';
    var execPrice = isBuy ? marketPrice * (1 + SPREAD_PCT / 2) : marketPrice * (1 - SPREAD_PCT / 2);

    // 3. Populate the mobile trade form
    var titleEl = document.getElementById('qq-mobile-form-title');
    if (titleEl) titleEl.textContent = 'Trade ' + (tea.name || tea.symbol);

    var priceEl = document.getElementById('qq-mobile-price');
    if (priceEl) priceEl.value = execPrice.toFixed(2);

    var qtyEl = document.getElementById('qq-mobile-qty');
    if (!qtyEl.value || qtyEl.value === '0') qtyEl.value = '100';

    var balance = typeof getActiveBalance === 'function' ? (getActiveBalance() || 10000) : 10000;
    var balEl = document.getElementById('qq-mobile-balance');
    if (balEl) balEl.textContent = '$' + balance.toLocaleString('en-US', { minimumFractionDigits: 2 });

    // 4. Set trade type
    if (typeof setQuickTradeType === 'function') setQuickTradeType(side);

    var buyBtn = document.getElementById('qq-mobile-btn-buy');
    var sellBtn = document.getElementById('qq-mobile-btn-sell');
    if (isBuy && buyBtn) {
        buyBtn.classList.add('active');
        if (sellBtn) sellBtn.classList.remove('active');
    } else if (!isBuy && sellBtn) {
        sellBtn.classList.add('active');
        if (buyBtn) buyBtn.classList.remove('active');
    }

    // 5. Update order value summary
    if (typeof updateMobileQQSummary === 'function') updateMobileQQSummary();

    // 6. Show the form
    overlay.classList.add('active');
    form.classList.add('active');
};

/* ========================================================
   VIEW: CHAT — Sync from main chat
   ======================================================== */

function syncChatView() {
    var src = document.getElementById('chat-messages');
    var dst = document.getElementById('vchat-messages');
    if (src && dst) dst.innerHTML = src.innerHTML;
    dst && (dst.scrollTop = dst.scrollHeight);

    var onlineSrc = document.getElementById('chat-online-count');
    var onlineDst = document.getElementById('vchat-online');
    if (onlineSrc && onlineDst) onlineDst.textContent = onlineSrc.textContent;
}

(function wireChatView() {
    document.addEventListener('DOMContentLoaded', function() {
        var sendBtn = document.getElementById('vchat-send');
        var input = document.getElementById('vchat-input');
        if (!sendBtn || !input) return;

        function doSend() {
            var mainInput = document.getElementById('chat-input');
            if (mainInput && input.value.trim()) {
                mainInput.value = input.value;
                input.value = '';
                if (typeof sendChatMessage === 'function') sendChatMessage();
                setTimeout(syncChatView, 300);
            }
        }

        sendBtn.onclick = doSend;
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); doSend(); }
        });

        setInterval(function() {
            if (window.innerWidth <= 768 && document.getElementById('view-chat')?.classList.contains('active')) {
                syncChatView();
            }
        }, 2000);
    });
})();

/* ========================================================
   VIEW: SOCIAL — Populate leaderboard
   ======================================================== */

function populateSocialLeaderboard() {
    var list = document.getElementById('vsocial-list');
    if (!list) return;

    var src = document.getElementById('leaderboard-list');
    var useMobileFormat = false;
    if (!src || src.children.length === 0) {
        src = document.getElementById('mobile-leaderboard-list');
        useMobileFormat = true;
    }
    if (src && src.children.length > 0) {
        var itemSel = useMobileFormat ? '.mobile-lb-item' : '.leaderboard-item';
        var nameSel = useMobileFormat ? '.mobile-lb-name' : '.leaderboard-name';
        var retSel  = useMobileFormat ? '.mobile-lb-return' : '.leaderboard-return';
        var items = Array.from(src.querySelectorAll(itemSel));
        if (items.length === 0) items = Array.from(src.children);

        var html = '';
        items.forEach(function(item, i) {
            var nameEl = item.querySelector(nameSel) || item.querySelector('.leaderboard-name') || item.querySelector('.mobile-lb-name');
            var retEl = item.querySelector(retSel) || item.querySelector('.leaderboard-return') || item.querySelector('.mobile-lb-return');
            var name = nameEl ? nameEl.textContent : '';
            var ret = retEl ? retEl.textContent : '';
            var isUp = retEl ? retEl.classList.contains('up') : true;
            var onclick = item.getAttribute('onclick') || '';
            var rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';

            html += '<div class="vsocial-item" onclick="' + onclick.replace(/"/g, '&quot;') + '">' +
                '<div class="vsocial-rank ' + rankClass + '">' + (i + 1) + '</div>' +
                '<div class="vsocial-name">' + name + '</div>' +
                '<div class="vsocial-return ' + (isUp ? 'up' : 'down') + '">' + ret + '</div>' +
                '</div>';
        });
        list.innerHTML = html;
    } else {
        list.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-muted);">Loading leaderboard...</div>';
    }
}

/* ========================================================
   VIEW: MORE — Sub-screen navigation & populators
   ======================================================== */

function openMoreSubScreen(screen) {
    var grid = document.getElementById('more-menu-grid');
    if (grid) grid.classList.add('hidden');

    document.querySelectorAll('.more-sub-screen').forEach(function(s) { s.classList.remove('active'); });
    var sub = document.getElementById('more-sub-' + screen);
    if (sub) sub.classList.add('active');

    if (screen === 'weather') populateMoreWeather();
    if (screen === 'currency') populateMoreCurrency();
    if (screen === 'leaderboard') populateMoreLeaderboard();
    if (screen === 'history') populateMoreHistory();
    if (screen === 'alerts') populateMoreAlerts();
}

function closeMoreSubScreen() {
    document.querySelectorAll('.more-sub-screen').forEach(function(s) { s.classList.remove('active'); });
    var grid = document.getElementById('more-menu-grid');
    if (grid) grid.classList.remove('hidden');
}

function populateMoreWeather() {
    var content = document.getElementById('more-weather-content');
    if (!content) return;
    var cards = document.querySelectorAll('#weather-cards .t212-weather-card');
    if (!cards.length) { content.innerHTML = '<div style="padding:20px;color:var(--text-muted);text-align:center;">Loading weather data...</div>'; return; }

    var html = '';
    cards.forEach(function(card, idx) {
        var name = card.querySelector('.wc-region')?.textContent || '';
        var condition = card.querySelector('.wc-condition')?.textContent || '';
        var temp = card.querySelector('.wc-temp-val')?.textContent || '';
        html += '<div class="more-weather-item" onclick="if(typeof openWeatherPopout===\'function\') openWeatherPopout(' + idx + ');">' +
            '<div class="more-weather-left"><span class="more-weather-name">' + name + '</span><span style="color:var(--text-muted);font-size:12px;">' + condition + '</span></div>' +
            '<div class="more-weather-right"><span>' + temp + '</span></div></div>';
    });
    content.innerHTML = html;
}

function populateMoreCurrency() {
    var content = document.getElementById('more-currency-content');
    if (!content) return;

    var macros = [
        { id: 'usdkes', icon: '\u{1F1F0}\u{1F1EA}', pair: 'USD / KES', sub: 'Kenyan Shilling' },
        { id: 'usdinr', icon: '\u{1F1EE}\u{1F1F3}', pair: 'USD / INR', sub: 'Indian Rupee' },
        { id: 'usdlkr', icon: '\u{1F1F1}\u{1F1F0}', pair: 'USD / LKR', sub: 'Sri Lankan Rupee' },
        { id: 'usdcny', icon: '\u{1F1E8}\u{1F1F3}', pair: 'USD / CNY', sub: 'Chinese Yuan' },
        { id: 'oil',    icon: '\u{2699}',            pair: 'Brent Crude', sub: 'Shipping & logistics' }
    ];

    var html = '';
    macros.forEach(function(m) {
        var priceEl = document.getElementById('macro-' + m.id);
        var price = priceEl ? priceEl.textContent : '\u2014';
        html += '<div class="more-currency-item" onclick="if(typeof openMacroPopout===\'function\') openMacroPopout(\'' + m.id + '\');">' +
            '<div class="more-currency-left"><span class="more-currency-icon">' + m.icon + '</span><div><div class="more-currency-pair">' + m.pair + '</div><div class="more-currency-sub">' + m.sub + '</div></div></div>' +
            '<div class="more-currency-price">' + price + '</div></div>';
    });
    content.innerHTML = html;
}

function populateMoreLeaderboard() {
    var content = document.getElementById('more-leaderboard-content');
    if (!content) return;

    var src = document.getElementById('leaderboard-list');
    if (!src || src.children.length === 0) src = document.getElementById('mobile-leaderboard-list');
    if (src && src.children.length > 0) {
        content.innerHTML = src.innerHTML;
    } else {
        content.innerHTML = '<div style="padding:20px;color:var(--text-muted);text-align:center;">Loading...</div>';
    }
}

function populateMoreHistory() {
    var content = document.getElementById('more-history-content');
    if (!content) return;

    var src = document.querySelector('.order-history-section');
    if (src && src.innerHTML.trim()) {
        content.innerHTML = src.innerHTML;
    } else {
        content.innerHTML = '<div style="padding:20px;color:var(--text-muted);text-align:center;">No trade history available.</div>';
    }
}

function populateMoreAlerts() {
    var content = document.getElementById('more-alerts-content');
    if (!content) return;

    var alerts = (typeof state !== 'undefined' && state.priceAlerts) ? state.priceAlerts : {};
    var keys = Object.keys(alerts);

    if (keys.length === 0) {
        content.innerHTML = '<div class="more-alerts-empty">No price alerts set.<br><br>Open a chart and tap the bell icon to add one.</div>';
        return;
    }

    var html = '';
    keys.forEach(function(sym) {
        var a = alerts[sym];
        var below = a.below ? 'Below $' + Number(a.below).toFixed(2) : '';
        var above = a.above ? 'Above $' + Number(a.above).toFixed(2) : '';
        var vals = [below, above].filter(Boolean).join(' / ');
        html += '<div class="more-alert-item" onclick="if(typeof openPriceAlertModal===\'function\'){var t=(state.teas||[]).find(function(x){return x.symbol===\'' + sym + '\'});if(t) openPriceAlertModal(t.symbol,t.current_price);}">' +
            '<div class="more-alert-symbol">' + sym + '</div>' +
            '<div class="more-alert-values">' + vals + '</div></div>';
    });
    content.innerHTML = html;
}

/* ========================================================
   MOBILE TOP HEADER — Hamburger, Balance Sync, Scroll Behaviour
   ======================================================== */
(function initMobileHeader() {
    if (typeof document === 'undefined') return;

    function openMobileHeader() {
        var menu = document.getElementById('mth-menu');
        var overlay = document.getElementById('mth-menu-overlay');
        if (menu) menu.classList.add('active');
        if (overlay) overlay.classList.add('active');
        syncMobileHeaderData();
    }

    window.closeMobileHeader = function() {
        var menu = document.getElementById('mth-menu');
        var overlay = document.getElementById('mth-menu-overlay');
        if (menu) menu.classList.remove('active');
        if (overlay) overlay.classList.remove('active');
    };

    function syncMobileHeaderData() {
        var balEl = document.getElementById('user-balance');
        var bal = balEl ? balEl.textContent : '$10,000.00';

        var mthBal = document.getElementById('mth-balance');
        var mthMenuBal = document.getElementById('mth-menu-balance');
        if (mthBal) mthBal.textContent = bal;
        if (mthMenuBal) mthMenuBal.textContent = bal;

        var equityEl = document.getElementById('portfolio-value') || document.getElementById('account-view-equity');
        var mthMenuEq = document.getElementById('mth-menu-equity');
        if (mthMenuEq) mthMenuEq.textContent = equityEl ? equityEl.textContent : bal;

        var avatar = document.getElementById('user-avatar');
        var mthAvatar = document.getElementById('mth-menu-avatar');
        if (avatar && mthAvatar) mthAvatar.textContent = avatar.textContent;

        var modeLabel = document.getElementById('mode-label');
        var mthMode = document.getElementById('mth-menu-mode');
        var mthModeLabel = document.getElementById('mth-mode-label');
        if (modeLabel && mthMode) mthMode.textContent = modeLabel.textContent;
        if (modeLabel && mthModeLabel) {
            mthModeLabel.textContent = modeLabel.textContent === 'REAL' ? 'Switch to VIRTUAL' : 'Switch to REAL';
        }

        var loggedIn = document.getElementById('logged-in-ui');
        var isLoggedIn = loggedIn && loggedIn.style.display !== 'none';
        var mthUsername = document.getElementById('mth-menu-username');
        if (mthUsername) {
            mthUsername.textContent = isLoggedIn ? (avatar ? avatar.textContent.trim() || 'Trader' : 'Trader') : 'Guest';
        }
        var menuUsername = document.getElementById('menu-username');
        if (menuUsername) {
            menuUsername.textContent = isLoggedIn ? (state.userProfile?.username || avatar?.textContent?.trim() || 'Tea Trader') : 'Guest';
        }
        var t212Avatar = document.querySelector('.t212-profile-avatar');
        if (t212Avatar && avatar) {
            t212Avatar.textContent = avatar.textContent.trim() || 'TT';
        }
        var profileStatus = document.getElementById('t212-profile-status');
        if (profileStatus) {
            var tier = state.userProfile?.tier;
            var mode = state.tradingMode || 'VIRTUAL';
            if (tier && tier.toLowerCase() === 'pro') {
                profileStatus.textContent = 'PRO Account';
                profileStatus.style.background = 'rgba(26, 115, 232, 0.15)';
                profileStatus.style.color = 'var(--accent-blue)';
            } else if (mode === 'REAL') {
                profileStatus.textContent = 'Real Account';
                profileStatus.style.background = 'rgba(16, 185, 129, 0.15)';
                profileStatus.style.color = 'var(--accent-green)';
            } else {
                profileStatus.textContent = 'Virtual Account';
                profileStatus.style.background = 'rgba(16, 185, 129, 0.15)';
                profileStatus.style.color = 'var(--accent-green)';
            }
        }

        var authItems = ['mth-item-portfolio', 'mth-item-store', 'mth-item-mode', 'mth-item-security', 'mth-item-logout'];
        authItems.forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.style.display = isLoggedIn ? 'flex' : 'none';
        });

        var loginItem = document.getElementById('mth-item-login');
        if (loginItem) loginItem.style.display = isLoggedIn ? 'none' : 'flex';
    }

    /* Scroll-hide/show: hide header on scroll down, reveal on scroll up */
    function initScrollBehaviour() {
        var header = document.getElementById('mobile-top-header');
        if (!header) return;

        var lastScrollY = 0;
        var scrollThreshold = 8;

        document.querySelectorAll('.app-view').forEach(function(view) {
            view.addEventListener('scroll', function() {
                if (window.innerWidth > 768) return;

                var currentY = this.scrollTop;
                var delta = currentY - lastScrollY;

                if (delta > scrollThreshold && currentY > 88) {
                    header.classList.add('header-hidden');
                    document.body.classList.add('mth-header-hidden');
                } else if (delta < -scrollThreshold) {
                    header.classList.remove('header-hidden');
                    document.body.classList.remove('mth-header-hidden');
                }

                lastScrollY = currentY;
            }, { passive: true });
        });
    }

    document.addEventListener('DOMContentLoaded', function() {
        var hamburger = document.getElementById('mth-hamburger');
        if (hamburger) hamburger.onclick = openMobileHeader;

        var closeBtn = document.getElementById('mth-menu-close');
        if (closeBtn) closeBtn.onclick = closeMobileHeader;

        var overlay = document.getElementById('mth-menu-overlay');
        if (overlay) overlay.onclick = closeMobileHeader;

        var modeToggleItem = document.getElementById('mth-item-mode');
        if (modeToggleItem) {
            modeToggleItem.onclick = function() {
                var modeToggle = document.getElementById('mode-toggle');
                if (modeToggle) {
                    modeToggle.checked = !modeToggle.checked;
                    if (typeof switchTradingMode === 'function') {
                        switchTradingMode(modeToggle.checked ? 'REAL' : 'VIRTUAL');
                    }
                }
                closeMobileHeader();
            };
        }

        initScrollBehaviour();

        setInterval(function() {
            if (window.innerWidth > 768) return;
            var balEl = document.getElementById('user-balance');
            var mthBal = document.getElementById('mth-balance');
            if (balEl && mthBal) mthBal.textContent = balEl.textContent;

            var statusDot = document.getElementById('status-dot');
            var mthDot = document.getElementById('mth-status-dot');
            if (statusDot && mthDot) {
                mthDot.style.background = statusDot.classList.contains('connected') ? 'var(--accent-green)' : '#ef4444';
            }
        }, 2000);
    });
})();

// =============================================
// MOBILE GHOST SHARE BUTTON
// =============================================

function handleMobileShare() {
    var payload = {
        title: 'TeaTrade Exchange | Synthetic Commodity Trading',
        text: "I'm trading 25x leveraged tea derivatives on TeaTrade. Check out the live auctions.",
        url: window.location.origin
    };

    if (navigator.share) {
        navigator.share(payload).catch(function() {});
    } else {
        navigator.clipboard.writeText(payload.url).then(function() {
            _showShareToast('Link copied to clipboard');
        }).catch(function() {
            _showShareToast('Link copied to clipboard');
        });
    }
}

function _showShareToast(msg) {
    var existing = document.getElementById('share-toast');
    if (existing) existing.remove();

    var toast = document.createElement('div');
    toast.id = 'share-toast';
    toast.textContent = msg;
    Object.assign(toast.style, {
        position: 'fixed', bottom: '140px', right: '16px',
        background: 'rgba(13,17,23,0.9)', color: '#fff',
        fontSize: '12px', fontWeight: '600', padding: '8px 14px',
        borderRadius: '8px', zIndex: '10005',
        border: '1px solid rgba(255,255,255,0.1)',
        backdropFilter: 'blur(8px)',
        opacity: '0', transform: 'translateY(8px)',
        transition: 'opacity 0.3s ease, transform 0.3s ease'
    });
    document.body.appendChild(toast);
    requestAnimationFrame(function() {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    });
    setTimeout(function() {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
        setTimeout(function() { toast.remove(); }, 300);
    }, 2000);
}

(function initGhostShareButton() {
    if (window.innerWidth > 768) return;

    var btn = document.getElementById('mobile-share-btn');
    if (!btn) return;

    var revealed = false;
    function reveal() {
        if (revealed) return;
        revealed = true;
        btn.classList.add('visible');
    }

    setTimeout(reveal, 30000);

    var origExecute = window.executeTrade;
    if (typeof origExecute === 'function') {
        window.executeTrade = function() {
            var result = origExecute.apply(this, arguments);
            reveal();
            return result;
        };
    }
    var origExecHub = window.executeHubTrade;
    if (typeof origExecHub === 'function') {
        window.executeHubTrade = function() {
            var result = origExecHub.apply(this, arguments);
            reveal();
            return result;
        };
    }
})();