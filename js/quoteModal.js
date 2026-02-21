/**
 * TeaTrade Exchange — Quick Quote Modal (quoteModal.js)
 * =====================================================
 * The popup trading view that opens when clicking a watchlist card or
 * quote board item.  Contains the QQ chart (line / candle with
 * SMA / EMA / Bollinger indicators), trade form (buy/sell with SL/TP),
 * market depth, open-position annotations, mobile trade sheet, and
 * symbol-switching dropdown.
 *
 * Globals used from config.js  : state, isIndexSymbol, getIndexSymbols
 * Globals used from api.js     : apiExecuteTrade, apiExecuteIndexTrade
 * Globals used from market.js  : getPriceHistorySync,
 *     calculateRegionalIndexes
 * Globals used from charts.js  : (none — indicators are computed inline)
 * Globals used from utils.js   : showToast, hashCode, closeAllDropdowns
 * Globals used from portfolio.js: loadUserTrades, updatePortfolioDisplay,
 *     getIndexPosition, updateIndexPosition
 * Globals used from auth.js    : openAuthModal
 */

// =============================================
// MODULE-LEVEL STATE (QQ-chart internal only)
// =============================================
let qqChartMeta = {
    data: [],
    padding: { top: 20, right: 70, bottom: 30, left: 60 },
    minPrice: 0,
    maxPrice: 0,
    chartWidth: 0,
    chartHeight: 0,
    w: 0,
    h: 0
};

// =============================================
// LIVE PRICE UPDATE (called from market.js ticker)
// =============================================

function updateQuickQuoteLivePrice() {
    const tea = state.qqCurrentTea;
    if (!tea) return;

    const fresh = (state.teaData || []).find(t => t.symbol === tea.symbol);
    if (fresh) {
        state.qqCurrentTea = { ...tea, ...fresh };
    }

    const price  = state.qqCurrentTea.current_price || 0;
    const change = state.qqCurrentTea.price_change_24h || 0;
    const isUp   = change >= 0;

    const priceEl  = document.getElementById('qq-price');
    const changeEl = document.getElementById('qq-change');
    if (priceEl)  priceEl.textContent  = `$${price.toFixed(2)}`;
    if (changeEl) changeEl.textContent = `${isUp ? '+' : ''}${change.toFixed(1)}%`;
    if (priceEl)  priceEl.className    = `quick-quote-current-price ${isUp ? 'up' : 'down'}`;
    if (changeEl) changeEl.className   = `quick-quote-change ${isUp ? 'up' : 'down'}`;

    const mobilePrice = document.getElementById('qq-mobile-price');
    if (mobilePrice) mobilePrice.value = price.toFixed(2);
}

// =============================================
// OPEN / CLOSE MODAL
// =============================================

function openQuickQuoteModal(tea) {
    closeAllDropdowns();
    state.qqCurrentTea = tea;
    const modal = document.getElementById('quick-quote-modal');
    if (!modal) return;

    const shortSymbol = tea.symbol.split('-')[1] || tea.symbol;
    const price = tea.current_price || 0;
    const change = tea.price_change_24h || 0;
    const isUp = change >= 0;
    const volume = tea.volume_24h || 0;

    // Reset modal state
    state.qqTimeframe = '1D';
    state.qqChartType = 'line';
    state.qqActiveIndicators = { sma: false, ema: false, bollinger: false };
    document.querySelectorAll('.qq-tf-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tf === '1D'));
    document.querySelectorAll('.qq-chart-type-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.type === 'line'));
    document.querySelectorAll('.qq-indicator-btn').forEach(btn => btn.classList.remove('active'));

    // Clear SL/TP inputs
    const slInput = document.getElementById('qq-sl');
    const tpInput = document.getElementById('qq-tp');
    if (slInput) slInput.value = '';
    if (tpInput) tpInput.value = '';

    // Populate header
    document.getElementById('qq-symbol').textContent = shortSymbol;
    document.getElementById('qq-name').textContent = tea.name;

    const priceEl = document.getElementById('qq-price');
    priceEl.textContent = `$${price.toFixed(2)}`;
    priceEl.className = `quick-quote-current-price ${isUp ? 'up' : 'down'}`;

    const changeEl = document.getElementById('qq-change');
    changeEl.textContent = `${isUp ? '+' : ''}${change.toFixed(1)}%`;
    changeEl.className = `quick-quote-change ${isUp ? 'up' : 'down'}`;

    // Invalidate cache and force a fresh fetch for this tea's / index's data
    const openSymbolType = (tea.isIndex || isIndexSymbol(tea.symbol)) ? 'index' : 'tea';
    if (state.priceDataCache) {
        delete state.priceDataCache.lastUpdate[tea.symbol];
        delete state.priceDataCache.lastUpdate[`INDEX_${tea.symbol}`];
    }
    // Trigger async re-fetch; redraw QQ chart when data arrives
    getPriceHistory(tea.symbol, openSymbolType).then(data => {
        if (data && data.length > 0 && state.qqCurrentTea?.symbol === tea.symbol) {
            drawQuickQuoteChart(state.qqCurrentTea);
        }
    }).catch(() => {});

    // Get whatever is currently cached (may be stale — async fetch above will update)
    const history = getPriceHistorySync(tea.symbol, openSymbolType);
    const last24h = history.length >= 24 ? history.slice(-24) : history;

    let high24h = price * 1.04;
    let low24h  = price * 0.96;
    let avg24h  = price;
    let totalVolume = 0;

    if (last24h.length > 0) {
        high24h     = Math.max(...last24h.map(d => d.high));
        low24h      = Math.min(...last24h.map(d => d.low));
        avg24h      = last24h.reduce((sum, d) => sum + d.close, 0) / last24h.length;
        totalVolume = last24h.reduce((sum, d) => sum + d.volume, 0);
    }

    document.getElementById('qq-high').textContent   = `$${high24h.toFixed(2)}`;
    document.getElementById('qq-low').textContent    = `$${low24h.toFixed(2)}`;
    document.getElementById('qq-volume').textContent = totalVolume >= 1000000
        ? `${Math.round(totalVolume / 1000000)}M`
        : totalVolume >= 1000
            ? `${Math.round(totalVolume / 1000)}K`
            : totalVolume.toString();
    document.getElementById('qq-avg').textContent    = `$${avg24h.toFixed(2)}`;

    // Set trade price & qty, then refresh the full summary
    document.getElementById('qq-qty').value = 100;

    // Update mobile trade bar price
    const mobilePriceEl = document.getElementById('qq-mobile-trade-price');
    if (mobilePriceEl) mobilePriceEl.textContent = `$${price.toFixed(2)}`;
    const mobileLabelEl = document.getElementById('qq-mobile-trade-label');
    if (mobileLabelEl) mobileLabelEl.textContent = tea.name || tea.symbol;

    // Reset trade type to BUY, then refresh the full summary (price, margin, balance)
    setQuickTradeType('BUY');
    updateQuickTradeSummary();

    // Update trade icon (leaf for teas, globe for indexes)
    updateQQTradeIcon(tea);

    // Update market depth & extra stats
    updateQQMarketDepth(tea);

    // Update open positions display
    updateQQOpenPositions(tea.symbol);

    // Show modal FIRST so canvas has dimensions
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    // Draw the chart AFTER modal is visible (needs a small delay for layout)
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            drawQuickQuoteChart(tea);
            updateQQTradeAnnotations();
        });
    });
}

