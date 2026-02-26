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

// Country prefix → flag emoji + display label
const COUNTRY_MAP = {
    KEN: { flag: '🇰🇪', label: 'Kenya'      },
    IND: { flag: '🇮🇳', label: 'India'      },
    SRI: { flag: '🇱🇰', label: 'Sri Lanka'  },
    MLW: { flag: '🇲🇼', label: 'Malawi'     },
    RWA: { flag: '🇷🇼', label: 'Rwanda'     },
    UGA: { flag: '🇺🇬', label: 'Uganda'     },
    TZA: { flag: '🇹🇿', label: 'Tanzania'   },
    VIE: { flag: '🇻🇳', label: 'Vietnam'    },
    JPN: { flag: '🇯🇵', label: 'Japan'      },
    BGD: { flag: '🇧🇩', label: 'Bangladesh' },
    IDN: { flag: '🇮🇩', label: 'Indonesia'  },
    KOL: { flag: '🇮🇳', label: 'Kolkata'    },
    GUW: { flag: '🇮🇳', label: 'Guwahati'   },
    JAL: { flag: '🇮🇳', label: 'Jalpaiguri' },
    COC: { flag: '🇮🇳', label: 'Cochin'     },
    CMB: { flag: '🇮🇳', label: 'Coimbatore' },
    SIL: { flag: '🇮🇳', label: 'Siliguri'   },
    COO: { flag: '🇮🇳', label: 'Coonoor'    },
};

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
    openHubForSymbol(symbol);
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
        { flag: '\uD83C\uDDF0\uD83C\uDDEA', label: 'KES',  key: 'usd_kes',     prefix: '',  decimals: 2 },
        { flag: '\uD83C\uDDEE\uD83C\uDDF3', label: 'INR',  key: 'usd_inr',     prefix: '',  decimals: 2 },
        { flag: '\uD83C\uDDF1\uD83C\uDDF0', label: 'LKR',  key: 'usd_lkr',     prefix: '',  decimals: 2 },
        { flag: '\uD83C\uDDE8\uD83C\uDDF3', label: 'CNY',  key: 'usd_cny',     prefix: '',  decimals: 4 },
        { flag: '\uD83D\uDEE2\uFE0F',       label: 'OIL',  key: 'brent_crude', prefix: '$', decimals: 2 }
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

            if (raw == null || isNaN(val)) {
                return `<div class="ticker-item">` +
                    `<span class="ticker-flag">${t.flag}</span>` +
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
                `<span class="ticker-flag">${t.flag}</span>` +
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
            ? `<div class="quote-country" title="${country.label}"><span class="quote-country-flag">${country.flag}</span><span class="quote-country-code">${prefix}</span></div>`
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

    // Keep body class for trade-bar visibility rules
    document.body.classList.remove(
        'mobile-section-markets',
        'mobile-section-chart',
        'mobile-section-portfolio',
        'mobile-section-account'
    );
    document.body.classList.add('mobile-section-' + section);

    // Toggle app-view active class
    const viewMap = {
        markets:   'view-markets',
        chart:     'view-chart',
        portfolio: 'view-portfolio',
        account:   'view-account'
    };
    document.querySelectorAll('.app-view').forEach(v => v.classList.remove('active'));
    const targetView = document.getElementById(viewMap[section]);
    if (targetView) targetView.classList.add('active');

    // Highlight nav button
    document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.section === section);
    });

    // On portfolio tab, ensure data is loaded
    if (section === 'portfolio') {
        const el = document.getElementById('portfolio-section');
        if (el) el.style.display = 'block';
        if (typeof loadUserTrades === 'function') loadUserTrades();
        if (typeof updatePortfolioDisplay === 'function') updatePortfolioDisplay();
    }

    // On account tab, sync profile data and chat
    if (section === 'account') {
        if (typeof updateMobileAccountSection === 'function') updateMobileAccountSection();
        syncAccountViewData();
        syncAccountChat();
    }

    // Resize chart when switching to chart tab
    if (section === 'chart') {
        if (typeof resizeCanvas === 'function') setTimeout(resizeCanvas, 50);
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

    let price = 0;
    let spread = 0.002;

    const select = document.getElementById('trade-tea-select');
    const selectValue = select?.value;

    if (selectValue) {
        if (selectValue.startsWith('INDEX_')) {
            const sym = selectValue.replace('INDEX_', '');
            const indexes = typeof calculateRegionalIndexes === 'function'
                ? calculateRegionalIndexes() : [];
            const idx = indexes.find(i => i.symbol === sym);
            price = idx?.price || 0;
        } else {
            const teaId = parseInt(selectValue);
            const tea = state.teas?.find(t => t.id === teaId);
            price = tea?.current_price || 0;
            const bs = Number(tea?.base_spread) || 0.01;
            const vm = Number(tea?.volatility_multiplier) || 1.0;
            spread = bs * vm;
        }
    }

    if (price > 0) {
        const askPrice = price * (1 + spread / 2);
        const bidPrice = price * (1 - spread / 2);
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
setInterval(updateMobileTradePrices, 1500);

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
        }
        return orig.apply(this, arguments);
    };
});

// =============================================
// ACCOUNT VIEW: Sync profile data
// =============================================

