/**
 * TeaTrade Exchange - Core UI Updates (ui.js)
 * ============================================
 * Handles all core DOM updates: auction table, quote board, watchlist,
 * market depth, macro indicators, tea selects, and mobile menu.
 *
 * Globals used from config.js  : state, teaDisplayData, cardData, isIndexSymbol
 * Globals used from market.js  : calculateRegionalIndexes
 * Globals used from utils.js   : showToast
 * Globals from quoteModal.js   : openQuickQuoteModal
 *
 * Functions called from other files (available at runtime as globals):
 *   updateTradeSummary, updateTradeButton, updateHubOrderPreview,
 *   openPriceAlertModal
 */

// Country prefix → flag emoji + display label
const COUNTRY_MAP = {
    KEN: { flag: '🇰🇪', label: 'Kenya'     },
    CHN: { flag: '🇨🇳', label: 'China'     },
    IND: { flag: '🇮🇳', label: 'India'     },
    SRI: { flag: '🇱🇰', label: 'Sri Lanka' },
    MLW: { flag: '🇲🇼', label: 'Malawi'    },
    RWA: { flag: '🇷🇼', label: 'Rwanda'    },
    UGA: { flag: '🇺🇬', label: 'Uganda'    },
    TZA: { flag: '🇹🇿', label: 'Tanzania'  },
    VIE: { flag: '🇻🇳', label: 'Vietnam'   },
    JPN: { flag: '🇯🇵', label: 'Japan'     },
};

// =============================================
// AUCTION TABLE
// =============================================