function closeQuickQuoteModal() {
    const modal = document.getElementById('quick-quote-modal');
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }
    closeMobileQQTradeForm();
}

// =============================================
// MOBILE QUICK QUOTE TRADE FORM
// =============================================

function toggleMobileQQTradeForm() {
    const form = document.getElementById('qq-mobile-trade-form');
    const overlay = document.getElementById('qq-mobile-trade-overlay');
    if (!form || !overlay) return;

    if (form.classList.contains('active')) {
        closeMobileQQTradeForm();
        return;
    }

    // Sync data from main modal
    if (state.qqCurrentTea) {
        const price = state.qqCurrentTea.current_price || 0;
        document.getElementById('qq-mobile-form-title').textContent = `Trade ${state.qqCurrentTea.name || state.qqCurrentTea.symbol}`;
        document.getElementById('qq-mobile-price').value = price.toFixed(2);
        document.getElementById('qq-mobile-qty').value = document.getElementById('qq-qty')?.value || 100;

        const balance = getActiveBalance() || 10000;
        document.getElementById('qq-mobile-balance').textContent = `$${balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

        // Sync BUY/SELL state
        const mobileBuyBtn  = document.getElementById('qq-mobile-btn-buy');
        const mobileSellBtn = document.getElementById('qq-mobile-btn-sell');
        if (mobileBuyBtn)  mobileBuyBtn.classList.toggle('active', state.qqTradeType === 'BUY');
        if (mobileSellBtn) mobileSellBtn.classList.toggle('active', state.qqTradeType === 'SELL');

        updateMobileQQSummary();
    }

    form.classList.add('active');
    overlay.classList.add('active');
}

function closeMobileQQTradeForm() {
    const form    = document.getElementById('qq-mobile-trade-form');
    const overlay = document.getElementById('qq-mobile-trade-overlay');
    if (form)    form.classList.remove('active');
    if (overlay) overlay.classList.remove('active');
}

function updateMobileQQSummary() {
    const qty   = parseFloat(document.getElementById('qq-mobile-qty')?.value) || 0;
    const price = parseFloat(document.getElementById('qq-mobile-price')?.value) || 0;
    const total = qty * price;

    const valueEl = document.getElementById('qq-mobile-order-value');
    if (valueEl) valueEl.textContent = `$${total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

    const execBtn = document.getElementById('qq-mobile-execute-btn');
    if (execBtn) {
        execBtn.textContent = `${state.qqTradeType} ${qty} kg`;
        execBtn.className   = `quick-trade-execute ${state.qqTradeType.toLowerCase()}`;
        execBtn.style.width     = '100%';
        execBtn.style.marginTop = '14px';
        execBtn.style.textAlign = 'center';
    }
}

function executeMobileQQTrade() {
    const qty = document.getElementById('qq-mobile-qty')?.value;
    const sl  = document.getElementById('qq-mobile-sl')?.value;
    const tp  = document.getElementById('qq-mobile-tp')?.value;

    if (qty) document.getElementById('qq-qty').value = qty;
    const slEl = document.getElementById('qq-sl');
    const tpEl = document.getElementById('qq-tp');
    if (sl && slEl) slEl.value = sl;
    if (tp && tpEl) tpEl.value = tp;

    updateQuickTradeSummary();
    executeQuickTrade();
    closeMobileQQTradeForm();
}

// =============================================
// QQ SYMBOL DROPDOWN
// =============================================

function toggleQQSymbolDropdown(e) {
    if (window.innerWidth > 768) return; // Only on mobile
    e.stopPropagation();
    const dropdown = document.getElementById('qq-symbol-dropdown');
    const list     = document.getElementById('qq-symbol-list');
    if (!dropdown || !list) return;

    const isOpen = list.classList.contains('show');
    if (isOpen) {
        list.classList.remove('show');
        dropdown.classList.remove('open');
        return;
    }

    // Build categorized list: Teas by origin + Indexes
    let html = '';

    // Group teas by origin
    const origins = {};
    state.teas.forEach(t => {
        const origin = t.origin || t.symbol.split('-')[0] || 'Other';
        const label  = state.originNames[origin] || origin;
        if (!origins[label]) origins[label] = [];
        origins[label].push(t);
    });

    // Teas section
    html += '<div class="qq-symbol-category">Teas</div>';
    Object.keys(origins).forEach(origin => {
        html += `<div class="qq-symbol-subcategory">${escapeHtml(origin)}</div>`;
        origins[origin].forEach(t => {
            const sym    = t.symbol.split('-')[1] || t.symbol;
            const price  = t.current_price || 0;
            const change = t.price_change_24h || 0;
            const isUp   = change >= 0;
            const isActive = state.qqCurrentTea && state.qqCurrentTea.id === t.id;
            html += `<div class="qq-symbol-item${isActive ? ' active' : ''}" onclick="event.stopPropagation(); selectQQSymbol('${escapeHtml(t.symbol)}', false)">
                <span class="qq-symbol-item-left"><span class="qq-si-dot tea"></span>${escapeHtml(sym)} <span class="qq-si-name">\u2014 ${escapeHtml(t.name)}</span></span>
                <span class="qq-symbol-item-price ${isUp ? 'up' : 'down'}">$${price.toFixed(2)}</span>
            </div>`;
        });
    });

    // Indexes section
    const indexes = calculateRegionalIndexes();
    if (indexes.length > 0) {
        html += '<div class="qq-symbol-category">Indexes</div>';
        indexes.forEach(idx => {
            const isUp     = (idx.change || 0) >= 0;
            const isActive = state.qqCurrentTea && state.qqCurrentTea.symbol === idx.symbol;
            html += `<div class="qq-symbol-item${isActive ? ' active' : ''}" onclick="event.stopPropagation(); selectQQSymbol('${escapeHtml(idx.symbol)}', true)">
                <span class="qq-symbol-item-left"><span class="qq-si-dot index"></span>${escapeHtml(idx.symbol)} <span class="qq-si-name">\u2014 ${escapeHtml(idx.name)}</span></span>
                <span class="qq-symbol-item-price ${isUp ? 'up' : 'down'}">$${idx.price.toFixed(2)}</span>
            </div>`;
        });
    }

    list.innerHTML = html;
    list.classList.add('show');
    dropdown.classList.add('open');
}

function selectQQSymbol(symbol, isIndex) {
    const list     = document.getElementById('qq-symbol-list');
    const dropdown = document.getElementById('qq-symbol-dropdown');
    if (list)     list.classList.remove('show');
    if (dropdown) dropdown.classList.remove('open');

    openHubForSymbol(symbol);
}

// Close dropdown on outside click
document.addEventListener('click', function (e) {
    const dropdown = document.getElementById('qq-symbol-dropdown');
    const list     = document.getElementById('qq-symbol-list');
    if (dropdown && list && !dropdown.contains(e.target)) {
        list.classList.remove('show');
        dropdown.classList.remove('open');
    }
});

// =============================================
// QQ TRADE ICON (leaf / globe)
// =============================================

function updateQQTradeIcon(tea) {
    const iconCircle = document.getElementById('qq-trade-icon-circle');
    const leafIcon   = document.getElementById('qq-icon-leaf');
    const globeIcon  = document.getElementById('qq-icon-globe');
    const symbolDot  = document.getElementById('qq-symbol-dot');
    if (!iconCircle || !leafIcon || !globeIcon) return;

    const isIndex = tea.isIndex || isIndexSymbol(tea.symbol);

    if (isIndex) {
        leafIcon.style.display  = 'none';
        globeIcon.style.display = 'block';
        iconCircle.classList.add('index');
        if (symbolDot) symbolDot.classList.add('index');
    } else {
        leafIcon.style.display  = 'block';
        globeIcon.style.display = 'none';
        iconCircle.classList.remove('index');
        if (symbolDot) symbolDot.classList.remove('index');
    }
}

// =============================================
// PRICE ALERT
// =============================================

function openQQPriceAlert() {
    if (!state.qqCurrentTea) return;
    const price  = state.qqCurrentTea.current_price || 0;
    const symbol = state.qqCurrentTea.symbol.split('-')[1] || state.qqCurrentTea.symbol;
    const target = prompt(
        `Set price alert for ${symbol}\nCurrent: $${price.toFixed(2)}\n\nAlert when price reaches:`,
        price.toFixed(2)
    );
    if (target !== null && !isNaN(parseFloat(target))) {
        const alertPrice = parseFloat(target);
        const direction  = alertPrice > price ? 'above' : 'below';
        showToast('Price Alert Set', `${symbol} ${direction} $${alertPrice.toFixed(2)}`);
    }
}

// =============================================
// QQ MARKET DEPTH & EXTRA STATS
// =============================================

function updateQQMarketDepth(tea) {
    const depthEl = document.getElementById('qq-market-depth');
    const extraEl = document.getElementById('qq-extra-stats');
    if (!depthEl || !extraEl) return;

    const price = tea.current_price || 0;
    const sym   = tea.symbol || '';

    // ── Real order-flow from market_pressure ────────────────────────────
    const mp = state.marketPressure || {};
    const pressure = mp[sym] || null;
    let bidVol = 0, askVol = 0, usingLiveFlow = false;

    if (pressure && (pressure.buy5m > 0 || pressure.sell5m > 0)) {
        bidVol = pressure.buy5m;
        askVol = pressure.sell5m;
        usingLiveFlow = true;
    } else if (pressure && (pressure.buy30m > 0 || pressure.sell30m > 0)) {
        bidVol = pressure.buy30m;
        askVol = pressure.sell30m;
        usingLiveFlow = true;
    }

    let bidPct, askPct;
    if (usingLiveFlow && (bidVol + askVol) > 0) {
        bidPct = (bidVol / (bidVol + askVol)) * 100;
        askPct = 100 - bidPct;
    } else {
        bidPct = 50; askPct = 50;
        bidVol = 0;  askVol = 0;
    }
    bidPct = Math.max(5, Math.min(95, bidPct));
    askPct = 100 - bidPct;

    // Calculate bid/ask spread from real volume imbalance
    const spreadPct = usingLiveFlow ? 0.002 + (1 - Math.min(bidVol + askVol, 10000) / 10000) * 0.013 : 0.005;
    const spread    = price * spreadPct;
    const bidPrice  = price - spread / 2;
    const askPrice  = price + spread / 2;

    // Volatility (from history if available)
    const history = getPriceHistorySync(tea.symbol, 'tea');
    const last24h = history.length >= 24 ? history.slice(-24) : history;
    let volatility = 0;
    if (last24h.length > 1) {
        const returns = [];
        for (let i = 1; i < last24h.length; i++) {
            returns.push((last24h[i].close - last24h[i - 1].close) / last24h[i - 1].close);
        }
        const mean     = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
        volatility = Math.sqrt(variance) * Math.sqrt(252) * 100; // Annualized
    }

    // Open price & prev close
    const openPrice = last24h.length > 0 ? last24h[0].open : price * 0.99;
    const prevClose = last24h.length > 1 ? last24h[last24h.length - 2]?.close || price * 0.995 : price * 0.995;

    // Update depth bar
    const bidsBar = document.getElementById('qq-depth-bids');
    const asksBar = document.getElementById('qq-depth-asks');
    if (bidsBar) {
        bidsBar.style.width = `${bidPct.toFixed(0)}%`;
        bidsBar.querySelector('.qq-depth-label').textContent = `BIDS ${bidPct.toFixed(0)}%`;
    }
    if (asksBar) {
        asksBar.style.width = `${askPct.toFixed(0)}%`;
        asksBar.querySelector('.qq-depth-label').textContent = `ASKS ${askPct.toFixed(0)}%`;
    }

    const ratioEl  = document.getElementById('qq-depth-ratio');
    if (ratioEl) ratioEl.textContent = `Bid/Ask: ${(bidPct / askPct).toFixed(2)}`;

    const bidVolEl = document.getElementById('qq-depth-bid-vol');
    const askVolEl = document.getElementById('qq-depth-ask-vol');
    const midEl    = document.getElementById('qq-depth-mid');
    if (bidVolEl) bidVolEl.textContent = `Vol: ${bidVol.toLocaleString()} kg`;
    if (askVolEl) askVolEl.textContent = `Vol: ${askVol.toLocaleString()} kg`;
    if (midEl)    midEl.textContent    = `Mid: $${price.toFixed(2)}`;

    // Update extra stats
    document.getElementById('qq-spread').textContent     = `$${spread.toFixed(4)}`;
    document.getElementById('qq-volatility').textContent  = `${volatility.toFixed(1)}%`;
    document.getElementById('qq-bid-price').textContent   = `$${bidPrice.toFixed(2)}`;
    document.getElementById('qq-ask-price').textContent   = `$${askPrice.toFixed(2)}`;
    document.getElementById('qq-open-price').textContent  = `$${openPrice.toFixed(2)}`;
    document.getElementById('qq-prev-close').textContent  = `$${prevClose.toFixed(2)}`;
}

// =============================================
// QQ TRADE TYPE / SUMMARY
// =============================================

function setQuickTradeType(type) {
    state.qqTradeType = type;

    const buyBtn  = document.getElementById('qq-btn-buy');
    const sellBtn = document.getElementById('qq-btn-sell');
    const execBtn = document.getElementById('qq-execute-btn');

    buyBtn.classList.toggle('active', type === 'BUY');
    sellBtn.classList.toggle('active', type === 'SELL');

    execBtn.className = `quick-trade-execute ${type.toLowerCase()}`;

    // Update mobile sticky bar button color
    const mobileTradeBtn = document.getElementById('qq-mobile-trade-btn');
    if (mobileTradeBtn) {
        mobileTradeBtn.className = `qq-mobile-trade-btn ${type.toLowerCase()}`;
    }

    // Update mobile form execute button color
    const mobileExecBtn = document.getElementById('qq-mobile-execute-btn');
    if (mobileExecBtn) {
        mobileExecBtn.className   = `quick-trade-execute ${type.toLowerCase()}`;
        mobileExecBtn.style.width     = '100%';
        mobileExecBtn.style.marginTop = '14px';
    }

    updateQuickTradeSummary();
}

function updateQuickTradeSummary() {
    const qty = parseFloat(document.getElementById('qq-qty')?.value) || 0;
    const leverage = parseFloat(document.getElementById('qq-leverage')?.value) || 10;
    const SPREAD_PCT = 0.01;

    const tea = state.qqCurrentTea;
    let marketPrice = 0;
    if (tea) {
        if (tea.isIndex || isIndexSymbol(tea.symbol)) {
            const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
            const idx = indexes.find(i => i.symbol === tea.symbol);
            marketPrice = idx?.price || tea.current_price || 0;
        } else {
            const liveTea = state.teas?.find(t => t.symbol === tea.symbol);
            marketPrice = liveTea?.current_price || tea.current_price || 0;
        }
    }

    const isBuy = state.qqTradeType === 'BUY';
    const execPrice = isBuy ? marketPrice * (1 + SPREAD_PCT / 2) : marketPrice * (1 - SPREAD_PCT / 2);
    const notional = execPrice * qty;
    const margin = notional / leverage;
    const spreadCost = Math.abs(execPrice - marketPrice) * qty;
    const balance = getActiveBalance() || 10000;

    const _fmt = (v) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const mktEl = document.getElementById('qq-market-price');
    if (mktEl) mktEl.textContent = `$${marketPrice.toFixed(2)}/kg`;

    const priceEl = document.getElementById('qq-trade-price');
    if (priceEl) priceEl.textContent = `$${execPrice.toFixed(3)}/kg`;

    const labelEl = document.getElementById('qq-exec-price-label');
    if (labelEl) labelEl.innerHTML = isBuy
        ? 'Your Price <small style="color:var(--text-muted)">(+0.5% spread)</small>'
        : 'Your Price <small style="color:var(--text-muted)">(-0.5% spread)</small>';

    const orderEl = document.getElementById('qq-order-value');
    if (orderEl) orderEl.textContent = _fmt(notional);

    const marginEl = document.getElementById('qq-margin-required');
    if (marginEl) marginEl.textContent = _fmt(margin);

    const spreadEl = document.getElementById('qq-spread-cost');
    if (spreadEl) spreadEl.textContent = _fmt(spreadCost);

    const balEl = document.getElementById('qq-balance');
    if (balEl) balEl.textContent = _fmt(balance);

    const execBtn = document.getElementById('qq-execute-btn');
    if (execBtn) {
        execBtn.textContent = qty > 0
            ? `${state.qqTradeType} ${qty.toLocaleString()} kg — ${_fmt(margin)}`
            : `${state.qqTradeType} 0 kg`;
    }
}

// =============================================
// QQ CHART CONTROLS
// =============================================

function setQQTimeframe(tf) {
    state.qqTimeframe = tf;
    document.querySelectorAll('.qq-tf-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tf === tf);
    });
    if (state.qqCurrentTea) {
        const tea        = state.qqCurrentTea;
        const isIndex    = tea.isIndex || isIndexSymbol(tea.symbol);
        const symbolType = isIndex ? 'index' : 'tea';

        // QQ timeframe → TIMEFRAME_CONFIG key used by loadChartDataFromHistory.
        // 1H and 1D both use the '1D' config (5-min candles); drawQuickQuoteChart
        // then slices to 60 pts (1H) or 96 pts (1D) from the same dataset.
        const qqToMainTf = { '1H': '1D', '1D': '1D', '1W': '1W', '1M': '1M' };
        const fetchTf    = qqToMainTf[tf] || '1D';

        // Snapshot for closure guards — avoids applying a stale fetch if the
        // user rapidly clicks through timeframes or closes the modal.
        const snapshotSymbol = tea.symbol;
        const snapshotTf     = tf;

        // Draw immediately with whatever is cached so the modal doesn't blank out
        drawQuickQuoteChart(tea);

        // Fetch directly from DB using the correct timeframe config. This bypasses
        // getPriceHistory's shared loading-promise cache so rapid clicks each get
        // their own independent DB query rather than sharing a stale in-flight one.
        loadChartDataFromHistory(tea.symbol, symbolType, fetchTf)
            .then(data => {
                if (!data || data.length === 0) return;
                // Discard if the user changed timeframe or closed the modal
                if (state.qqTimeframe !== snapshotTf) return;
                if (state.qqCurrentTea?.symbol !== snapshotSymbol) return;

                // Populate the shared cache so live-tick updates append to it
                const cacheKey = symbolType === 'index'
                    ? `INDEX_${tea.symbol}` : tea.symbol;
                if (state.priceDataCache) {
                    state.priceDataCache.data[cacheKey]       = data;
                    state.priceDataCache.lastUpdate[cacheKey] = Date.now();
                    state.priceDataCache.loaded[cacheKey]     = true;
                    delete state.priceDataCache.loading[cacheKey];
                }

                drawQuickQuoteChart(state.qqCurrentTea);
            })
            .catch(() => {});
    }
}

function setQQChartType(type) {
    state.qqChartType = type;
    document.querySelectorAll('.qq-chart-type-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.type === type);
    });
    if (state.qqCurrentTea) {
        drawQuickQuoteChart(state.qqCurrentTea);
    }
}