function syncAccountViewData() {
    const balEl = document.getElementById('account-view-balance');
    const eqEl = document.getElementById('account-view-equity');
    const pnlEl = document.getElementById('account-view-pnl');
    const userEl = document.getElementById('account-view-username');
    const avatarEl = document.getElementById('account-view-avatar');
    const modeEl = document.getElementById('account-view-mode');
    const logoutEl = document.getElementById('account-view-logout');

    const balance = typeof getActiveBalance === 'function' ? getActiveBalance() : 0;
    const fmt = (v) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    if (balEl) balEl.textContent = fmt(balance);

    const portfolioVal = document.getElementById('portfolio-value');
    if (eqEl && portfolioVal) eqEl.textContent = portfolioVal.textContent;

    const portfolioPnl = document.getElementById('portfolio-pnl');
    if (pnlEl && portfolioPnl) {
        pnlEl.textContent = portfolioPnl.textContent;
        pnlEl.className = 'account-stat-value ' + (portfolioPnl.classList.contains('down') ? 'down' : 'up');
    }

    if (state.currentUser) {
        const email = state.currentUser.email || '';
        const name = email.split('@')[0] || 'Trader';
        if (userEl) userEl.textContent = name;
        if (avatarEl) avatarEl.textContent = name.substring(0, 2).toUpperCase();
        if (logoutEl) logoutEl.style.display = '';
    } else {
        if (userEl) userEl.textContent = 'Guest';
        if (avatarEl) avatarEl.textContent = 'TT';
        if (logoutEl) logoutEl.style.display = 'none';
    }

    if (modeEl) {
        const mode = state.tradingMode || 'VIRTUAL';
        modeEl.textContent = mode;
        modeEl.style.background = mode === 'REAL' ? 'rgba(239,68,68,0.15)' : 'rgba(59,130,246,0.15)';
        modeEl.style.color = mode === 'REAL' ? '#f87171' : '#60a5fa';
    }
}

// =============================================
// ACCOUNT VIEW: Sync chat messages
// =============================================

function syncAccountChat() {
    const srcMessages = document.getElementById('chat-messages');
    const destMessages = document.getElementById('account-chat-messages');
    if (srcMessages && destMessages) {
        destMessages.innerHTML = srcMessages.innerHTML;
        destMessages.scrollTop = destMessages.scrollHeight;
    }

    const srcOnline = document.getElementById('chat-online-count');
    const destOnline = document.getElementById('account-chat-online');
    if (srcOnline && destOnline) destOnline.textContent = srcOnline.textContent;
}

document.addEventListener('DOMContentLoaded', function () {
    const sendBtn = document.getElementById('account-chat-send');
    const inputEl = document.getElementById('account-chat-input');
    if (!sendBtn || !inputEl) return;

    function sendFromAccountChat() {
        const text = inputEl.value.trim();
        if (!text) return;
        const mainInput = document.getElementById('chat-input');
        if (mainInput) {
            mainInput.value = text;
            if (typeof sendChatMessage === 'function') sendChatMessage();
        }
        inputEl.value = '';
        setTimeout(syncAccountChat, 300);
    }

    sendBtn.addEventListener('click', sendFromAccountChat);
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendFromAccountChat();
    });

    // Periodically sync chat when account tab is active
    setInterval(() => {
        if (_activeMobileSection === 'account') syncAccountChat();
    }, 2000);
});

// ========================================================
// FORCE NATIVE MOBILE APP ROUTING & TRADE SHEET
// ========================================================

window.switchMobileSection = function(section) {
    if (window.innerWidth > 768) return;

    // 1. Hide all views — class-only, never inline styles (preserves desktop display:contents)
    document.querySelectorAll('.app-view').forEach(v => {
        v.classList.remove('active');
        v.style.removeProperty('display');
    });

    // 2. Show requested view
    const targetView = document.getElementById('view-' + section);
    if (targetView) {
        targetView.classList.add('active');
    }

    // 3. Highlight bottom nav button
    document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.section === section);
    });

    // 4. Force chart resize if opening chart tab
    if (section === 'chart' && typeof resizeCanvas === 'function') {
        setTimeout(resizeCanvas, 100);
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

// Intercept asset clicks to auto-route to the Chart tab
const _originalOpenHub = window.openHubForSymbol;
window.openHubForSymbol = function(symbol) {
    if (window.innerWidth <= 768) {
        window.switchMobileSection('chart');
    }
    if (typeof _originalOpenHub === 'function') {
        return _originalOpenHub.apply(this, arguments);
    }
};

// Connect the Sticky Buy/Sell Buttons to the native Bottom Sheet
window.openMobileTradeSheet = function(side) {
    const overlay = document.getElementById('qq-mobile-trade-overlay');
    const form = document.getElementById('qq-mobile-trade-form');
    
    if (overlay && form) {
        overlay.classList.add('active');
        form.classList.add('active');
        
        // Ensure form knows which side was clicked
        if (typeof setQuickTradeType === 'function') {
            setQuickTradeType(side);
        }
        
        // Visually toggle the buttons
        const buyBtn = document.getElementById('qq-mobile-btn-buy');
        const sellBtn = document.getElementById('qq-mobile-btn-sell');
        if (side === 'BUY' && buyBtn) {
            buyBtn.classList.add('active');
            sellBtn?.classList.remove('active');
        } else if (side === 'SELL' && sellBtn) {
            sellBtn.classList.add('active');
            buyBtn?.classList.remove('active');
        }
    } else {
        console.error("Mobile trade sheet HTML elements not found!");
    }
};