function updateAuctionTable() {
    const tbody = document.getElementById('auction-table-body');
    if (!tbody || !state.teas.length) return;

    // Build tea lookup map
    const teaMap = {};
    state.teas.forEach(tea => teaMap[tea.symbol] = tea);

    // Build auction items from display data
    const auctionItems = Object.entries(teaDisplayData).map(([symbol, displayData]) => {
        // Get price source - either this symbol or priceFrom reference
        const priceSymbol = displayData.priceFrom || symbol;
        const tea = teaMap[priceSymbol] || {
            symbol: priceSymbol,
            current_price: displayData.soldPrice || 0,
            previous_price: displayData.soldPrice || 0
        };
        return { symbol, tea, displayData };
    });

    // Sort: BIDDING first, then PENDING, then SOLD (by soldTime desc)
    const statusOrder = { 'BIDDING': 0, 'PENDING': 1, 'SOLD': 2 };
    auctionItems.sort((a, b) => {
        const statusDiff = statusOrder[a.displayData.status] - statusOrder[b.displayData.status];
        if (statusDiff !== 0) return statusDiff;
        if (a.displayData.status === 'SOLD') {
            return (b.displayData.soldTime || 0) - (a.displayData.soldTime || 0);
        }
        return 0;
    });

    // Detect price changes only for BIDDING lots
    const changedTeas = {};
    auctionItems.forEach(({ symbol, tea, displayData }) => {
        if (displayData.status === 'BIDDING') {
            const trackKey = symbol;
            if (state.previousAuctionPrices[trackKey] !== undefined &&
                state.previousAuctionPrices[trackKey] !== tea.current_price) {
                changedTeas[symbol] = tea.current_price > state.previousAuctionPrices[trackKey] ? 'up' : 'down';
            }
            state.previousAuctionPrices[trackKey] = tea.current_price;
        }
    });

    tbody.innerHTML = auctionItems.map(({ symbol, tea, displayData }) => {
        const status = displayData.status;
        const buyer = displayData.buyer;

        let displayPrice;
        let changeStr;
        let changeClass = '';
        let flashClass = '';

        if (status === 'SOLD') {
            displayPrice = displayData.soldPrice || tea.current_price;
            changeStr = '\u2014';
        } else if (status === 'PENDING') {
            displayPrice = tea.current_price;
            changeStr = '\u2014';
        } else {
            // BIDDING - live price with changes
            displayPrice = tea.current_price;
            const change = tea.previous_price
                ? ((tea.current_price - tea.previous_price) / tea.previous_price * 100)
                : 0;
            changeStr = change !== 0 ? `${change >= 0 ? '+' : ''}${change.toFixed(1)}%` : '\u2014';
            changeClass = change > 0 ? 'up' : change < 0 ? 'down' : '';
            flashClass = changedTeas[symbol] ? `flash-${changedTeas[symbol]}` : '';
        }

        let statusColor;
        if (status === 'SOLD') {
            statusColor = 'var(--accent-green)';
        } else if (status === 'BIDDING') {
            statusColor = 'var(--accent-orange)';
        } else {
            statusColor = 'var(--text-muted)';
        }

        return `
            <tr>
                <td style="font-family: 'JetBrains Mono', monospace;">#${escapeHtml(String(displayData.lot))}</td>
                <td><span class="grade-badge">${escapeHtml(displayData.grade)}</span></td>
                <td>${escapeHtml(displayData.estate)}</td>
                <td class="auction-center">${escapeHtml(displayData.origin)}</td>
                <td>${displayData.qty.toLocaleString()}</td>
                <td class="price-cell ${changeClass} ${flashClass}" data-tea="${escapeHtml(symbol)}">
                    <span>$${displayPrice.toFixed(2)}</span>
                    <button class="price-alert-btn ${state.priceAlerts[symbol] ? 'has-alert' : ''}" onclick="event.stopPropagation(); openPriceAlertModal('${escapeHtml(symbol)}', ${displayPrice})" title="Set price alert">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                            <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
                        </svg>
                    </button>
                </td>
                <td class="${changeClass}">${changeStr}</td>
                <td>${escapeHtml(buyer)}</td>
                <td><span style="color: ${statusColor};">${escapeHtml(status)}</span></td>
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

function updateWatchlistTeas() {
    const container = document.getElementById('watchlist-teas');
    if (!container || !state.teas || state.teas.length === 0) return;

    // Show top 5 teas with most volume/activity
    const watchlistTeas = state.teas.slice(0, 5);

    let html = '';
    watchlistTeas.forEach(tea => {
        const change = tea.previous_price > 0
            ? ((tea.current_price - tea.previous_price) / tea.previous_price) * 100
            : (tea.price_change_24h || 0);
        const isUp = change >= 0;
        const shortSymbol = tea.symbol.split('-')[1] || tea.symbol;
        const origin = tea.symbol.split('-')[0] || '';

        const priceVal = Number(tea.current_price) || 0;
        const changeVal = Number(change) || 0;
        html += `
            <div class="watchlist-item" onclick="openWatchlistChart('${escapeHtml(tea.symbol)}')" data-symbol="${escapeHtml(tea.symbol)}">
                <div>
                    <div class="watchlist-name">${escapeHtml(tea.name || shortSymbol)}</div>
                    <div class="watchlist-grade">${escapeHtml(origin)} ${escapeHtml(tea.grade || shortSymbol)}</div>
                </div>
                <div class="watchlist-price">
                    <div class="watchlist-value">$${priceVal.toFixed(2)}</div>
                    <div class="watchlist-change ${isUp ? 'up' : 'down'}">${isUp ? '+' : ''}${changeVal.toFixed(1)}%</div>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

function openWatchlistChart(symbol) {
    const tea = state.teas.find(t => t.symbol === symbol);
    if (tea) {
        openQuickQuoteModal(tea);
    }
}

function switchWatchlistTab(tab) {
    document.querySelectorAll('.watchlist-tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');

    document.getElementById('watchlist-teas').style.display = tab === 'teas' ? 'block' : 'none';
    document.getElementById('watchlist-macro').style.display = tab === 'macro' ? 'block' : 'none';
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
// GLOBAL TICKER TAPE (Scrolling Forex + Oil)
// =============================================

function updateGlobalTicker() {
    const track = document.getElementById('global-ticker-track');
    if (!track) return;

    const DASH = '\u2014';

    // Ticker items config: flag (HTML entity pairs), label, state key, prefix, decimals
    const tickerItems = [
        { flag: '\uD83C\uDDF0\uD83C\uDDEA', label: 'KES',  key: 'usd_kes',     prefix: '',  decimals: 2 },
        { flag: '\uD83C\uDDEE\uD83C\uDDF3', label: 'INR',  key: 'usd_inr',     prefix: '',  decimals: 2 },
        { flag: '\uD83C\uDDF1\uD83C\uDDF0', label: 'LKR',  key: 'usd_lkr',     prefix: '',  decimals: 2 },
        { flag: '\uD83C\uDDE8\uD83C\uDDF3', label: 'CNY',  key: 'usd_cny',     prefix: '',  decimals: 4 },
        { flag: '\uD83D\uDEE2\uFE0F',       label: 'OIL',  key: 'brent_crude', prefix: '$', decimals: 2 }
    ];

    // Check if any data has arrived
    const hasData = tickerItems.some(t => {
        const v = state.macroIndicators?.[t.key];
        return v != null && !isNaN(Number(v));
    });

    if (!hasData) {
        track.innerHTML = '<div class="ticker-item ticker-loading"><span class="ticker-symbol">Waiting for market data...</span></div>';
        return;
    }

    // Build ticker items (render twice for seamless CSS scroll loop)
    function buildItems() {
        return tickerItems.map(t => {
            const raw = state.macroIndicators?.[t.key];
            const val = Number(raw);
            const prev = Number(state.previousMacro?.[t.key]);

            let priceStr, changeClass;
            if (raw == null || isNaN(val)) {
                priceStr = DASH;
                changeClass = '';
            } else {
                priceStr = `${t.prefix}${val.toFixed(t.decimals)}`;
                if (!isNaN(prev) && prev !== 0) {
                    changeClass = val > prev ? 'up' : val < prev ? 'down' : '';
                } else {
                    changeClass = '';
                }
            }

            // Also add top teas for a richer tape
            return `<div class="ticker-item">` +
                `<span class="ticker-flag">${t.flag}</span>` +
                `<span class="ticker-symbol">${t.label}</span>` +
                `<span class="ticker-price ${changeClass}">${priceStr}</span>` +
                `</div>`;
        }).join('');
    }

    // Also inject live tea prices into the tape
    function buildTeaItems() {
        if (!state.teas || state.teas.length === 0) return '';
        return state.teas.slice(0, 8).map(tea => {
            const price = tea.current_price || 0;
            const change = tea.price_change_24h || 0;
            const isUp = change >= 0;
            const symbol = tea.symbol || '';
            return `<div class="ticker-item ticker-tea">` +
                `<span class="ticker-symbol">${escapeHtml(symbol)}</span>` +
                `<span class="ticker-price">$${price.toFixed(2)}</span>` +
                `<span class="ticker-change ${isUp ? 'up' : 'down'}">${isUp ? '+' : ''}${change.toFixed(1)}%</span>` +
                `</div>`;
        }).join('');
    }

    const forexBlock = buildItems();
    const teaBlock = buildTeaItems();
    const separator = '<div class="ticker-separator">\u2502</div>';

    // Duplicate the whole set for seamless infinite scroll
    const onePass = forexBlock + separator + teaBlock;
    track.innerHTML = onePass + onePass;
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
            ? `<div class="quote-country" title="${country.label}"><span class="quote-country-flag">${country.flag}</span><span class="quote-country-code">${prefix}</span></div>`
            : '';

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

    const tea = state.teas.find(t => t.symbol === symbol);
    if (!tea) return;

    openQuickQuoteModal(tea);
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