function toggleQQIndicator(ind) {
    state.qqActiveIndicators[ind] = !state.qqActiveIndicators[ind];
    document.querySelectorAll('.qq-indicator-btn').forEach(btn => {
        if (btn.dataset.ind === ind) {
            btn.classList.toggle('active', state.qqActiveIndicators[ind]);
        }
    });
    if (state.qqCurrentTea) {
        drawQuickQuoteChart(state.qqCurrentTea);
    }
}

// =============================================
// QQ OPEN POSITIONS DISPLAY
// =============================================

function updateQQOpenPositions(symbol) {
    const container = document.getElementById('qq-open-positions');
    if (!container) return;

    // Match positions by symbol via joined teas data, or for indexes by direct symbol check
    const matchingPositions = (state.positions || []).filter(p => {
        const teaSymbol = p.teas?.symbol || '';
        return teaSymbol === symbol;
    });

    if (matchingPositions.length === 0) {
        container.classList.remove('has-positions');
        container.innerHTML = '';
        return;
    }

    container.classList.add('has-positions');

    const currentPrice = state.qqCurrentTea?.current_price || 0;

    let html = '<div class="qq-positions-header">Your Open Positions</div>';
    matchingPositions.forEach(pos => {
        const entryPrice = pos.avg_entry_price || 0;
        const qty   = pos.quantity;
        const pnl   = (currentPrice - entryPrice) * qty;
        const pnlClass = pnl >= 0 ? 'profit' : 'loss';
        const pnlSign  = pnl >= 0 ? '+' : '';

        html += `
            <div class="qq-position-row">
                <div class="qq-position-info">
                    <span class="qq-position-side buy">BUY</span>
                    <div class="qq-position-details">
                        <span class="qq-position-qty">${qty} kg</span>
                        <span class="qq-position-entry">@ $${entryPrice.toFixed(2)}</span>
                    </div>
                </div>
                <span class="qq-position-pnl ${pnlClass}">${pnlSign}$${pnl.toFixed(2)}</span>
            </div>
        `;
    });

    container.innerHTML = html;
}

