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
    KEN: { iso: 'ke', label: 'Kenya' },
    IND: { iso: 'in', label: 'India' },
    SRI: { iso: 'lk', label: 'Sri Lanka' },
    MLW: { iso: 'mw', label: 'Malawi' },
    RWA: { iso: 'rw', label: 'Rwanda' },
    UGA: { iso: 'ug', label: 'Uganda' },
    TZA: { iso: 'tz', label: 'Tanzania' },
    VIE: { iso: 'vn', label: 'Vietnam' },
    JPN: { iso: 'jp', label: 'Japan' },
    BGD: { iso: 'bd', label: 'Bangladesh' },
    IDN: { iso: 'id', label: 'Indonesia' },
    KOL: { iso: 'in', label: 'Kolkata' },
    GUW: { iso: 'in', label: 'Guwahati' },
    JAL: { iso: 'in', label: 'Jalpaiguri' },
    COC: { iso: 'in', label: 'Cochin' },
    CMB: { iso: 'in', label: 'Coimbatore' },
    SIL: { iso: 'in', label: 'Siliguri' },
    COO: { iso: 'in', label: 'Coonoor' },
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

    // ── First render: build full HTML (happens once, or on filter/sort change) ──
    const existingSymbols = new Set(
        Array.from(tbody.querySelectorAll('[data-tea]')).map(el => el.dataset.tea)
    );
    const expectedSymbols = new Set(items.map(({ tea }) => tea.symbol));
    const needsFullRebuild = existingSymbols.size !== expectedSymbols.size ||
        ![...expectedSymbols].every(s => existingSymbols.has(s));

    if (needsFullRebuild) {
        tbody.innerHTML = items.map(({ tea, origin }) => {
            const price = Number(tea.current_price) || 0;
            const prev = Number(tea.previous_price) || price;
            const change = prev > 0 ? ((price - prev) / prev * 100) : 0;
            const changeStr = change !== 0 ? `${change >= 0 ? '+' : ''}${change.toFixed(1)}%` : '\u2014';
            const changeClass = change > 0 ? 'up' : change < 0 ? 'down' : '';
            const volume = Number(tea.volume_24h) || 0;
            const volStr = volume >= 1000 ? `${Math.round(volume / 1000)}K` : String(volume);
            const bSpread = Number(tea.base_spread) || 0.01;
            const vMult = Number(tea.volatility_multiplier) || 1.0;
            const dynSpread = bSpread * vMult;
            const askPrice = price * (1 + dynSpread / 2);
            const bidPrice = price * (1 - dynSpread / 2);
            const spreadVal = askPrice - bidPrice;
            const spreadElevated = vMult > 1.05;
            const tMode = tea.trading_mode || 'FULL';
            let modeBadge = '';
            if (tMode === 'HALTED') modeBadge = '<span class="mode-badge mode-halted" title="Circuit breaker active">HALTED</span>';
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
                    <td class="price-cell ${changeClass}" data-tea="${escapeHtml(tea.symbol)}">$${price.toFixed(2)}</td>
                    <td class="${changeClass}" data-change="${escapeHtml(tea.symbol)}">${changeStr}</td>
                    <td style="color:var(--text-muted);" data-vol="${escapeHtml(tea.symbol)}">${volStr}</td>
                    <td style="font-family:'JetBrains Mono',monospace;font-size:11px;color:${spreadElevated ? 'var(--accent-orange)' : 'var(--text-muted)'};">$${spreadVal.toFixed(3)}${spreadElevated ? ' (' + vMult.toFixed(1) + 'x)' : ''}</td>
                    <td style="text-align:center;">
                        <button class="watchlist-star-btn ${isStarred ? 'starred' : ''}" onclick="event.stopPropagation(); toggleTeaWatchlist('${escapeHtml(tea.symbol)}')" title="${isStarred ? 'Remove from watchlist' : 'Add to watchlist'}">
                            ${isStarred ? '\u2605' : '\u2606'}
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
        return;
    }

    // ── Subsequent ticks: surgical cell updates only ──
    items.forEach(({ tea }) => {
        const price = Number(tea.current_price) || 0;
        const prev = Number(tea.previous_price) || price;
        const change = prev > 0 ? ((price - prev) / prev * 100) : 0;
        const changeStr = change !== 0 ? `${change >= 0 ? '+' : ''}${change.toFixed(1)}%` : '\u2014';
        const changeClass = change > 0 ? 'up' : change < 0 ? 'down' : '';
        const volume = Number(tea.volume_24h) || 0;
        const volStr = volume >= 1000 ? `${Math.round(volume / 1000)}K` : String(volume);

        const priceCell = tbody.querySelector(`[data-tea="${CSS.escape(tea.symbol)}"]`);
        if (priceCell) {
            priceCell.textContent = `$${price.toFixed(2)}`;
            priceCell.className = `price-cell ${changeClass}`;
            if (changedTeas[tea.symbol]) {
                priceCell.classList.add(`flash-${changedTeas[tea.symbol]}`);
                setTimeout(() => priceCell.classList.remove(`flash-${changedTeas[tea.symbol]}`), 600);
            }
        }
        const changeCell = tbody.querySelector(`[data-change="${CSS.escape(tea.symbol)}"]`);
        if (changeCell) {
            changeCell.textContent = changeStr;
            changeCell.className = changeClass;
        }
        const volCell = tbody.querySelector(`[data-vol="${CSS.escape(tea.symbol)}"]`);
        if (volCell) volCell.textContent = volStr;
    });
}

// =============================================
// TEA SELECT (Trade Form & Mobile Header)
// =============================================

function populateTeaSelect() {
    const selects = [
        document.getElementById('trade-tea-select'),
        document.getElementById('mobile-trade-tea-select')
    ].filter(Boolean); // Only work with elements that exist

    if (selects.length === 0) return;

    // Use the first select to check state, assuming they sync
    const firstSelect = selects[0];
    const currentValue = firstSelect.value;
    const currentQty = document.getElementById('trade-qty')?.value;

    // Skip full rebuild if user is actively using the form
    if (state.isTradeFormActive && currentValue) {
        // Just update the prices in existing options without rebuilding
        selects.forEach(select => {
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
        });

        updateTradeSummary();
        return;
    }

    // Full rebuild for both selects
    const optionsHTML = [];
    optionsHTML.push('<option value="">Select Asset...</option>');

    // Build the optgroup for Teas
    optionsHTML.push('<optgroup label="Teas">');
    state.teas.forEach(tea => {
        const change = tea.previous_price ? ((tea.current_price - tea.previous_price) / tea.previous_price * 100).toFixed(1) : '0.0';
        const changeSign = change >= 0 ? '+' : '';
        optionsHTML.push(`<option value="${tea.id}" data-price="${tea.current_price}">${tea.symbol} - $${tea.current_price.toFixed(2)} (${changeSign}${change}%)</option>`);
    });
    optionsHTML.push('</optgroup>');

    // Build the optgroup for Indexes
    const indexes = calculateRegionalIndexes();
    if (indexes && indexes.length > 0) {
        optionsHTML.push('<optgroup label="Regional Indexes">');
        indexes.forEach(idx => {
            if (!idx.teas || idx.teas.length === 0) return;
            const changeSign = idx.change >= 0 ? '+' : '';
            optionsHTML.push(`<option value="INDEX_${idx.symbol}" data-price="${idx.price}">${idx.symbol} Index - $${idx.price.toFixed(2)} (${changeSign}${idx.change.toFixed(1)}%)</option>`);
        });
        optionsHTML.push('</optgroup>');
    }

    // Apply the exact same built HTML to all selects simultaneously
    const joinedHTML = optionsHTML.join('');
    selects.forEach(select => {
        select.innerHTML = joinedHTML;
        if (currentValue) select.value = currentValue;
    });

    // Determine the main chart symbol
    const mainSym = state.mainChartData ? (_CARD_TO_INDEX[state.mainChartData.symbol] || state.mainChartData.symbol) : null;
    const isIdx = state.mainChartData ? !!state.mainChartData.isIndex : false;

    // Helper to find correct option value
    let valToSelect = null;
    if (mainSym) {
        if (isIdx) {
            valToSelect = 'INDEX_' + mainSym;
        } else {
            const t = state.teas?.find(x => x.symbol === mainSym);
            if (t) valToSelect = String(t.id);
        }
    }

    // Ensure selects display the current chart focus on first load/re-build
    if (valToSelect && select) { // fallback check if we don't have current value
        selects.forEach(sel => {
            if (sel.querySelector(`option[value="${valToSelect}"]`)) {
                sel.value = valToSelect;
            }
        });
    }

    updateTradeSummary();

    // The rest of this function handles event listeners for the desktop panel only
    // Mobile select has an inline onchange in HTML to sync the chart.
    const firstSelectElement = document.getElementById('trade-tea-select');
    if (firstSelectElement && !firstSelectElement._hasListener) {
        firstSelectElement.addEventListener('change', () => {
            const qtyInput = document.getElementById('trade-qty');
            if (!qtyInput.value) qtyInput.value = '100'; // Default 100kg
            updateTradeSummary();
            // Important: Change main chart dynamically when user selects a tea in the desktop trade form
            if (typeof syncChartToTradeSelect === 'function') {
                syncChartToTradeSelect();
            }
        });
        firstSelectElement._hasListener = true;
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

function _buildSparklineSvg(symbol, currentPrice, isUp) {
    const history = typeof getPriceHistorySync === 'function'
        ? getPriceHistorySync(symbol, 'tea', '1D') : [];
    const closes = history.slice(-20).map(c => c.close ?? c.price ?? c);
    const color = isUp ? 'var(--accent-green)' : 'var(--accent-red)';
    const w = 80, h = 28;

    if (closes.length < 2) {
        if (!currentPrice || currentPrice <= 0) return '<div class="skeleton sparkline-placeholder"></div>';
        return `<svg class="t212-sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
            <line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>
        </svg>`;
    }

    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const range = max - min || 1;

    const points = closes.map((v, i) => {
        const x = (i / (closes.length - 1)) * w;
        const y = h - ((v - min) / range) * (h - 4) - 2;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

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
            const sparkline = _buildSparklineSvg(tea.symbol, priceVal, isUp);
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
    { id: 'usdkes', key: 'usd_kes', iso: 'ke', name: 'USD / KES', desc: 'Kenyan Shilling', prefix: '', decimals: 2 },
    { id: 'usdinr', key: 'usd_inr', iso: 'in', name: 'USD / INR', desc: 'Indian Rupee', prefix: '', decimals: 2 },
    { id: 'usdlkr', key: 'usd_lkr', iso: 'lk', name: 'USD / LKR', desc: 'Sri Lankan Rupee', prefix: '', decimals: 2 },
    { id: 'usdcny', key: 'usd_cny', iso: 'cn', name: 'USD / CNY', desc: 'Chinese Yuan', prefix: '', decimals: 4 },
    { id: 'oil', key: 'brent_crude', iso: null, name: 'Brent Crude', desc: 'Shipping & logistics', prefix: '$', decimals: 2, oilIcon: true },
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
    const bidsEl = document.getElementById('depth-bids');
    const asksEl = document.getElementById('depth-asks');
    const ratioEl = document.getElementById('depth-ratio');
    if (!bidsEl || !asksEl) return;

    // Resolve the focused symbol — check hub first if maximized
    const isHubOpen = document.getElementById('chart-section')?.classList.contains('panel-maximized');
    const select = document.getElementById('trade-tea-select');
    const hubSelect = document.getElementById('hub-buy-symbol');
    let focusedSymbol = state.selectedQuoteSymbol || (isHubOpen ? hubSelect?.value : select?.value) || null;
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
            bidVol += p.buy5m; askVol += p.sell5m; return true;
        }
        if (p.buy30m > 0 || p.sell30m > 0) {
            bidVol += p.buy30m; askVol += p.sell30m; return true;
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

        // Add time-based oscillation to simulate live HFT quoting activity.
        // Three overlapping sine waves with different frequencies/phases give
        // an organic drift of ±3–5% that won't look mechanically repetitive.
        const t = Date.now() / 1000; // seconds
        const osc = (Math.sin(t * 0.12) * 2.8)       // slow drift ~25s period
                  + (Math.sin(t * 0.37 + 1.1) * 1.4)  // medium wave ~17s period
                  + (Math.sin(t * 0.71 + 2.5) * 0.8); // fast jitter ~9s period
        state.marketDepthBids = Math.max(25, Math.min(75, state.marketDepthBids + osc));

        bidPct = state.marketDepthBids;
        let totalVol = state.teas.reduce((sum, t) => sum + (t.volume_24h || 0), 0);
        if (totalVol === 0) totalVol = 14300000; // Mock fallback if DB volumes aren't hydrated yet
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
    asksEl.style.background = askPct > 55 ? 'var(--accent-red)' : askPct < 45 ? 'rgba(239,68,68,0.4)' : 'var(--accent-red)';

    // Format volumes
    const fmt = v => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M kg` : v >= 1000 ? `${(v / 1000).toFixed(1)}K kg` : `${v} kg`;
    document.getElementById('depth-bid-volume').textContent = `Vol: ${fmt(bidVol)}`;
    document.getElementById('depth-ask-volume').textContent = `Vol: ${fmt(askVol)}`;

    // Update Hub Elements
    const hubBidsEl = document.getElementById('hub-market-depth-buy');
    if (hubBidsEl) {
        hubBidsEl.style.width = `${bidPct}%`;
        hubBidsEl.textContent = `BIDS ${Math.round(bidPct)}%`;
        hubBidsEl.style.background = bidPct > 55 ? 'var(--accent-green)' : bidPct < 45 ? 'rgba(16,185,129,0.4)' : 'var(--accent-green)';
    }

    const hubAsksEl = document.getElementById('hub-market-depth-sell');
    if (hubAsksEl) {
        const askStr = `ASKS ${Math.round(askPct)}%`;
        hubAsksEl.style.width = `${askPct}%`;
        hubAsksEl.textContent = askStr;
        hubAsksEl.style.background = askPct > 55 ? 'var(--accent-red)' : askPct < 45 ? 'rgba(239,68,68,0.4)' : 'var(--accent-red)';
    }

    const hubRatioEl = document.getElementById('hub-bid-ask-ratio');
    if (hubRatioEl) hubRatioEl.textContent = ratio;

    const hubBidVolEl = document.getElementById('hub-market-vol-buy');
    if (hubBidVolEl) hubBidVolEl.textContent = `Vol: ${fmt(bidVol)}`;

    const hubAskVolEl = document.getElementById('hub-market-vol-sell');
    if (hubAskVolEl) hubAskVolEl.textContent = `Vol: ${fmt(askVol)}`;

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

    // Mid price from selected tea or index
    let midPriceVal = 0;
    const selectedTea = state.teas.find(t => t.symbol === (focusedSymbol || select?.value));
    if (selectedTea) {
        midPriceVal = selectedTea.current_price;
    } else {
        const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
        const selectedIdx = indexes.find(idx => idx.symbol === (focusedSymbol || select?.value));
        if (selectedIdx) {
            midPriceVal = selectedIdx.price;
            if (midPriceVal <= 0 && typeof _liveIndexPrice === 'function') {
                midPriceVal = _liveIndexPrice(selectedIdx.symbol);
            }
        }
    }
    const midPrice = (midPriceVal || 0).toFixed(2);
    document.getElementById('depth-mid-price').textContent = `Mid: $${midPrice}`;

    const hubMidPriceEl = document.getElementById('hub-market-mid-price');
    if (hubMidPriceEl) hubMidPriceEl.textContent = `Mid: $${midPrice}`;
}

function _flashMacroPrice(el, direction) {
    el.classList.remove('macro-flash-up', 'macro-flash-down');
    void el.offsetWidth; // force reflow to restart animation
    el.classList.add(direction > 0 ? 'macro-flash-up' : 'macro-flash-down');
    setTimeout(() => el.classList.remove('macro-flash-up', 'macro-flash-down'), 700);
}

function updateMacroIndicators() {
    const indicators = [
        { key: 'usd_kes', elId: 'macro-usdkes', changeId: 'macro-usdkes-change', rowId: 'macro-row-usdkes', prefix: '', decimals: 2 },
        { key: 'usd_inr', elId: 'macro-usdinr', changeId: 'macro-usdinr-change', rowId: 'macro-row-usdinr', prefix: '', decimals: 2 },
        { key: 'usd_lkr', elId: 'macro-usdlkr', changeId: 'macro-usdlkr-change', rowId: 'macro-row-usdlkr', prefix: '', decimals: 2 },
        { key: 'usd_cny', elId: 'macro-usdcny', changeId: 'macro-usdcny-change', rowId: 'macro-row-usdcny', prefix: '', decimals: 4 },
        { key: 'brent_crude', elId: 'macro-oil', changeId: 'macro-oil-change', rowId: 'macro-row-oil', prefix: '$', decimals: 2 },
    ];

    const DASH = '\u2014';

    indicators.forEach(ind => {
        const raw = state.macroIndicators?.[ind.key];
        const value = Number(raw);
        // Use the session-start baseline (set by startLiveForexFeed on first fetch)
        // for a meaningful "daily-style" change rather than tick-to-tick noise.
        const baselineVal = state.macroBaseline?.[ind.key];
        const prev = (baselineVal != null && !isNaN(Number(baselineVal)))
            ? Number(baselineVal)
            : Number(state.previousMacro?.[ind.key]);

        const priceEl = document.getElementById(ind.elId);
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
                const sign = pctChange > 0 ? '+' : '';
                changeEl.textContent = `${arrow} ${sign}${pctChange.toFixed(2)}%`;
                changeEl.className = 'macro-change ' + (pctChange > 0 ? 'up' : pctChange < 0 ? 'down' : '');
            } else {
                changeEl.textContent = DASH;
                changeEl.className = 'macro-change';
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
        { iso: 'ke', label: 'KES', key: 'usd_kes', prefix: '', decimals: 2 },
        { iso: 'in', label: 'INR', key: 'usd_inr', prefix: '', decimals: 2 },
        { iso: 'lk', label: 'LKR', key: 'usd_lkr', prefix: '', decimals: 2 },
        { iso: 'cn', label: 'CNY', key: 'usd_cny', prefix: '', decimals: 4 },
        { iso: null, label: 'OIL', key: 'brent_crude', prefix: '$', decimals: 2, fallback: '\uD83D\uDEE2\uFE0F' }
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

    // ── First render: build full HTML ──
    const existingCards = board.querySelectorAll('[data-symbol]');
    const needsFullRebuild = existingCards.length !== topTeas.length ||
        !topTeas.every((tea, i) => existingCards[i]?.dataset.symbol === tea.symbol);

    if (needsFullRebuild) {
        board.innerHTML = topTeas.map(tea => {
            const parts = tea.symbol.split('-');
            const prefix = parts[0];
            const symbol = parts[1] || tea.symbol;
            const price = Number(tea.current_price) || 0;
            const prev = Number(tea.previous_price) || price;
            const change = prev > 0 ? ((price - prev) / prev * 100) : 0;
            const volume = Number(tea.volume_24h) || 0;
            const isUp = change >= 0;
            const tMode = tea.trading_mode || 'FULL';
            const isHalted = tMode === 'HALTED';
            state.previousQuotePrices[tea.symbol] = price;
            const volDisplay = volume >= 1000 ? `${Math.round(volume / 1000)}K` : volume.toString();
            const country = COUNTRY_MAP[prefix];
            const countryHtml = country
                ? `<div class="quote-country" title="${country.label}"><span class="quote-country-flag">${flagImg(country.iso, 16)}</span><span class="quote-country-code">${prefix}</span></div>`
                : `<div class="quote-country" style="visibility:hidden;"><span class="quote-country-code">${prefix}</span></div>`;
            return `
                <div class="quote-card${isHalted ? ' halted-card' : ''}" data-symbol="${escapeHtml(tea.symbol)}" onclick="${isHalted ? '' : `selectTeaForTrading('${escapeHtml(tea.symbol)}')`}">
                    <div class="quote-symbol">
                        ${escapeHtml(symbol)}
                        ${isHalted ? '<span class="mode-badge mode-halted" style="font-size:8px;padding:2px 4px;vertical-align:middle;">HALTED</span>' : ''}
                    </div>
                    ${countryHtml}
                    <div class="quote-price ${isUp ? 'up' : 'down'}" data-qprice="${escapeHtml(tea.symbol)}">${isHalted ? '🔒' : `$${price.toFixed(2)}`}</div>
                    <div class="quote-change ${isUp ? 'up' : 'down'}" data-qchange="${escapeHtml(tea.symbol)}">${isUp ? '\u25B2' : '\u25BC'} ${change >= 0 ? '+' : ''}${change.toFixed(1)}%</div>
                    <div class="quote-volume" data-qvol="${escapeHtml(tea.symbol)}">Vol: ${volDisplay}</div>
                </div>
            `;
        }).join('');
        return;
    }

    // ── Subsequent ticks: surgical updates only ──
    topTeas.forEach(tea => {
        const price = Number(tea.current_price) || 0;
        const prev = Number(tea.previous_price) || price;
        const change = prev > 0 ? ((price - prev) / prev * 100) : 0;
        const volume = Number(tea.volume_24h) || 0;
        const isUp = change >= 0;
        const tMode = tea.trading_mode || 'FULL';
        const isHalted = tMode === 'HALTED';
        const volDisplay = volume >= 1000 ? `${Math.round(volume / 1000)}K` : volume.toString();

        const prevPrice = state.previousQuotePrices[tea.symbol];
        const priceChanged = prevPrice !== undefined && prevPrice !== price;
        state.previousQuotePrices[tea.symbol] = price;

        // Update the card's halted class
        const card = board.querySelector(`[data-symbol="${CSS.escape(tea.symbol)}"]`);
        if (card) {
            card.classList.toggle('halted-card', isHalted);
            card.classList.toggle('selected', !isHalted && state.selectedQuoteSymbol === tea.symbol);
            card.onclick = isHalted ? null : () => selectTeaForTrading(tea.symbol);
        }

        // Update price cell
        const priceEl = board.querySelector(`[data-qprice="${CSS.escape(tea.symbol)}"]`);
        if (priceEl) {
            priceEl.textContent = isHalted ? '🔒' : `$${price.toFixed(2)}`;
            priceEl.className = `quote-price ${isUp ? 'up' : 'down'}`;
            if (!isHalted && priceChanged) {
                const flashClass = price > prevPrice ? 'flash-green' : 'flash-red';
                priceEl.classList.add(flashClass);
                setTimeout(() => priceEl.classList.remove(flashClass), 600);
            }
        }

        // Update change cell
        const changeEl = board.querySelector(`[data-qchange="${CSS.escape(tea.symbol)}"]`);
        if (changeEl) {
            changeEl.textContent = `${isUp ? '\u25B2' : '\u25BC'} ${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
            changeEl.className = `quote-change ${isUp ? 'up' : 'down'}`;
        }

        // Update volume cell
        const volEl = board.querySelector(`[data-qvol="${CSS.escape(tea.symbol)}"]`);
        if (volEl) volEl.textContent = `Vol: ${volDisplay}`;
    });
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
            container.innerHTML = '<div style="padding:10px 0;color:var(--text-muted);text-align:center;font-size:11px;">No trades this week yet</div>';
            return;
        }
        container.innerHTML = traders.map((t, i) => {
            const rank = i + 1;
            let rankClass = '';
            if (rank === 1) rankClass = 'gold';
            else if (rank === 2) rankClass = 'silver';
            else if (rank === 3) rankClass = 'bronze';
            const vol = t.total_volume;
            let label;
            if (vol >= 1e6) label = (vol / 1e6).toFixed(1) + 'M kg';
            else if (vol >= 1e3) label = (vol / 1e3).toFixed(0) + 'K kg';
            else label = vol.toLocaleString() + ' kg';
            const name = t.username || t.user_id?.slice(0, 8) || 'Anon';
            return `<div class="rp-lb-item">
                <div class="rp-lb-rank ${rankClass}">${rank}</div>
                <div class="rp-lb-name">${escapeHtml(name)}</div>
                <div class="rp-lb-val" style="color:var(--text-muted);">${label}</div>
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
    _updateRightPanelLeaderboard(leaders);

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

function _updateRightPanelLeaderboard(leaders) {
    const container = document.getElementById('rp-leaderboard-list');
    const dateEl = document.getElementById('rp-lb-date');
    if (!container) return;

    if (dateEl) {
        const now = new Date();
        dateEl.textContent = now.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }).toUpperCase();
    }

    if (!leaders || leaders.length === 0) {
        container.innerHTML = '<div style="padding:10px 0;color:var(--text-muted);text-align:center;font-size:11px;">No traders yet</div>';
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
        return `<div class="rp-lb-item" onclick="if(typeof openTraderProfile==='function') openTraderProfile('${escapeHtml(user.username)}', ${pct}, ${user.total_value || 0}, ${rank});">
            <div class="rp-lb-rank ${rankClass}">${rank}</div>
            <div class="rp-lb-name">${escapeHtml(user.username)}</div>
            <div class="rp-lb-val ${pctClass}">${sign}${pct.toFixed(1)}%</div>
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
        markets: 'view-markets',
        chart: 'view-chart',
        portfolio: 'view-portfolio',
        chat: 'view-chat',
        social: 'view-social',
        more: 'view-more'
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

    let marketPrice = 0;
    let isIdx = false;

    if (state.mainChartData && state.mainChartData.symbol) {
        const sym = state.mainChartData.symbol;
        isIdx = state.mainChartData.isIndex;

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
                isIdx = true;
                const s = selectValue.replace('INDEX_', '');
                const indexes = typeof calculateRegionalIndexes === 'function'
                    ? calculateRegionalIndexes() : [];
                const idx = indexes.find(i => i.symbol === s);
                marketPrice = idx?.price || 0;
            } else {
                isIdx = false;
                const teaId = parseInt(selectValue);
                const tea = state.teas?.find(t => t.id === teaId);
                marketPrice = tea?.current_price || 0;
            }
        }
    }

    if (marketPrice > 0) {
        // Index spread = 2% total (1% per side), tea spread = 1% total (0.5% per side)
        const SPREAD_PCT = isIdx ? 0.02 : 0.01;
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

window.switchMobileSection = function (section) {
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

window.initMobileNavigation = function () {
    const nav = document.getElementById('mobile-bottom-nav');
    if (!nav) return;

    // Attach click listeners strictly
    nav.querySelectorAll('.mobile-nav-btn').forEach(btn => {
        btn.onclick = function (e) {
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
window.openHubForSymbol = function (symbol) {
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
window.openMobileTradeSheet = function (side) {
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
            var idx = indexes.find(function (i) { return i.symbol === sym; });
            if (idx) {
                tea = { symbol: idx.symbol, name: idx.name, current_price: idx.price, isIndex: true };
            }
        } else {
            tea = (state.teas || []).find(function (t) { return t.symbol === sym; });
        }
    }
    if (!tea) tea = state.qqCurrentTea || null;
    if (!tea) {
        if (typeof showToast === 'function') showToast('Select an instrument first', '', true);
        return;
    }
    state.qqCurrentTea = tea;

    // 2. Calculate execution price with spread (mirrors updateQuickTradeSummary)
    // Index spread = 2% total (1% per side), tea spread = 1% total (0.5% per side)
    var isIndex = tea.isIndex || (typeof isIndexSymbol === 'function' && isIndexSymbol(tea.symbol));
    var SPREAD_PCT = isIndex ? 0.02 : 0.01;
    var marketPrice = 0;
    if (tea.isIndex || (typeof isIndexSymbol === 'function' && isIndexSymbol(tea.symbol))) {
        var idxs = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
        var match = idxs.find(function (i) { return i.symbol === tea.symbol; });
        marketPrice = match ? match.price : (tea.current_price || 0);
    } else {
        var liveTea = (state.teas || []).find(function (t) { return t.symbol === tea.symbol; });
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
    document.addEventListener('DOMContentLoaded', function () {
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
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); doSend(); }
        });

        setInterval(function () {
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
        var retSel = useMobileFormat ? '.mobile-lb-return' : '.leaderboard-return';
        var items = Array.from(src.querySelectorAll(itemSel));
        if (items.length === 0) items = Array.from(src.children);

        var html = '';
        items.forEach(function (item, i) {
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

    document.querySelectorAll('.more-sub-screen').forEach(function (s) { s.classList.remove('active'); });
    var sub = document.getElementById('more-sub-' + screen);
    if (sub) sub.classList.add('active');

    if (screen === 'weather') populateMoreWeather();
    if (screen === 'currency') populateMoreCurrency();
    if (screen === 'leaderboard') populateMoreLeaderboard();
    if (screen === 'history') populateMoreHistory();
    if (screen === 'alerts') populateMoreAlerts();
}

function closeMoreSubScreen() {
    document.querySelectorAll('.more-sub-screen').forEach(function (s) { s.classList.remove('active'); });
    var grid = document.getElementById('more-menu-grid');
    if (grid) grid.classList.remove('hidden');
}

function _weatherSvgIcon(bg) {
    var icons = {
        sunny: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="1.8"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
        cloudy: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.8"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>',
        rain: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="1.8"><path d="M17.5 17H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><line x1="8" y1="19" x2="8" y2="21"/><line x1="12" y1="19" x2="12" y2="21"/><line x1="16" y1="19" x2="16" y2="21"/></svg>',
        snow: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" stroke-width="1.8"><path d="M17.5 17H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><line x1="8" y1="20" x2="8.01" y2="20"/><line x1="12" y1="20" x2="12.01" y2="20"/><line x1="16" y1="20" x2="16.01" y2="20"/></svg>',
        foggy: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="1.8"><path d="M17.5 17H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><line x1="4" y1="20" x2="20" y2="20"/><line x1="6" y1="23" x2="18" y2="23"/></svg>',
        storm: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="1.8"><path d="M17.5 17H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><polyline points="13 17 9 22 13 22 11 24"/></svg>'
    };
    return icons[bg] || icons.cloudy;
}

function populateMoreWeather() {
    var content = document.getElementById('more-weather-content');
    if (!content) return;

    var cache = (typeof _weatherCache !== 'undefined') ? _weatherCache : [];
    if (!cache.length) {
        content.innerHTML = '<div class="ms-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#4b5563" stroke-width="1.5"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg><p>Weather data is loading...</p><p class="ms-empty-sub">Growing region forecasts will appear here once loaded.</p></div>';
        return;
    }

    var html = '';
    cache.forEach(function (entry, idx) {
        if (!entry || entry.error || !entry.weather) return;
        var r = entry.region;
        var w = entry.weather;
        var temp = w.temp != null ? w.temp + '°' : '--';
        var feels = w.feelsLike != null ? 'Feels ' + w.feelsLike + '°' : '';
        var humidity = w.humidity != null ? w.humidity + '%' : '--';
        var wind = w.windSpeed != null ? w.windSpeed + ' km/h' : '--';
        var cond = (typeof _wmoInfo === 'function') ? _wmoInfo(w.code) : { label: 'Unknown', bg: 'cloudy' };
        var svgIcon = _weatherSvgIcon(cond.bg);
        var flag = (typeof flagImg === 'function') ? flagImg(r.iso, 20) : '';

        html += '<div class="ms-card" onclick="if(typeof openWeatherPopout===\'function\') openWeatherPopout(' + idx + ', this);">' +
            '<div class="ms-card-row">' +
            '<div class="ms-weather-icon-wrap">' + svgIcon + '</div>' +
            '<div class="ms-card-info">' +
            '<div class="ms-card-title">' + flag + ' ' + r.name + '</div>' +
            '<div class="ms-card-sub">' + cond.label + '</div>' +
            '</div>' +
            '<div style="text-align:right;">' +
            '<div class="ms-card-value">' + temp + '</div>' +
            '<div style="font-size:11px;color:#6b7280;">' + feels + '</div>' +
            '</div>' +
            '</div>' +
            '<div class="ms-card-stats">' +
            '<span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2"><path d="M12 2v6l3 3"/><path d="M12 22a7 7 0 0 0 0-14"/></svg> ' + humidity + '</span>' +
            '<span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2"><path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"/></svg> ' + wind + '</span>' +
            (w.uv != null ? '<span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/></svg> UV ' + w.uv + '</span>' : '') +
            '</div>' +
            '</div>';
    });
    content.innerHTML = html || '<div class="ms-empty"><p>No weather data available.</p></div>';
}

function populateMoreCurrency() {
    var content = document.getElementById('more-currency-content');
    if (!content) return;

    var DASH = '\u2014';
    var html = '';

    MACRO_ROW_DEFS.forEach(function (def) {
        var raw = state.macroIndicators?.[def.key];
        var value = Number(raw);
        var baseline = state.macroBaseline?.[def.key];
        var prev = (baseline != null && !isNaN(Number(baseline))) ? Number(baseline) : Number(state.previousMacro?.[def.key]);

        var priceStr = (!isNaN(value)) ? def.prefix + value.toFixed(def.decimals) : DASH;

        var changePct = 0;
        var changeClass = '';
        var changeStr = DASH;
        if (!isNaN(value) && !isNaN(prev) && prev !== 0) {
            changePct = ((value - prev) / prev) * 100;
            changeClass = changePct > 0 ? 'up' : changePct < 0 ? 'down' : '';
            var arrow = changePct > 0 ? '\u25B2' : changePct < 0 ? '\u25BC' : '';
            changeStr = arrow + ' ' + (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%';
        }

        var flagCircle = def.iso
            ? '<div class="t212-flag-circle">' + flagImg(def.iso, 22) + '</div>'
            : '<div class="t212-flag-circle"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M12 6v12M6 12h12"/></svg></div>';

        var sparkline = _buildMacroSparkline(def.key);

        html += '<div class="t212-market-row" style="margin:0 16px;border-radius:12px;margin-bottom:8px;background:#151d2b;border:1px solid rgba(255,255,255,0.05);" onclick="if(typeof openMacroPopout===\'function\') openMacroPopout(\'' + def.id + '\', this);">' +
            '<div class="t212-row-left">' +
            flagCircle +
            '<div class="t212-symbol-stack">' +
            '<span class="t212-symbol-name">' + def.name + '</span>' +
            '<span class="t212-symbol-desc">' + def.desc + '</span>' +
            '</div>' +
            '</div>' +
            '<div class="t212-sparkline-wrap">' + sparkline + '</div>' +
            '<div class="t212-row-right">' +
            '<span class="t212-price-text">' + priceStr + '</span>' +
            '<span class="t212-change-pill ' + changeClass + '">' + changeStr + '</span>' +
            '</div>' +
            '</div>';
    });

    content.innerHTML = '<div style="padding-top:12px;">' + html + '</div>';
}

function populateMoreLeaderboard() {
    var content = document.getElementById('more-leaderboard-content');
    if (!content) return;

    var traders = (typeof state !== 'undefined' && state.topTraders) ? state.topTraders : [];
    if (!traders.length) {
        var src = document.getElementById('leaderboard-list');
        if (!src || src.children.length === 0) src = document.getElementById('mobile-leaderboard-list');
        if (src && src.children.length > 0) {
            content.innerHTML = '<div style="padding:16px;">' + src.innerHTML + '</div>';
            return;
        }
        content.innerHTML = '<div class="ms-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#4b5563" stroke-width="1.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg><p>Leaderboard loading...</p></div>';
        return;
    }

    var html = '';
    traders.forEach(function (t, i) {
        var rank = i + 1;
        var medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '<span style="color:#6b7280;font-weight:600;">#' + rank + '</span>';
        var name = t.display_name || t.username || 'Trader';
        var vol = t.total_volume ? '$' + Number(t.total_volume).toLocaleString() : '--';
        html += '<div class="ms-card" style="cursor:default;">' +
            '<div class="ms-card-row">' +
            '<div class="ms-card-icon" style="font-size:20px;width:32px;text-align:center;">' + medal + '</div>' +
            '<div class="ms-card-info"><div class="ms-card-title">' + name + '</div></div>' +
            '<div class="ms-card-value" style="font-size:13px;">' + vol + '</div>' +
            '</div>' +
            '</div>';
    });
    content.innerHTML = html;
}

function populateMoreHistory() {
    var content = document.getElementById('more-history-content');
    if (!content) return;

    var trades = (typeof state !== 'undefined' && state.currentTradesData) ? state.currentTradesData : [];
    if (!trades.length) {
        content.innerHTML = '<div class="ms-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#4b5563" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><p>No trade history yet</p><p class="ms-empty-sub">Your completed trades will appear here.</p></div>';
        return;
    }

    var sorted = trades.slice().sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });

    var totalTrades = sorted.length;
    var buys = sorted.filter(function (t) { return t.side === 'BUY'; }).length;
    var sells = totalTrades - buys;
    var totalVolume = sorted.reduce(function (sum, t) { return sum + Math.abs(t.quantity || 0) * (t.price || 0); }, 0);

    var uniqueSymbols = {};
    sorted.forEach(function (t) {
        var s = t.index_symbol || '';
        if (!s && t.tea_id) {
            var tea = (state.teas || []).find(function (x) { return x.id === t.tea_id; });
            s = tea ? tea.symbol : '';
        }
        if (s) uniqueSymbols[s] = (uniqueSymbols[s] || 0) + 1;
    });
    var topSymbol = Object.keys(uniqueSymbols).sort(function (a, b) { return uniqueSymbols[b] - uniqueSymbols[a]; })[0] || '--';

    var html = '<div class="ms-stats-grid">' +
        '<div class="ms-stat-card">' +
        '<div class="ms-stat-value">' + totalTrades + '</div>' +
        '<div class="ms-stat-label">Total Trades</div>' +
        '</div>' +
        '<div class="ms-stat-card">' +
        '<div class="ms-stat-value" style="color:#00e676;">' + buys + ' <span style="color:#6b7280;font-size:11px;">/ </span><span style="color:#ef4444;">' + sells + '</span></div>' +
        '<div class="ms-stat-label">Buy / Sell</div>' +
        '</div>' +
        '<div class="ms-stat-card">' +
        '<div class="ms-stat-value">$' + (totalVolume >= 1000 ? (totalVolume / 1000).toFixed(1) + 'k' : totalVolume.toFixed(0)) + '</div>' +
        '<div class="ms-stat-label">Volume</div>' +
        '</div>' +
        '<div class="ms-stat-card">' +
        '<div class="ms-stat-value" style="font-size:13px;">' + topSymbol + '</div>' +
        '<div class="ms-stat-label">Most Traded</div>' +
        '</div>' +
        '</div>';

    html += '<div class="ms-section-title">Recent Trades</div>';

    sorted.slice(0, 30).forEach(function (t) {
        var sym = '';
        if (t.index_symbol) { sym = t.index_symbol; }
        else {
            var tea = (state.teas || []).find(function (x) { return x.id === t.tea_id; });
            sym = tea ? tea.symbol : 'Tea #' + t.tea_id;
        }
        var isBuy = t.side === 'BUY';
        var sideColor = isBuy ? '#00e676' : '#ef4444';
        var date = new Date(t.created_at);
        var dateStr = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' + date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        var qty = Math.abs(t.quantity || 0);
        var price = t.price ? '$' + Number(t.price).toFixed(2) : '--';
        var lev = t.leverage && t.leverage > 1 ? t.leverage + 'x' : '';

        html += '<div class="ms-card" style="cursor:default;">' +
            '<div class="ms-card-row">' +
            '<div class="ms-trade-badge" style="background:' + sideColor + '15;color:' + sideColor + ';">' + t.side + '</div>' +
            '<div class="ms-card-info">' +
            '<div class="ms-card-title">' + sym + (lev ? ' <span style="font-size:10px;color:#6b7280;">' + lev + '</span>' : '') + '</div>' +
            '<div class="ms-card-sub">' + dateStr + ' &middot; ' + qty.toLocaleString() + ' kg</div>' +
            '</div>' +
            '<div class="ms-card-value">' + price + '</div>' +
            '</div>' +
            '</div>';
    });
    content.innerHTML = html;
}

function populateMoreAlerts() {
    var content = document.getElementById('more-alerts-content');
    if (!content) return;

    var alerts = (typeof state !== 'undefined' && state.priceAlerts) ? state.priceAlerts : {};
    var keys = Object.keys(alerts);

    if (keys.length === 0) {
        content.innerHTML = '<div class="ms-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#4b5563" stroke-width="1.5"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg><p>No price alerts set</p><p class="ms-empty-sub">Open a chart and tap the bell icon to create one.</p></div>';
        return;
    }

    var html = '';
    keys.forEach(function (sym) {
        var a = alerts[sym];
        var tea = (state.teas || []).find(function (x) { return x.symbol === sym; });
        var currentPx = tea ? '$' + Number(tea.current_price).toFixed(2) : '';
        var below = a.below ? '$' + Number(a.below).toFixed(2) : '--';
        var above = a.above ? '$' + Number(a.above).toFixed(2) : '--';

        html += '<div class="ms-card" onclick="if(typeof openPriceAlertModal===\'function\'){var t=(state.teas||[]).find(function(x){return x.symbol===\'' + sym + '\'});if(t) openPriceAlertModal(t.symbol,t.current_price);}">' +
            '<div class="ms-card-row">' +
            '<div style="width:42px;height:42px;border-radius:10px;background:rgba(245,158,11,0.12);display:flex;align-items:center;justify-content:center;flex-shrink:0;">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>' +
            '</div>' +
            '<div class="ms-card-info" style="margin-left:12px;">' +
            '<div class="ms-card-title">' + sym + (currentPx ? ' <span style="color:#6b7280;font-size:12px;">' + currentPx + '</span>' : '') + '</div>' +
            '<div class="ms-card-sub">' +
            '<span style="color:#ef4444;">SL ' + below + '</span> &bull; <span style="color:#00e676;">TP ' + above + '</span>' +
            '</div>' +
            '</div>' +
            '<div class="ms-card-chevron">›</div>' +
            '</div>' +
            '</div>';
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

    window.closeMobileHeader = function () {
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
        authItems.forEach(function (id) {
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

        document.querySelectorAll('.app-view').forEach(function (view) {
            view.addEventListener('scroll', function () {
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

    document.addEventListener('DOMContentLoaded', function () {
        var hamburger = document.getElementById('mth-hamburger');
        if (hamburger) hamburger.onclick = openMobileHeader;

        var closeBtn = document.getElementById('mth-menu-close');
        if (closeBtn) closeBtn.onclick = closeMobileHeader;

        var overlay = document.getElementById('mth-menu-overlay');
        if (overlay) overlay.onclick = closeMobileHeader;

        var modeToggleItem = document.getElementById('mth-item-mode');
        if (modeToggleItem) {
            modeToggleItem.onclick = function () {
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

        setInterval(function () {
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
        navigator.share(payload).catch(function () { });
    } else {
        navigator.clipboard.writeText(payload.url).then(function () {
            _showShareToast('Link copied to clipboard');
        }).catch(function () {
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
    requestAnimationFrame(function () {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    });
    setTimeout(function () {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
        setTimeout(function () { toast.remove(); }, 300);
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

    setTimeout(reveal, 5000);

    var origExecute = window.executeTrade;
    if (typeof origExecute === 'function') {
        window.executeTrade = function () {
            var result = origExecute.apply(this, arguments);
            reveal();
            return result;
        };
    }
    var origExecHub = window.executeHubTrade;
    if (typeof origExecHub === 'function') {
        window.executeHubTrade = function () {
            var result = origExecHub.apply(this, arguments);
            reveal();
            return result;
        };
    }
})();

// =============================================
// FIRST TRADE MISSION
// =============================================

function startFirstTradeMission() {
    if (localStorage.getItem('firstTradeMissionDone')) return;

    // Show intercept modal
    const modal = document.getElementById('first-trade-modal');
    if (modal) modal.classList.add('visible');

    // Add pulse animation to main BUY buttons
    const tradeBtn = document.getElementById('trade-execute-btn');
    if (tradeBtn) tradeBtn.classList.add('pulse-animation');

    const hubBuyBtn = document.getElementById('btn-trade-buy'); // The buy toggle button in the main panel
    if (hubBuyBtn) hubBuyBtn.classList.add('pulse-animation');

    // Pre-fill the standard order ticket (Assam, 100kg, 1x leverage)
    const teaSelect = document.getElementById('trade-tea-select');
    if (teaSelect && typeof setTradeType === 'function') {
        const assamOptions = Array.from(teaSelect.options).filter(opt => opt.text.toLowerCase().includes('assam'));
        if (assamOptions.length > 0) {
            teaSelect.value = assamOptions[0].value;
        } else if (teaSelect.options.length > 1) {
            teaSelect.value = teaSelect.options[1].value;
        }
    }

    const qtyInput = document.getElementById('trade-qty');
    if (qtyInput) qtyInput.value = '100';

    const levSelect = document.getElementById('trade-leverage');
    if (levSelect) levSelect.value = '1';

    if (typeof updateTradeSummary === 'function') {
        updateTradeSummary();
    }
    if (typeof setTradeType === 'function') {
        setTradeType('BUY'); // Force BUY side
    }
}

function completeFirstTradeMissionAck() {
    const modal = document.getElementById('first-trade-modal');
    if (modal) modal.classList.remove('visible');
}

function completeFirstTradeMissionTrade() {
    if (localStorage.getItem('firstTradeMissionDone')) return;
    localStorage.setItem('firstTradeMissionDone', 'true');

    const tradeBtn = document.getElementById('trade-execute-btn');
    if (tradeBtn) tradeBtn.classList.remove('pulse-animation');

    const hubBuyBtn = document.getElementById('btn-trade-buy');
    if (hubBuyBtn) hubBuyBtn.classList.remove('pulse-animation');
}