// =============================================
// QQ TRADE ANNOTATIONS (chart overlay)
// =============================================

function updateQQTradeAnnotations() {
    const container = document.getElementById('qq-trade-annotations');
    if (!container || !state.qqCurrentTea || !qqChartMeta.maxPrice) return;

    const matchingPositions = (state.positions || []).filter(p => {
        const teaSymbol = p.teas?.symbol || '';
        return teaSymbol === state.qqCurrentTea.symbol;
    });

    if (matchingPositions.length === 0) {
        container.innerHTML = '';
        return;
    }

    const { minPrice, maxPrice, chartHeight, padding } = qqChartMeta;
    const priceRange = maxPrice - minPrice;

    let html = '';
    matchingPositions.forEach(pos => {
        const entryPrice = pos.avg_entry_price || 0;
        const yEntry = padding.top + ((maxPrice - entryPrice) / priceRange) * chartHeight;

        if (yEntry >= padding.top && yEntry <= padding.top + chartHeight) {
            html += `<div class="qq-trade-annotation entry" style="top: ${yEntry - 10}px;">Entry $${entryPrice.toFixed(2)}</div>`;
        }

        // SL / TP annotations if set
        if (pos.stop_loss) {
            const ySL = padding.top + ((maxPrice - pos.stop_loss) / priceRange) * chartHeight;
            if (ySL >= padding.top && ySL <= padding.top + chartHeight) {
                html += `<div class="qq-trade-annotation sl" style="top: ${ySL - 10}px;">SL $${pos.stop_loss.toFixed(2)}</div>`;
            }
        }

        if (pos.take_profit) {
            const yTP = padding.top + ((maxPrice - pos.take_profit) / priceRange) * chartHeight;
            if (yTP >= padding.top && yTP <= padding.top + chartHeight) {
                html += `<div class="qq-trade-annotation tp" style="top: ${yTP - 10}px;">TP $${pos.take_profit.toFixed(2)}</div>`;
            }
        }
    });

    container.innerHTML = html;
}

// =============================================
// ANIMATE PRICE CHANGE
// =============================================

function animateQQPriceChange(newPrice, oldPrice) {
    const priceEl = document.getElementById('qq-price');
    if (!priceEl) return;

    const isUp = newPrice > oldPrice;
    priceEl.classList.remove('qq-price-flash', 'qq-price-up', 'qq-price-down');

    // Force reflow
    void priceEl.offsetWidth;

    priceEl.classList.add('qq-price-flash');
    priceEl.classList.add(isUp ? 'qq-price-up' : 'qq-price-down');

    setTimeout(() => {
        priceEl.classList.remove('qq-price-flash', 'qq-price-up', 'qq-price-down');
    }, 500);
}

// =============================================
// DRAW QUICK QUOTE CHART
// =============================================

function drawQuickQuoteChart(tea) {
    const canvas = document.getElementById('qq-chart');
    if (!canvas || !tea) return;

    const ctx  = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    // High DPI support
    const dpr = window.devicePixelRatio || 1;
    const w   = rect.width;
    const h   = rect.height;

    canvas.width  = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width  = w + 'px';
    canvas.style.height = h + 'px';
    ctx.scale(dpr, dpr);

    const price  = tea.current_price || 3.5;
    const change = tea.price_change_24h || 0;
    const isUp   = change >= 0;

    // Get historical data from unified cache (database-backed)
    const qqSymbolType = (tea.isIndex || isIndexSymbol(tea.symbol)) ? 'index' : 'tea';
    let fullHistory = getPriceHistorySync(tea.symbol, qqSymbolType);
    if (!fullHistory || fullHistory.length === 0) {
        // Trigger an async fetch and redraw when it arrives
        getPriceHistory(tea.symbol, qqSymbolType).then(data => {
            if (data && data.length > 0 && state.qqCurrentTea?.symbol === tea.symbol) {
                drawQuickQuoteChart(state.qqCurrentTea);
            }
        }).catch(() => {});
        return;
    }

    // Data from the cache is already at the correct candle interval for
    // the active timeframe (set by TIMEFRAME_CONFIG in market.js).
    // Just slice the most recent N candles plus warm-up for indicators.
    const warmupPeriod = 25;
    // 1H: 60 ticks = up to 5h of 5-min candles so the chart always has enough
    // data to display even if the edge function hasn't been very active today.
    const qqPointsMap = { '1H': 60, '1D': 288, '1W': 168, '1M': 180 };
    const maxPoints = (qqPointsMap[state.qqTimeframe] || 96) + warmupPeriod;
    let historySlice = fullHistory.slice(-maxPoints);
    if (historySlice.length === 0) historySlice = fullHistory.slice(-50);

    const padding     = { top: 20, right: 70, bottom: 30, left: 60 };
    const chartWidth  = w - padding.left - padding.right;
    const chartHeight = h - padding.top - padding.bottom;

    const allHighs = historySlice.map(d => Number(d.high) || 0).filter(p => p > 0);
    const allLows  = historySlice.map(d => Number(d.low) || 0).filter(p => p > 0);
    if (allHighs.length === 0 || allLows.length === 0) return;
    const minPrice = Math.min(...allLows)  * 0.998;
    const maxPrice = Math.max(...allHighs) * 1.002;

    // Store metadata for crosshair and annotations
    qqChartMeta = { data: historySlice, padding, minPrice, maxPrice, chartWidth, chartHeight, w, h };

    // Clear
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(0, 0, w, h);

    // Draw grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padding.top + (chartHeight / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(w - padding.right, y);
        ctx.stroke();

        const priceLabel = maxPrice - ((maxPrice - minPrice) / 4) * i;
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font      = '10px JetBrains Mono';
        ctx.textAlign  = 'right';
        const _qqCurr = state.qqCurrentTea?.currency || '$';
        ctx.fillText(`${_qqCurr}${priceLabel >= 100 ? priceLabel.toFixed(1) : priceLabel.toFixed(2)}`, padding.left - 8, y + 3);
    }

    // Draw time labels
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font      = '9px JetBrains Mono';
    ctx.textAlign  = 'center';
    const timeLabels = [0, Math.floor(historySlice.length / 4), Math.floor(historySlice.length / 2), Math.floor(3 * historySlice.length / 4), historySlice.length - 1];
    timeLabels.forEach(i => {
        if (historySlice[i]) {
            const x    = padding.left + (i / (historySlice.length - 1)) * chartWidth;
            const date = historySlice[i].date;
            let label;
            if (state.qqTimeframe === '1H') {
                label = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            } else if (state.qqTimeframe === '1D') {
                label = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            } else if (state.qqTimeframe === '1W') {
                label = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
            } else {
                label = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
            }
            ctx.fillText(label, x, h - 8);
        }
    });

    // Calculate indicators if enabled
    const closes = historySlice.map(d => d.close);

    // Draw Bollinger Bands first (behind everything)
    if (state.qqActiveIndicators.bollinger && closes.length >= 20) {
        const period = 20;
        const mult   = 2;

        const upper = [], lower = [], middle = [];
        for (let i = period - 1; i < closes.length; i++) {
            const slice    = closes.slice(i - period + 1, i + 1);
            const sma      = slice.reduce((a, b) => a + b, 0) / period;
            const variance = slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
            const stdDev   = Math.sqrt(variance);
            upper.push(sma + mult * stdDev);
            lower.push(sma - mult * stdDev);
            middle.push(sma);
        }

        // Draw bands with fill
        ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
        ctx.beginPath();
        for (let i = 0; i < upper.length; i++) {
            const x = padding.left + ((i + period - 1) / (historySlice.length - 1)) * chartWidth;
            const y = padding.top + ((maxPrice - upper[i]) / (maxPrice - minPrice)) * chartHeight;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        for (let i = lower.length - 1; i >= 0; i--) {
            const x = padding.left + ((i + period - 1) / (historySlice.length - 1)) * chartWidth;
            const y = padding.top + ((maxPrice - lower[i]) / (maxPrice - minPrice)) * chartHeight;
            ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();

        // Draw middle line
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.7)';
        ctx.lineWidth = 1;
        middle.forEach((val, i) => {
            const x = padding.left + ((i + period - 1) / (historySlice.length - 1)) * chartWidth;
            const y = padding.top + ((maxPrice - val) / (maxPrice - minPrice)) * chartHeight;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
    }

    // Draw chart based on type
    if (state.qqChartType === 'candle') {
        const candleWidth = Math.max(3, Math.min(10, (chartWidth / historySlice.length) * 0.7));

        historySlice.forEach((candle, i) => {
            const x        = padding.left + (i / (historySlice.length - 1)) * chartWidth;
            const candleUp = candle.close >= candle.open;
            const color    = candleUp ? '#10b981' : '#ef4444';

            const openY  = padding.top + ((maxPrice - candle.open)  / (maxPrice - minPrice)) * chartHeight;
            const closeY = padding.top + ((maxPrice - candle.close) / (maxPrice - minPrice)) * chartHeight;
            const highY  = padding.top + ((maxPrice - candle.high)  / (maxPrice - minPrice)) * chartHeight;
            const lowY   = padding.top + ((maxPrice - candle.low)   / (maxPrice - minPrice)) * chartHeight;

            // Wick
            ctx.beginPath();
            ctx.moveTo(x, highY);
            ctx.lineTo(x, lowY);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.stroke();

            // Body
            const bodyTop    = Math.min(openY, closeY);
            const bodyHeight = Math.max(1, Math.abs(closeY - openY));
            ctx.fillStyle = color;
            ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
        });
    } else {
        // Line chart with gradient fill
        const gradient = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom);
        gradient.addColorStop(0, isUp ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)');
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');

        ctx.beginPath();
        ctx.moveTo(padding.left, h - padding.bottom);

        historySlice.forEach((candle, i) => {
            const x = padding.left + (i / (historySlice.length - 1)) * chartWidth;
            const y = padding.top + ((maxPrice - candle.close) / (maxPrice - minPrice)) * chartHeight;
            ctx.lineTo(x, y);
        });

        ctx.lineTo(padding.left + chartWidth, h - padding.bottom);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        // Draw line
        ctx.beginPath();
        historySlice.forEach((candle, i) => {
            const x = padding.left + (i / (historySlice.length - 1)) * chartWidth;
            const y = padding.top + ((maxPrice - candle.close) / (maxPrice - minPrice)) * chartHeight;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = isUp ? '#10b981' : '#ef4444';
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    // Draw SMA if enabled
    if (state.qqActiveIndicators.sma && closes.length >= 10) {
        const sma10 = [];
        for (let i = 9; i < closes.length; i++) {
            const avg = closes.slice(i - 9, i + 1).reduce((a, b) => a + b, 0) / 10;
            sma10.push(avg);
        }

        ctx.beginPath();
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth   = 1.5;
        sma10.forEach((val, i) => {
            const x = padding.left + ((i + 9) / (historySlice.length - 1)) * chartWidth;
            const y = padding.top + ((maxPrice - val) / (maxPrice - minPrice)) * chartHeight;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
    }

    // Draw EMA if enabled
    if (state.qqActiveIndicators.ema && closes.length >= 10) {
        const multiplier = 2 / (10 + 1);
        const ema = [closes[0]];
        for (let i = 1; i < closes.length; i++) {
            ema.push((closes[i] - ema[i - 1]) * multiplier + ema[i - 1]);
        }

        ctx.beginPath();
        ctx.strokeStyle = '#8b5cf6';
        ctx.lineWidth   = 1.5;
        ema.forEach((val, i) => {
            const x = padding.left + (i / (historySlice.length - 1)) * chartWidth;
            const y = padding.top + ((maxPrice - val) / (maxPrice - minPrice)) * chartHeight;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
    }

    // Draw current price line
    const currentY = padding.top + ((maxPrice - price) / (maxPrice - minPrice)) * chartHeight;
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.moveTo(padding.left, currentY);
    ctx.lineTo(w - padding.right, currentY);
    ctx.strokeStyle = isUp ? '#10b981' : '#ef4444';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // Current price label
    ctx.fillStyle = isUp ? '#10b981' : '#ef4444';
    ctx.fillRect(w - padding.right + 2, currentY - 8, 55, 16);
    ctx.fillStyle = '#fff';
    ctx.font      = 'bold 10px JetBrains Mono';
    ctx.textAlign  = 'left';
    const _qqCurr2 = state.qqCurrentTea?.currency || '$';
    ctx.fillText(`${_qqCurr2}${price >= 100 ? price.toFixed(1) : price.toFixed(2)}`, w - padding.right + 6, currentY + 3);

    // Update trade annotations after chart is drawn
    updateQQTradeAnnotations();

    // Setup crosshair events (once)
    if (!canvas.dataset.crosshairSetup) {
        canvas.dataset.crosshairSetup = 'true';
        setupQQChartCrosshair(canvas);
    }
}

// =============================================
// QQ CHART CROSSHAIR
// =============================================

function setupQQChartCrosshair(canvas) {
    const crosshair = document.getElementById('qq-crosshair');
    const tooltip   = document.getElementById('qq-tooltip');
    if (!crosshair || !tooltip) return;

    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const { data, padding, minPrice, maxPrice, chartWidth, chartHeight, w, h } = qqChartMeta;
        if (!data || data.length === 0) return;

        // Check if within chart area
        if (x < padding.left || x > w - padding.right || y < padding.top || y > h - padding.bottom) {
            crosshair.style.display = 'none';
            tooltip.style.display   = 'none';
            return;
        }

        // Find nearest candle
        const normalizedX = (x - padding.left) / chartWidth;
        const candleIndex = Math.round(normalizedX * (data.length - 1));
        const candle = data[Math.max(0, Math.min(data.length - 1, candleIndex))];
        if (!candle || !candle.date) return;

        // Calculate candle X position
        const candleX = padding.left + (candleIndex / (data.length - 1)) * chartWidth;

        // Show crosshair
        crosshair.style.display = 'block';
        crosshair.querySelector('.qq-crosshair-v').style.left = candleX + 'px';
        crosshair.querySelector('.qq-crosshair-h').style.top  = y + 'px';

        // Format tooltip (safe against NaN/undefined)
        const cOpen = Number(candle.open) || 0;
        const cHigh = Number(candle.high) || 0;
        const cLow = Number(candle.low) || 0;
        const cClose = Number(candle.close) || 0;
        const candleUp = cClose >= cOpen;
        const changePercent = cOpen > 0 ? ((cClose - cOpen) / cOpen * 100).toFixed(2) : '0.00';
        const timeStr = candle.date.toLocaleString('en-GB', {
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit'
        });

        tooltip.innerHTML = `
            <div class="qq-tooltip-row">
                <span class="qq-tooltip-label">Time</span>
                <span class="qq-tooltip-value">${timeStr}</span>
            </div>
            <div class="qq-tooltip-row">
                <span class="qq-tooltip-label">Open</span>
                <span class="qq-tooltip-value">$${cOpen.toFixed(2)}</span>
            </div>
            <div class="qq-tooltip-row">
                <span class="qq-tooltip-label">High</span>
                <span class="qq-tooltip-value">$${cHigh.toFixed(2)}</span>
            </div>
            <div class="qq-tooltip-row">
                <span class="qq-tooltip-label">Low</span>
                <span class="qq-tooltip-value">$${cLow.toFixed(2)}</span>
            </div>
            <div class="qq-tooltip-row">
                <span class="qq-tooltip-label">Close</span>
                <span class="qq-tooltip-value ${candleUp ? 'up' : 'down'}">$${cClose.toFixed(2)}</span>
            </div>
            <div class="qq-tooltip-row">
                <span class="qq-tooltip-label">Change</span>
                <span class="qq-tooltip-value ${candleUp ? 'up' : 'down'}">${candleUp ? '+' : ''}${changePercent}%</span>
            </div>
        `;

        // Position tooltip
        tooltip.style.display = 'block';
        let tooltipX = candleX + 15;
        let tooltipY = y - 60;

        // Keep tooltip in bounds
        if (tooltipX + 150 > w) tooltipX = candleX - 165;
        if (tooltipY < 10)      tooltipY = y + 15;

        tooltip.style.left = tooltipX + 'px';
        tooltip.style.top  = tooltipY + 'px';
    });

    canvas.addEventListener('mouseleave', () => {
        crosshair.style.display = 'none';
        tooltip.style.display   = 'none';
    });
}

// =============================================
// EXECUTE QUICK TRADE
// =============================================

async function executeQuickTrade() {
    if (!state.currentUser) {
        closeQuickQuoteModal();
        openAuthModal();
        return;
    }

    if (!state.qqCurrentTea) return;

    const qty          = parseFloat(document.getElementById('qq-qty').value) || 0;
    const isIndexTrade = !!state.qqCurrentTea.isIndex;

    // For index trades, recalculate the price live from calculateRegionalIndexes()
    // so it always matches the server's reference price. For tea trades the server
    // determines execution price independently, so we pass current_price as reference.
    let price = state.qqCurrentTea.current_price;
    if (isIndexTrade && typeof calculateRegionalIndexes === 'function') {
        const indexes  = calculateRegionalIndexes();
        const liveIdx  = indexes.find(i => i.symbol === state.qqCurrentTea.symbol);
        if (liveIdx?.price > 0) price = liveIdx.price;
    }

    const total      = qty * price;
    const slInput    = document.getElementById('qq-sl');
    const tpInput    = document.getElementById('qq-tp');
    const stopLoss   = slInput?.value ? parseFloat(slInput.value) : null;
    const takeProfit = tpInput?.value ? parseFloat(tpInput.value) : null;

    if (qty <= 0) {
        showToast('Invalid quantity', 'Please enter a valid quantity', true);
        return;
    }

    const qqLeverage = parseFloat(document.getElementById('qq-leverage')?.value) || 10;
    const SPREAD_PCT = 0.01;
    const isBuy = state.qqTradeType === 'BUY';
    const execPrice = isBuy ? price * (1 + SPREAD_PCT / 2) : price * (1 - SPREAD_PCT / 2);
    const notional = execPrice * qty;
    const qqMarginReq = notional / qqLeverage;
    if (qqMarginReq > getActiveBalance()) {
        showToast('Insufficient Margin', `Need $${qqMarginReq.toFixed(2)} (have $${getActiveBalance().toFixed(2)})`, true);
        return;
    }

    const execBtn = document.getElementById('qq-execute-btn');
    execBtn.disabled    = true;
    execBtn.textContent = 'Executing...';

    try {
        const productName = state.qqCurrentTea.name || state.qqCurrentTea.symbol;

        if (isIndexTrade) {
            // === INDEX TRADE (C4 FIX: server-side) ===
            const indexSymbol = state.qqCurrentTea.symbol;

            const result = await apiExecuteIndexTrade(indexSymbol, state.qqTradeType, qty, price, qqLeverage);
            if (!result.success) {
                throw new Error(result.error || 'Index trade failed');
            }

            setActiveBalance(result.new_balance);
            await loadIndexPositions();

        } else {
            // === TEA TRADE (server-side atomic) ===
            const result = await apiExecuteTrade(state.qqCurrentTea.symbol, state.qqTradeType, qty, qqLeverage);
            if (!result.success) {
                throw new Error(result.error || 'Trade failed');
            }

            setActiveBalance(result.new_balance);
            await loadPositions();
        }

        // Refresh trades and UI
        await loadUserTrades();
        updatePortfolioDisplay();
        updateUIForLoggedInUser();

        showToast(`${state.qqTradeType} Order Filled`, `${qty} kg of ${productName} @ $${execPrice.toFixed(3)} (${qqLeverage}x leverage)`);
        closeQuickQuoteModal();

    } catch (error) {
        console.error('Trade error:', error);
        showToast('Trade Failed', error.message || 'Failed to execute trade', true);
        execBtn.disabled    = false;
        updateQuickTradeSummary();
    }
}

// =============================================
// KEYBOARD / OVERLAY CLOSE LISTENERS
// =============================================

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeQuickQuoteModal();
    }
});

document.getElementById('quick-quote-modal')?.addEventListener('click', (e) => {
    if (e.target.classList.contains('quick-quote-modal-overlay')) {
        closeQuickQuoteModal();
    }
});
