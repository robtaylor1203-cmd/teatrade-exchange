/**
 * TeaTrade Exchange - Trading Hub Module (hub.js)
 * ================================================
 * Maximize / fullscreen trading view: hub chart, controls, trade execution,
 * RSI resizer, crosshair tooltip, and simulated trade log.
 *
 * Globals used (from config.js):
 *   state, supabaseClient, isIndexSymbol, getIndexSymbols, studyColors, timeframeConfig
 *
 * Functions used from other modules:
 *   api.js       – apiExecuteTrade, apiExecuteIndexTrade, apiFetchIndexPositions
 *   market.js    – calculateRegionalIndexes, getPriceHistory, getPriceHistorySync
 *   charts.js    – drawChart, resizeCanvas, setTimeframe
 *   utils.js     – showToast, formatVolume, closeAllDropdowns, formatIndexPrice
 *   portfolio.js – loadPositions, loadIndexPositions, getIndexPosition,
 *                  updateIndexPosition, loadUserTrades
 *   ui.js        – populateHubTeaSelects
 */

// Module-local (non-state) helpers
let tradingHubChart = null;
let isResizingRsi = false;
let tradeLogEntries = [];

// TradingView hub chart state
let _hubTvChart = null;
let _hubMainSeries = null;
let _hubVolumeSeries = null;
let _hubStudySeries = {}; // keyed by study name
let _hubTvRsiChart = null;
let _hubTvRsiSeries = null;

/**
 * Resolve the currency symbol and forex multiplier for the hub chart's
 * currently selected instrument.
 * Checks both the hub dropdown value and the originating market card data,
 * because the dropdown maps display symbols (COLOMBO) → tradable (CEYLON).
 */
function _getHubCurrencyInfo() {
    const raw = document.getElementById('hub-buy-symbol')?.value || '';
    const _cardMap = { 'KENYAN': 'KENYA' };

    const tradeSym = _cardMap[raw] || raw;
    const cardIdx = _findIndexDef(tradeSym);
    if (cardIdx?.forexKey && state.macroIndicators?.[cardIdx.forexKey]) {
        return { symbol: cardIdx.currency || '$', multiplier: Number(state.macroIndicators[cardIdx.forexKey]) || cardIdx.multiplier || 1 };
    }
    if (cardIdx?.currency && cardIdx.currency !== '$') {
        return { symbol: cardIdx.currency, multiplier: cardIdx.multiplier || 1 };
    }
    return { symbol: '$', multiplier: 1 };
}

function _hubFmtPrice(val) {
    const ci = _getHubCurrencyInfo();
    if (val >= 1000) return ci.symbol + val.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    if (val >= 100) return ci.symbol + val.toFixed(1);
    return ci.symbol + val.toFixed(2);
}

/**
 * Like _getHubCurrencyInfo but for any given trading symbol,
 * not just the dropdown. Used by order preview, position display, trade tape.
 */
function _getHubCurrencyInfoForSymbol(sym) {
    if (!sym) return { symbol: '$', multiplier: 1 };
    const idx = _findIndexDef(sym);
    if (idx?.forexKey && state.macroIndicators?.[idx.forexKey]) {
        return { symbol: idx.currency || '$', multiplier: Number(state.macroIndicators[idx.forexKey]) || idx.multiplier || 1 };
    }
    if (idx?.currency && idx.currency !== '$') {
        return { symbol: idx.currency, multiplier: idx.multiplier || 1 };
    }
    return { symbol: '$', multiplier: 1 };
}

// =============================================
// OPEN HUB FOR A SPECIFIC SYMBOL
// =============================================

function openHubForSymbol(teaOrSymbol) {
    let symbol, name, price, isIndex, currency, forexKey;

    if (typeof teaOrSymbol === 'string') {
        symbol = teaOrSymbol;
        const tea = state.teas?.find(t => t.symbol === symbol);
        if (tea) {
            name = tea.name || symbol;
            price = tea.current_price;
            isIndex = false;
        } else {
            const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
            const idx = indexes.find(i => i.symbol === symbol);
            if (idx) {
                name = idx.name;
                price = idx.price;
                isIndex = true;
            } else {
                return;
            }
        }
    } else {
        const tea = teaOrSymbol;
        symbol = tea.symbol;
        name = tea.name || symbol;
        price = tea.current_price || 0;
        isIndex = !!tea.isIndex || isIndexSymbol(symbol);
    }

    currency = typeof getCurrencyForSymbol === 'function' ? getCurrencyForSymbol(symbol) : '$';
    
    // Borrow forex config from the market card if the index itself lacks it
    const cardSym = (typeof _TRADE_TO_CARD !== 'undefined' && _TRADE_TO_CARD[symbol]) ? _TRADE_TO_CARD[symbol] : symbol;
    const dbIdx = state.dbIndexes?.find(i => i.symbol === cardSym) || state.dbIndexes?.find(i => i.symbol === symbol);
    forexKey = dbIdx?.forexKey || null;
    const multiplier = dbIdx?.multiplier || 1;

    state.mainChartData = {
        name: name,
        symbol: symbol,
        basePrice: price,
        currency: currency,
        forexKey: forexKey,
        multiplier: multiplier,
        change: 0,
        isIndex: isIndex,
        isTea: !isIndex
    };
    if (typeof updateMobileTradePrices === 'function') updateMobileTradePrices();

    // Invalidate price cache for this symbol so the hub chart loads fresh
    // data from DB rather than serving stale entries from a previous session.
    if (state.priceDataCache) {
        const _base = isIndex ? `INDEX_${symbol}` : symbol;
        Object.keys(state.priceDataCache.data || {}).forEach(k => {
            if (k === _base || k.startsWith(_base + '_')) {
                delete state.priceDataCache.data[k];
                delete state.priceDataCache.lastUpdate[k];
                delete state.priceDataCache.loaded[k];
            }
        });
    }

    // Clear main chart data so it doesn't flash stale data from previous symbol
    state.chartData = [];
    state.cachedTimeframe = null;
    if (window.mainYAxisCache) window.mainYAxisCache = {};

    const titleEl = document.getElementById('main-chart-title');
    if (titleEl) titleEl.textContent = name;

    const panel = document.getElementById('chart-section');
    if (!panel) return;

    if (window.innerWidth <= 768) {
        initTradingHub();
        if (typeof drawChart === 'function') {
            setTimeout(drawChart, 100);
            setTimeout(drawChart, 300);
        }
        return;
    }

    if (!panel.classList.contains('panel-maximized')) {
        toggleMaximize('chart-section');
    } else {
        initTradingHub();
    }
}

// =============================================
// MAXIMIZE FUNCTIONS
// =============================================

function toggleMaximize(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;

    if (panel.classList.contains('panel-maximized')) {
        // Restore
        panel.classList.remove('panel-maximized');
        document.body.classList.remove('modal-open');
        document.body.style.overflow = '';
        state.maximizedPanel = null;
    } else {
        // Maximize
        if (state.maximizedPanel) {
            state.maximizedPanel.classList.remove('panel-maximized');
        }
        panel.classList.add('panel-maximized');
        document.body.classList.add('modal-open');
        document.body.style.overflow = 'hidden';
        state.maximizedPanel = panel;

        // Initialize trading hub
        if (panelId === 'chart-section') {
            initTradingHub();
        }
    }

    // Mobile rotate prompt management
    if (typeof _mobileChartFullscreenWatch === 'function') _mobileChartFullscreenWatch();

    // Trigger resize for chart redraw with increased delays for layout computation
    setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
        drawChart();
    }, 100);

    if (panelId === 'chart-section' && panel.classList.contains('panel-maximized')) {
        // Multiple redraws to ensure canvas is properly sized after layout
        setTimeout(drawHubChart, 150);
        setTimeout(drawHubChart, 300);
        setTimeout(drawHubChart, 500);
    }
}

// =============================================
// TRADING HUB FUNCTIONS
// =============================================

function initTradingHub() {
    // Refresh tea prices from DB immediately on hub open so that
    // constituent-price calculations are as fresh as possible and
    // avoid the ">10% deviation" rejection on first trade.
    if (typeof loadTeas === 'function') {
        loadTeas().then(() => {
            if (typeof updateAllMarketIndexes === 'function') updateAllMarketIndexes();
            updateHubOrderPreview();
        }).catch(() => { });
    }

    // Load index positions from localStorage
    if (typeof loadIndexPositions === 'function') {
        loadIndexPositions();
    }

    // Pre-populate with current chart symbol (keep indexes as-is, they are tradable)
    let currentSymbol = state.mainChartData?.symbol || '';

    const cardToIndex = { 'KENYAN': 'KENYA' };
    if (cardToIndex[currentSymbol]) currentSymbol = cardToIndex[currentSymbol];

    const buySelect = document.getElementById('hub-buy-symbol');
    const sellSelect = document.getElementById('hub-sell-symbol');

    // Ensure selects are populated first
    populateHubTeaSelects();

    // Set selects to current symbol - try exact match first, then fallback
    if (buySelect && buySelect.options.length > 0) {
        let matched = false;
        for (let opt of buySelect.options) {
            if (opt.value === currentSymbol) {
                buySelect.value = currentSymbol;
                matched = true;
                break;
            }
        }
        // If no match, default to first tea option (skip optgroup)
        if (!matched) {
            for (let opt of buySelect.options) {
                if (opt.value) {
                    buySelect.value = opt.value;
                    break;
                }
            }
        }
    }
    if (sellSelect && sellSelect.options.length > 0) {
        let matched = false;
        for (let opt of sellSelect.options) {
            if (opt.value === currentSymbol) {
                sellSelect.value = currentSymbol;
                matched = true;
                break;
            }
        }
        if (!matched) {
            for (let opt of sellSelect.options) {
                if (opt.value) {
                    sellSelect.value = opt.value;
                    break;
                }
            }
        }
    }

    // Regenerate hub chart data: use sync cache for immediate render,
    // then force an async DB reload to ensure fresh, correct data.
    state.hubChartData = generateHubChartData();

    // Async reload: fetch fresh data from DB for the selected symbol.
    // This overwrites any stale/mismatched cache entries and redraws.
    const _hubSym = document.getElementById('hub-buy-symbol')?.value || '';
    const _hubLookup = _hubSym === 'KENYAN' ? 'KENYA' : _hubSym;
    const _hubIsIdx = typeof isIndexSymbol === 'function' && isIndexSymbol(_hubLookup);
    const _hubSymType = _hubIsIdx ? 'index' : 'tea';
    loadChartDataFromHistory(_hubLookup, _hubSymType).then(freshData => {
        if (!freshData || freshData.length === 0) return;
        const nowSym = document.getElementById('hub-buy-symbol')?.value || '';
        if (nowSym !== _hubSym) return;
        state.hubChartData = freshData;
        drawHubChart();
    }).catch(() => { });

    // Update hub title to match main chart
    const hubTitle = document.getElementById('hub-chart-title');
    if (hubTitle && state.mainChartData?.name) {
        hubTitle.textContent = state.mainChartData.name;
    }

    // Sync studies and settings (use defaults if not set)
    state.hubStudies = { sma10: false, sma20: false, bollinger: false, rsi: false };
    state.hubChartType = state.chartType || 'line';
    state.hubTimeframe = state.currentTimeframe || '1W';

    // Update hub UI to match main chart
    updateHubStudyToggles();
    document.getElementById('hub-timeframe-label').textContent = state.hubTimeframe;

    // Update hub chart type buttons
    document.getElementById('hub-btn-line')?.classList.toggle('active', state.hubChartType === 'line');
    document.getElementById('hub-btn-candle')?.classList.toggle('active', state.hubChartType === 'candle');

    // Update price display
    updateHubPriceDisplay();

    // Update position info
    updateHubPositionInfo();

    // Update market depth for the hub
    if (typeof updateMarketDepth === 'function') updateMarketDepth();

    // Initialize RSI section visibility
    const rsiSection = document.getElementById('hub-rsi-section');
    if (state.hubStudies.rsi) {
        rsiSection.classList.add('visible');
    } else {
        rsiSection.classList.remove('visible');
    }

    // Setup RSI resize handle
    setupRsiResizer();

    // Start trade log simulation
    startTradeLogSimulation();

    // Force canvas wrapper to have explicit dimensions
    const canvasWrapper = document.getElementById('hub-canvas-wrapper');
    const chartArea = document.querySelector('.trading-hub-chart-area');
    if (canvasWrapper && chartArea) {
        // Force a reflow by reading dimensions
        void chartArea.offsetHeight;
        void canvasWrapper.offsetHeight;

        // Calculate available height for the chart
        const viewportHeight = window.innerHeight;
        const logHeight = 160;
        const padding = 100;
        const availableHeight = viewportHeight - logHeight - padding;

        // Set explicit dimensions
        canvasWrapper.style.height = Math.max(300, availableHeight) + 'px';
        canvasWrapper.style.width = '100%';
    }

    // Setup resize observer for the chart canvas
    if (canvasWrapper && typeof ResizeObserver !== 'undefined') {
        const resizeObserver = new ResizeObserver(() => {
            if (state.maximizedPanel?.classList.contains('panel-maximized')) {
                requestAnimationFrame(drawHubChart);
            }
        });
        resizeObserver.observe(canvasWrapper);
    }

    // Draw hub chart with TradingView — destroys and recreates the instance
    // to ensure a clean slate any time the hub opens for a new symbol.
    _destroyHubTvChart();
    drawHubChart();

    // Setup hub chart crosshair and tooltip events
    setupHubChartCrosshair();
}

// =============================================
// HUB CHART CROSSHAIR
// =============================================

function setupHubChartCrosshair() {
    // TradingView provides native crosshair — no manual canvas events needed.
    // This function is intentionally a no-op kept for call-site compatibility.
}

function hubChartMouseMove() {}
function hubChartMouseLeave() {}

// =============================================
// HUB CHART DATA
// =============================================

async function loadOrGenerateHubChartData(symbol) {
    const lookupSymbol = symbol === 'KENYAN' ? 'KENYA' : symbol;
    const isIndex = isIndexSymbol(lookupSymbol);
    const symbolType = isIndex ? 'index' : 'tea';

    // Get from unified cache (which loads from DB first)
    const data = await getPriceHistory(lookupSymbol, symbolType);
    return data;
}

function generateInitialChartData(symbol) {
    const lookupSymbol = symbol === 'KENYAN' ? 'KENYA' : symbol;
    const isIndex = isIndexSymbol(lookupSymbol);
    const symbolType = isIndex ? 'index' : 'tea';

    // Get from unified cache (sync version for immediate rendering)
    let data = getPriceHistorySync(lookupSymbol, symbolType);

    // Fallback to generation if cache is empty.
    // IMPORTANT: all values MUST be in raw USD — the chart renderer applies
    // the forex multiplier at draw-time.
    if (!data || data.length === 0) {
        let currentPrice;
        if (isIndex) {
            // Use raw USD average (same source as _liveIndexPrice)
            currentPrice = (typeof _liveIndexPrice === 'function')
                ? _liveIndexPrice(lookupSymbol) : null;
            if (!currentPrice || currentPrice <= 0) {
                currentPrice = 3.50;
            }
        } else {
            const tea = state.teas?.find(t => t.symbol === symbol);
            currentPrice = tea?.current_price || 3.50;
        }

        data = [];
        let price = currentPrice;
        const now = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;

        const seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
        const seededRandom = (i) => {
            const x = Math.sin(seed + i * 9999) * 10000;
            return x - Math.floor(x);
        };

        for (let i = 100; i >= 0; i--) {
            const volatility = 0.02;
            const change = (seededRandom(i) - 0.5) * volatility;
            price = price * (1 + change);
            price = Math.max(currentPrice * 0.7, Math.min(currentPrice * 1.3, price));

            const open = price;
            const high = price * (1 + seededRandom(i + 1000) * 0.01);
            const low = price * (1 - seededRandom(i + 2000) * 0.01);
            const close = i === 0 ? currentPrice : low + seededRandom(i + 3000) * (high - low);

            data.push({
                date: new Date(now - (i * dayMs)),
                open: open,
                high: high,
                low: low,
                close: close,
                volume: Math.floor(seededRandom(i + 4000) * 100000) + 10000
            });

            price = close;
        }

        // Store in cache but with lastUpdate=0 so getPriceHistory still
        // triggers a DB load to replace this synthetic data with real data.
        const _tf = state.currentTimeframe || '1D';
        const cacheKey = (symbolType === 'index' ? `INDEX_${lookupSymbol}` : lookupSymbol) + `_${_tf}`;
        state.priceDataCache.data[cacheKey] = data;
        state.priceDataCache.lastUpdate[cacheKey] = 0;
    }

    return data;
}

function generateHubChartData() {
    const symbol = document.getElementById('hub-buy-symbol')?.value || 'KENYA';

    const lookupSymbol = symbol === 'KENYAN' ? 'KENYA' : symbol;
    const isIndex = isIndexSymbol(lookupSymbol);
    const symbolType = isIndex ? 'index' : 'tea';

    let data = getPriceHistorySync(lookupSymbol, symbolType);

    if (!data || data.length === 0) {
        data = generateInitialChartData(symbol);
    }

    return data;
}

// =============================================
// HUB PRICE / STUDY / POSITION DISPLAY
// =============================================

function updateHubPriceDisplay() {
    if (!state.hubChartData || state.hubChartData.length === 0) return;

    const ci = _getHubCurrencyInfo();
    let m = ci.multiplier || 1;

    // Sanity guard: skip multiplier if data is already in local currency
    if (m > 1) {
        const _rawCloses = state.hubChartData.map(d => Number(d.close) || 0).filter(p => p > 0).sort((a, b) => a - b);
        const _rawMedian = _rawCloses.length > 0 ? _rawCloses[Math.floor(_rawCloses.length / 2)] : 0;
        if (_rawMedian > 50) m = 1;
    }

    const lastPrice = state.hubChartData[state.hubChartData.length - 1].close * m;
    const firstPrice = state.hubChartData[0].close * m;
    const change = firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;

    const priceEl = document.getElementById('hub-chart-price');
    const changeEl = document.getElementById('hub-chart-change');

    if (priceEl) {
        priceEl.textContent = _hubFmtPrice(lastPrice);
        priceEl.className = 'trading-hub-price ' + (change >= 0 ? 'up' : 'down');
    }

    if (changeEl) {
        changeEl.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
        changeEl.className = 'trading-hub-change ' + (change >= 0 ? 'up' : 'down');
    }
}

/**
 * Sync the hub chart to whichever symbol is selected in the trade dropdown.
 * Called when the user changes the BUY or SELL instrument.
 */
function syncHubChartToTradeSymbol(selectId) {
    const rawSym = document.getElementById(selectId || 'hub-buy-symbol')?.value || '';
    if (!rawSym) return;

    const lookupSymbol = rawSym === 'KENYAN' ? 'KENYA' : rawSym;
    const isIdx = typeof isIndexSymbol === 'function' && isIndexSymbol(lookupSymbol);

    const tea = !isIdx ? state.teas?.find(t => t.symbol === rawSym) : null;
    const dbIdx = _findIndexDef(lookupSymbol);
    const cardSym = (typeof _TRADE_TO_CARD !== 'undefined' && _TRADE_TO_CARD[lookupSymbol]) ? _TRADE_TO_CARD[lookupSymbol] : lookupSymbol;
    const fxIdx = _findIndexDef(cardSym) || dbIdx;
    
    const name = tea
        ? (tea.name || rawSym)
        : (dbIdx?.name || lookupSymbol + ' Index');
    const currency = typeof getCurrencyForSymbol === 'function' ? getCurrencyForSymbol(lookupSymbol) : '$';
    const forexKey = fxIdx?.forexKey || null;
    const multiplier = fxIdx?.multiplier || 1;

    let price;
    if (tea) {
        price = tea.current_price || 0;
    } else {
        const rawUsd = _liveIndexPrice(lookupSymbol) || 0;
        const fxRate = (forexKey && state.macroIndicators?.[forexKey])
            ? Number(state.macroIndicators[forexKey])
            : multiplier;
        price = rawUsd * fxRate;
    }

    state.mainChartData = {
        name, symbol: lookupSymbol, basePrice: price,
        currency, forexKey, multiplier, change: 0,
        isIndex: isIdx, isTea: !isIdx
    };
    if (typeof updateMobileTradePrices === 'function') updateMobileTradePrices();

    // Update hub title
    const hubTitle = document.getElementById('hub-chart-title');
    if (hubTitle) hubTitle.textContent = name;

    // Update main chart title & price so both views stay in sync
    const titleEl = document.getElementById('main-chart-title');
    if (titleEl) titleEl.textContent = name;
    const priceEl = document.getElementById('main-chart-price');
    if (priceEl) {
        priceEl.textContent = formatIndexPrice(price, currency, lookupSymbol);
        priceEl.className = 'chart-stat-value up';
    }

    // Invalidate cache for fresh load (all timeframes)
    if (state.priceDataCache) {
        const _base = isIdx ? `INDEX_${lookupSymbol}` : lookupSymbol;
        Object.keys(state.priceDataCache.data || {}).forEach(k => {
            if (k === _base || k.startsWith(_base + '_')) {
                delete state.priceDataCache.data[k];
                delete state.priceDataCache.lastUpdate[k];
                delete state.priceDataCache.loaded[k];
            }
        });
    }

    // Reset main chart state so drawChart() regenerates from the new symbol
    state.chartData = [];
    state.cachedTimeframe = null;
    if (window.mainYAxisCache) window.mainYAxisCache = {};

    // Redraw both canvases immediately (sync data, possibly empty placeholder)
    drawChart();
    state.hubChartData = generateHubChartData();
    drawHubChart();

    // Async: load fresh data from DB, then redraw both charts
    const _symType = isIdx ? 'index' : 'tea';
    loadChartDataFromHistory(lookupSymbol, _symType).then(freshData => {
        if (!freshData || freshData.length === 0) return;
        const nowSym = document.getElementById(selectId || 'hub-buy-symbol')?.value || '';
        if (nowSym !== rawSym) return;
        state.hubChartData = freshData;
        state.chartData = [];
        state.cachedTimeframe = null;
        updateHubPriceDisplay();
        drawChart();
        drawHubChart();
        if (typeof updateMarketDepth === 'function') updateMarketDepth();
    }).catch(() => { });
}

/**
 * Sync the main chart to the trade-tea-select dropdown on the main page.
 * Values are numeric tea IDs (e.g. "3") or "INDEX_KENYA".
 */
function syncChartToTradeSelect(passedVal) {
    let val = passedVal;

    // If no argument provided, fallback to the desktop dropdown value
    if (!val) {
        const select = document.getElementById('trade-tea-select');
        val = select?.value;
    }

    if (!val) return;

    let symbol, name, price, isIdx, currency, forexKey, multiplier = 1;

    if (val.startsWith('INDEX_')) {
        symbol = val.replace('INDEX_', '');
        isIdx = true;
        
        const dbIdx = _findIndexDef(symbol);
        const cardSym = (typeof _TRADE_TO_CARD !== 'undefined' && _TRADE_TO_CARD[symbol]) ? _TRADE_TO_CARD[symbol] : symbol;
        const fxIdx = _findIndexDef(cardSym) || dbIdx;
        
        name = dbIdx?.name || symbol + ' Index';
        const rawUsd = _liveIndexPrice(symbol) || 0;
        currency = typeof getCurrencyForSymbol === 'function' ? getCurrencyForSymbol(symbol) : '$';
        forexKey = fxIdx?.forexKey || null;
        multiplier = fxIdx?.multiplier || 1;
        const fxRate = (forexKey && state.macroIndicators?.[forexKey])
            ? Number(state.macroIndicators[forexKey])
            : multiplier;
        price = rawUsd * fxRate;
    } else {
        const tea = state.teas?.find(t => String(t.id) === val);
        if (!tea) return;
        symbol = tea.symbol;
        isIdx = false;
        name = tea.name || symbol;
        price = tea.current_price || 0;
        currency = '$';
        forexKey = null;
    }

    state.mainChartData = {
        name, symbol, basePrice: price,
        currency, forexKey, multiplier, change: 0,
        isIndex: isIdx, isTea: !isIdx
    };
    if (typeof updateMobileTradePrices === 'function') updateMobileTradePrices();

    const titleEl = document.getElementById('main-chart-title');
    if (titleEl) titleEl.textContent = name;
    const priceEl = document.getElementById('main-chart-price');
    if (priceEl) {
        priceEl.textContent = formatIndexPrice(price, currency, symbol);
        priceEl.className = 'chart-stat-value up';
    }

    if (state.priceDataCache) {
        const _base = isIdx ? `INDEX_${symbol}` : symbol;
        Object.keys(state.priceDataCache.data || {}).forEach(k => {
            if (k === _base || k.startsWith(_base + '_')) {
                delete state.priceDataCache.data[k];
                delete state.priceDataCache.lastUpdate[k];
                delete state.priceDataCache.loaded[k];
            }
        });
    }

    state.chartData = [];
    state.cachedTimeframe = null;
    if (window.mainYAxisCache) window.mainYAxisCache = {};

    drawChart();
}

function updateHubStudyToggles() {
    Object.keys(state.hubStudies).forEach(study => {
        const toggle = document.getElementById(`hub-toggle-${study}`);
        if (toggle) {
            toggle.classList.toggle('active', state.hubStudies[study]);
        }
    });
}

function updateHubPositionInfo() {
    // Get current selected symbol
    const symbol = document.getElementById('hub-buy-symbol')?.value || '';

    // Check if this is an index
    const lookupSymbol = symbol === 'KENYAN' ? 'KENYA' : symbol;
    const isIndex = isIndexSymbol(lookupSymbol);

    let position = null;
    let currentPrice = 0;

    if (isIndex) {
        // For indexes, use Supabase-backed index positions
        const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
        const index = indexes.find(idx => idx.symbol === lookupSymbol);

        if (index) {
            currentPrice = index.price || 0;

            // Get index position from Supabase (loaded into memory)
            const indexPos = typeof getIndexPosition === 'function' ? getIndexPosition(lookupSymbol) : null;
            if (indexPos && indexPos.quantity > 0) {
                position = {
                    quantity: indexPos.quantity,
                    avg_entry_price: indexPos.avg_entry_price
                };
            }
        }
    } else {
        // For teas, find direct position
        const tea = state.teas?.find(t => t.symbol === symbol);
        if (tea) {
            position = state.positions?.find(p => p.tea_id === tea.id);
            currentPrice = tea.current_price || 0;
        }
    }

    const qtyEl = document.getElementById('hub-position-qty');
    const entryEl = document.getElementById('hub-position-entry');
    const pnlEl = document.getElementById('hub-position-pnl');

    // Only show entry price on chart if selected symbol matches the chart symbol
    const chartSymbol = state.mainChartData?.symbol || '';
    const normalizedChartSymbol = chartSymbol === 'KENYAN' ? 'KENYA' : chartSymbol;
    const normalizedSelectedSymbol = symbol === 'KENYAN' ? 'KENYA' : symbol;
    const symbolMatchesChart = normalizedSelectedSymbol === normalizedChartSymbol;

    // Store entry price for chart drawing (only if symbol matches chart)
    window.hubEntryPrice = (symbolMatchesChart && position?.avg_entry_price) ? position.avg_entry_price : null;
    window.hubCurrentPrice = currentPrice;

    const _posCi = _getHubCurrencyInfoForSymbol(symbol);
    const _posCurr = _posCi.symbol;

    if (position && position.quantity > 0) {
        const pnl = (currentPrice - position.avg_entry_price) * position.quantity;
        const pnlPercent = position.avg_entry_price > 0 ? ((currentPrice / position.avg_entry_price) - 1) * 100 : 0;

        if (qtyEl) qtyEl.textContent = `${position.quantity.toLocaleString()} kg`;
        if (entryEl) entryEl.textContent = `${_posCurr}${position.avg_entry_price.toFixed(2)}`;
        if (pnlEl) {
            pnlEl.textContent = `${pnl >= 0 ? '+' : ''}${_posCurr}${Math.abs(pnl).toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`;
            pnlEl.style.color = pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
        }
    } else {
        if (qtyEl) qtyEl.textContent = '0 kg';
        if (entryEl) entryEl.textContent = `${_posCurr}\u2014`;
        if (pnlEl) {
            pnlEl.textContent = `${_posCurr}0.00`;
            pnlEl.style.color = 'var(--text-secondary)';
        }
        window.hubEntryPrice = null;
    }
}

// =============================================
// RSI RESIZER
// =============================================

function setupRsiResizer() {
    const handle = document.getElementById('rsi-resize-handle');
    if (!handle) return;

    handle.addEventListener('mousedown', (e) => {
        isResizingRsi = true;
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';

        const startY = e.clientY;
        const startHeight = state.hubRsiHeight;

        const onMouseMove = (e) => {
            if (!isResizingRsi) return;
            const delta = startY - e.clientY;
            state.hubRsiHeight = Math.max(80, Math.min(300, startHeight + delta));
            const rsiCanvas = document.getElementById('hubRsiChart');
            if (rsiCanvas) {
                rsiCanvas.style.height = `${state.hubRsiHeight}px`;
            }
            drawHubChart();
        };

        const onMouseUp = () => {
            isResizingRsi = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

// =============================================
// HUB CHART DRAWING
// =============================================

// =============================================
// HUB CHART — TRADINGVIEW ENGINE
// =============================================

/**
 * Tear down the existing TradingView hub chart instance, if any.
 * Must be called before creating a new one to avoid DOM memory leaks.
 */
function _destroyHubTvChart() {
    if (_hubTvChart) {
        try { _hubTvChart.remove(); } catch (e) {}
        _hubTvChart = null;
    }
    _hubMainSeries = null;
    _hubVolumeSeries = null;
    _hubStudySeries = {};
    if (_hubTvRsiChart) {
        try { _hubTvRsiChart.remove(); } catch (e) {}
        _hubTvRsiChart = null;
        _hubTvRsiSeries = null;
    }
}

/**
 * Initialize (or re-initialize) the TradingView chart for the hub.
 * Mirrors the configuration of the main screen TV chart in charts.js
 * so both views look identical.
 */
function _initHubTvChart() {
    const container = document.getElementById('hub-tv-chart');
    if (!container || typeof LightweightCharts === 'undefined') return;

    _destroyHubTvChart();

    _hubTvChart = LightweightCharts.createChart(container, {
        layout: {
            textColor: '#94a3b8',
            background: { type: 'solid', color: 'transparent' }
        },
        grid: {
            vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
            horzLines: { color: 'rgba(255, 255, 255, 0.05)' }
        },
        rightPriceScale: { borderVisible: false, autoScale: true },
        leftPriceScale: { visible: false },
        timeScale: { timeVisible: true, borderVisible: false, secondsVisible: false },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        handleScroll: true,
        handleScale: true,
        autoSize: true,
    });

    // Create the main price series
    if (state.hubChartType === 'candle') {
        _hubMainSeries = _hubTvChart.addCandlestickSeries({
            upColor: '#10b981',
            downColor: '#ef4444',
            borderVisible: false,
            wickUpColor: '#10b981',
            wickDownColor: '#ef4444',
        });
    } else {
        _hubMainSeries = _hubTvChart.addAreaSeries({
            lineColor: '#1a73e8',
            topColor: 'rgba(26, 115, 232, 0.25)',
            bottomColor: 'rgba(26, 115, 232, 0.02)',
            lineWidth: 2,
            crosshairMarkerVisible: true,
        });
    }

    // Volume histogram (pane 1)
    _hubVolumeSeries = _hubTvChart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
        color: 'rgba(100, 116, 139, 0.35)',
        lastValueVisible: false,
        priceLineVisible: false,
    });
    _hubTvChart.priceScale('vol').applyOptions({
        scaleMargins: { top: 0.80, bottom: 0 },
    });
}

/**
 * Convert hub chart data (which uses Date objects) to TradingView's
 * required { time, open, high, low, close, value } format.
 * Applies the forex multiplier exactly as the main chart does in charts.js.
 */
function _toHubTvData(rawData) {
    if (!rawData || rawData.length === 0) return [];

    // Forex multiplier (same double-conversion guard as before)
    const _fxInfo = _getHubCurrencyInfo();
    let _fx = _fxInfo.multiplier || 1;
    if (_fx > 1) {
        const closes = rawData.map(d => Number(d.close) || 0).filter(p => p > 0).sort((a, b) => a - b);
        const median = closes.length > 0 ? closes[Math.floor(closes.length / 2)] : 0;
        if (median > 50) _fx = 1; // Data already in local currency
    }

    const tvData = rawData.map(d => {
        const t = d.date instanceof Date ? d.date : new Date(d.date);
        const ts = Math.floor(t.getTime() / 1000);
        const vol = d.volume > 0 ? d.volume : Math.abs((d.high - d.low) * 50000);
        return {
            time: ts,
            open: (Number(d.open) || 0) * _fx,
            high: (Number(d.high) || 0) * _fx,
            low: (Number(d.low) || 0) * _fx,
            close: (Number(d.close) || 0) * _fx,
            value: (Number(d.close) || 0) * _fx, // for area/line series
            volume: vol,
        };
    });

    // Deduplicate by timestamp and sort ascending (TV requirement)
    return [...new Map(tvData.map(d => [d.time, d])).values()]
        .filter(d => d.close > 0)
        .sort((a, b) => a.time - b.time);
}

/**
 * The hub chart draw function. Called in place of the old canvas drawHubChart().
 * On first call it creates the TradingView instance. On subsequent calls it
 * just updates the data — the chart is never torn down between ticks.
 */
function drawHubChart() {
    const container = document.getElementById('hub-tv-chart');
    if (!container) return;

    // Ensure we have data
    if (!state.hubChartData || state.hubChartData.length === 0) {
        state.hubChartData = generateHubChartData();
    }

    // Create chart if not yet initialised (or if type changed via setHubChartType)
    if (!_hubTvChart || !_hubMainSeries) {
        _initHubTvChart();
    }

    if (!_hubMainSeries) return; // Safety: init may fail if TV is not loaded yet

    const tvData = _toHubTvData(state.hubChartData);
    if (tvData.length === 0) return;

    // Feed price data to main series
    try {
        _hubMainSeries.setData(tvData);
    } catch (e) {
        // Occasionally TV throws on setData if series was just replaced — retry once
        _initHubTvChart();
        if (_hubMainSeries) _hubMainSeries.setData(tvData);
    }

    // Feed volume data
    if (_hubVolumeSeries) {
        const volData = tvData.map(d => ({
            time: d.time,
            value: d.volume || 0,
            color: d.close >= d.open ? 'rgba(16,185,129,0.4)' : 'rgba(239,68,68,0.4)',
        }));
        try { _hubVolumeSeries.setData(volData); } catch (e) {}
    }

    // Draw overlays (studies)
    _applyHubStudyOverlays(tvData);

    // Draw RSI sub-chart if enabled
    if (state.hubStudies?.rsi) {
        drawHubRsi(tvData);
    }

    // Draw entry-price line if the user has a position
    _applyHubEntryPriceLine();

    // Fit chart to all content
    try { _hubTvChart.timeScale().fitContent(); } catch (e) {}

    // Update the price display header
    updateHubPriceDisplay();
}

/**
 * Apply/remove studies (SMA, EMA, Bollinger) as TV line/band series overlays.
 */
function _applyHubStudyOverlays(tvData) {
    if (!_hubTvChart || !tvData || tvData.length === 0) return;

    const closes = tvData.map(d => d.close);

    const smaLine = (period, color, key) => {
        if (!state.hubStudies?.[key]) {
            if (_hubStudySeries[key]) {
                try { _hubTvChart.removeSeries(_hubStudySeries[key]); } catch (e) {}
                delete _hubStudySeries[key];
            }
            return;
        }
        if (!_hubStudySeries[key]) {
            _hubStudySeries[key] = _hubTvChart.addLineSeries({
                color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false,
            });
        }
        const data = [];
        for (let i = period - 1; i < closes.length; i++) {
            const avg = closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
            data.push({ time: tvData[i].time, value: avg });
        }
        try { _hubStudySeries[key].setData(data); } catch (e) {}
    };

    const emaLine = (period, color, key) => {
        if (!state.hubStudies?.[key]) {
            if (_hubStudySeries[key]) {
                try { _hubTvChart.removeSeries(_hubStudySeries[key]); } catch (e) {}
                delete _hubStudySeries[key];
            }
            return;
        }
        if (!_hubStudySeries[key]) {
            _hubStudySeries[key] = _hubTvChart.addLineSeries({
                color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false,
            });
        }
        const k = 2 / (period + 1);
        let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
        const data = [];
        for (let i = period - 1; i < closes.length; i++) {
            if (i > period - 1) ema = closes[i] * k + ema * (1 - k);
            data.push({ time: tvData[i].time, value: ema });
        }
        try { _hubStudySeries[key].setData(data); } catch (e) {}
    };

    smaLine(10, '#facc15', 'sma10');
    smaLine(20, '#38bdf8', 'sma20');
    smaLine(50, '#a855f7', 'sma50');
    emaLine(10, '#ef4444', 'ema10');
    emaLine(20, '#22c55e', 'ema20');

    // Bollinger Bands (upper + lower as two line series)
    const bbKey = 'bollinger';
    if (!state.hubStudies?.[bbKey]) {
        ['_bbUpper', '_bbLower', '_bbMid'].forEach(k => {
            if (_hubStudySeries[k]) {
                try { _hubTvChart.removeSeries(_hubStudySeries[k]); } catch (e) {}
                delete _hubStudySeries[k];
            }
        });
    } else {
        const period = 20, mult = 2;
        ['_bbUpper', '_bbLower', '_bbMid'].forEach(k => {
            if (!_hubStudySeries[k]) {
                _hubStudySeries[k] = _hubTvChart.addLineSeries({
                    color: 'rgba(96,165,250,0.7)', lineWidth: 1,
                    priceLineVisible: false, lastValueVisible: false,
                    lineStyle: k === '_bbMid' ? 1 : 0, // dashed mid
                });
            }
        });
        const upper = [], lower = [], mid = [];
        for (let i = period - 1; i < closes.length; i++) {
            const slice = closes.slice(i - period + 1, i + 1);
            const avg = slice.reduce((a, b) => a + b, 0) / period;
            const std = Math.sqrt(slice.reduce((a, b) => a + (b - avg) ** 2, 0) / period);
            upper.push({ time: tvData[i].time, value: avg + mult * std });
            lower.push({ time: tvData[i].time, value: avg - mult * std });
            mid.push({ time: tvData[i].time, value: avg });
        }
        try { _hubStudySeries['_bbUpper'].setData(upper); } catch (e) {}
        try { _hubStudySeries['_bbLower'].setData(lower); } catch (e) {}
        try { _hubStudySeries['_bbMid'].setData(mid); } catch (e) {}
    }
}

/**
 * Draw (or remove) the user's entry-price marker as a TV price line.
 */
function _applyHubEntryPriceLine() {
    if (!_hubMainSeries) return;

    // Remove any existing entry price line
    if (window._hubEntryPriceLine) {
        try { _hubMainSeries.removePriceLine(window._hubEntryPriceLine); } catch (e) {}
        window._hubEntryPriceLine = null;
    }

    const _fxInfo = _getHubCurrencyInfo();
    const _fx = _fxInfo.multiplier || 1;
    const _displayEntry = (window.hubEntryPrice && isFinite(window.hubEntryPrice))
        ? window.hubEntryPrice * _fx : null;
    if (!_displayEntry) return;

    const lastClose = state.hubChartData?.[state.hubChartData.length - 1]?.close * _fx || 0;
    const isProfit = lastClose >= _displayEntry;

    window._hubEntryPriceLine = _hubMainSeries.createPriceLine({
        price: _displayEntry,
        color: isProfit ? '#10b981' : '#ef4444',
        lineWidth: 1,
        lineStyle: 2, // dashed
        axisLabelVisible: true,
        title: 'Entry',
    });
}

/**
 * Draw the RSI sub-chart in the hub-tv-rsi-chart container using a
 * separate small TradingView chart (line series, RSI values 0-100).
 */
function drawHubRsi(tvData) {
    const container = document.getElementById('hub-tv-rsi-chart');
    if (!container) return;
    if (!tvData || tvData.length < 16) return;

    if (!_hubTvRsiChart) {
        _hubTvRsiChart = LightweightCharts.createChart(container, {
            layout: {
                textColor: '#6b7280',
                background: { type: 'solid', color: 'transparent' }
            },
            grid: {
                vertLines: { color: 'rgba(255,255,255,0.03)' },
                horzLines: { color: 'rgba(255,255,255,0.03)' }
            },
            rightPriceScale: { borderVisible: false, autoScale: false,
                minimum: 0, maximum: 100 },
            leftPriceScale: { visible: false },
            timeScale: { visible: false, borderVisible: false },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
            autoSize: true,
        });
        _hubTvRsiSeries = _hubTvRsiChart.addLineSeries({
            color: '#ec4899', lineWidth: 2,
            priceLineVisible: false, lastValueVisible: true,
        });
        // Overbought / oversold lines
        _hubTvRsiChart.addLineSeries({ color: 'rgba(239,68,68,0.4)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
            .setData(tvData.map(d => ({ time: d.time, value: 70 })));
        _hubTvRsiChart.addLineSeries({ color: 'rgba(16,185,129,0.4)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
            .setData(tvData.map(d => ({ time: d.time, value: 30 })));
    }

    // Calculate RSI(14)
    const period = 14;
    const closes = tvData.map(d => d.close);
    const rsiData = [];
    for (let i = period; i < closes.length; i++) {
        let gains = 0, losses = 0;
        for (let j = i - period + 1; j <= i; j++) {
            const chg = closes[j] - closes[j - 1];
            if (chg > 0) gains += chg; else losses -= chg;
        }
        const avgGain = gains / period;
        const avgLoss = losses / period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        const rsi = 100 - (100 / (1 + rs));
        rsiData.push({ time: tvData[i].time, value: rsi });
    }

    try { _hubTvRsiSeries.setData(rsiData); } catch (e) {}

    // Update RSI value display
    if (rsiData.length > 0) {
        const lastRsi = rsiData[rsiData.length - 1].value;
        const rsiValueEl = document.getElementById('hub-rsi-value');
        if (rsiValueEl) {
            rsiValueEl.textContent = lastRsi.toFixed(1);
            rsiValueEl.style.color = lastRsi >= 70 ? '#ef4444' : lastRsi <= 30 ? '#10b981' : '#9ca3af';
        }
    }
}

// Legacy stubs — kept only to avoid ReferenceErrors in any lingering call sites
function drawHubSMA() {}
function drawHubEMA() {}

// =============================================
// HUB CONTROLS
// =============================================

function toggleHubTimeframeMenu() {
    const menu = document.getElementById('hub-timeframe-menu');
    if (menu) {
        menu.classList.toggle('visible');
    }
}

function setHubTimeframe(tf) {
    state.hubTimeframe = tf;

    // Sync global timeframe state so getPriceHistory uses the correct
    // TIMEFRAME_CONFIG interval (5-min candles for 1D, hourly for 1W, etc.)
    state.currentTimeframe = tf;
    state.cachedTimeframe = null;
    state.chartData = [];
    if (window.mainYAxisCache) window.mainYAxisCache = {};

    // Update all timeframe labels (hub + main chart dropdown)
    document.getElementById('hub-timeframe-label').textContent = tf;
    const mainLabel = document.getElementById('timeframe-label');
    if (mainLabel) mainLabel.textContent = tf;

    // Keep .timeframe-item active state in sync
    document.querySelectorAll('.timeframe-item').forEach(item => {
        item.classList.toggle('active', item.textContent.trim() === tf);
    });

    // Close menus
    document.getElementById('hub-timeframe-menu')?.classList.remove('visible');
    document.getElementById('hub-studies-menu')?.classList.remove('visible');

    // Resolve the symbol the hub chart is currently displaying
    const rawSymbol = document.getElementById('hub-buy-symbol')?.value
        || state.mainChartData?.symbol
        || 'KENYA';
    const symbol = rawSymbol === 'KENYAN' ? 'KENYA' : rawSymbol;
    const isIndex = isIndexSymbol(symbol);
    const symbolType = isIndex ? 'index' : 'tea';

    // Show loading state immediately
    state.hubChartData = [];
    drawHubChart();

    // Snapshot both symbol AND timeframe for the closure guards below.
    // We call loadChartDataFromHistory directly (bypassing getPriceHistory's
    // shared cache) so that each timeframe click issues its own independent
    // DB fetch. This prevents the race condition where a still-in-flight fetch
    // for the previous timeframe is returned from the loading-promise guard and
    // then incorrectly applied to the newly selected timeframe.
    const snapshotSymbol = symbol;
    const snapshotTf = tf;

    loadChartDataFromHistory(symbol, symbolType, tf)
        .then(data => {
            if (!data || data.length === 0) return;
            // Discard if the user changed timeframe or symbol while we were fetching
            if (state.hubTimeframe !== snapshotTf) return;
            const currentRaw = document.getElementById('hub-buy-symbol')?.value || '';
            const currentSym = currentRaw === 'KENYAN' ? 'KENYA' : currentRaw;
            if (currentRaw && currentSym !== snapshotSymbol) return;

            // Populate the shared cache so live-tick updates can append to it
            const _tfKey = state.currentTimeframe || '1D';
            const cacheKey = (symbolType === 'index' ? `INDEX_${symbol}` : symbol) + `_${_tfKey}`;
            if (state.priceDataCache) {
                state.priceDataCache.data[cacheKey] = data;
                state.priceDataCache.lastUpdate[cacheKey] = Date.now();
                state.priceDataCache.loaded[cacheKey] = true;
                delete state.priceDataCache.loading[cacheKey];
            }

            state.hubChartData = [...data];
            drawHubChart();
            updateHubPriceDisplay();
        })
        .catch(() => { });
}

function toggleHubStudiesMenu() {
    const menu = document.getElementById('hub-studies-menu');
    if (menu) {
        menu.classList.toggle('visible');
    }
}

function toggleHubStudy(study) {
    state.hubStudies[study] = !state.hubStudies[study];
    updateHubStudyToggles();
    closeAllDropdowns();

    // Show/hide RSI section
    if (study === 'rsi') {
        const rsiSection = document.getElementById('hub-rsi-section');
        if (state.hubStudies.rsi) {
            rsiSection.classList.add('visible');
        } else {
            rsiSection.classList.remove('visible');
        }
    }

    drawHubChart();
}

function setHubChartType(type) {
    state.hubChartType = type;
    document.getElementById('hub-btn-line').classList.toggle('active', type === 'line');
    document.getElementById('hub-btn-candle').classList.toggle('active', type === 'candle');
    // TV requires a different series type for line vs candle — force full reinit
    _destroyHubTvChart();
    drawHubChart();
}

function switchHubTradeTab(tab) {
    const tabs = document.querySelectorAll('.trading-hub-sidebar .trade-tab');
    const buyForm = document.getElementById('hub-buy-form');
    const sellForm = document.getElementById('hub-sell-form');

    tabs.forEach(t => t.classList.remove('active'));
    document.querySelector(`.trading-hub-sidebar .trade-tab[data-tab="${tab}"]`).classList.add('active');

    if (tab === 'hub-buy') {
        buyForm.style.display = 'block';
        sellForm.style.display = 'none';
    } else {
        buyForm.style.display = 'none';
        sellForm.style.display = 'block';
    }
}

function setHubQuickAmount(side, amount) {
    document.getElementById(`hub-${side}-quantity`).value = amount;
    updateHubOrderPreview();
}

function updateHubOrderPreview() {
    const buyQty = parseFloat(document.getElementById('hub-buy-quantity')?.value) || 0;
    const sellQty = parseFloat(document.getElementById('hub-sell-quantity')?.value) || 0;
    const buySymbol = document.getElementById('hub-buy-symbol')?.value;
    const sellSymbol = document.getElementById('hub-sell-symbol')?.value;

    const _getDisplayPrice = (symbol) => {
        const lookupSymbol = symbol === 'KENYAN' ? 'KENYA' : symbol;
        let rawUsd = 3.50;
        if (isIndexSymbol(lookupSymbol)) {
            const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
            const index = indexes.find(idx => idx.symbol === lookupSymbol);
            rawUsd = index?.price || 3.50;
        } else {
            const tea = state.teas?.find(t => t.symbol === symbol);
            rawUsd = tea?.current_price || 3.50;
        }
        const ci = _getHubCurrencyInfoForSymbol(symbol);
        return { price: rawUsd * ci.multiplier, currency: ci.symbol };
    };

    const buy = _getDisplayPrice(buySymbol);
    const sell = _getDisplayPrice(sellSymbol);

    const _fmt = (val, curr) => {
        if (val >= 10000) return curr + val.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        if (val >= 100) return curr + val.toFixed(1);
        return curr + val.toFixed(2);
    };

    const SPREAD_PCT = 0.01;
    const OVERNIGHT_RATE = 0.05 / 365;

    // BUY preview: user pays ASK = market * (1 + spread/2)
    const buyLeverage = parseFloat(document.getElementById('hub-buy-leverage')?.value) || 10;
    const buyAskPrice = buy.price * (1 + SPREAD_PCT / 2);
    const buyNotional = buyQty * buyAskPrice;
    const buyMargin = buyNotional / buyLeverage;
    const buySpreadCost = (buyAskPrice - buy.price) * buyQty;
    const buyOvernightEst = buyNotional * OVERNIGHT_RATE;

    const mktPriceEl = document.getElementById('hub-buy-market-price');
    if (mktPriceEl) mktPriceEl.textContent = `${_fmt(buy.price, buy.currency)}/kg`;
    document.getElementById('hub-buy-est-price').textContent = `${_fmt(buyAskPrice, buy.currency)}/kg`;
    document.getElementById('hub-buy-total-cost').textContent = _fmt(buyNotional, buy.currency);
    const buyMarginEl = document.getElementById('hub-buy-margin');
    if (buyMarginEl) buyMarginEl.textContent = _fmt(buyMargin, buy.currency);
    document.getElementById('hub-buy-commission').textContent = _fmt(buySpreadCost, buy.currency);
    const buyOvEl = document.getElementById('hub-buy-overnight');
    if (buyOvEl) buyOvEl.textContent = buyQty > 0 ? `${(OVERNIGHT_RATE * 100).toFixed(3)}%/day (~${_fmt(buyOvernightEst, buy.currency)}/night)` : '0.014%/day';

    // SELL preview: user gets BID = market * (1 - spread/2)
    const sellLeverage = parseFloat(document.getElementById('hub-sell-leverage')?.value) || 10;
    const sellBidPrice = sell.price * (1 - SPREAD_PCT / 2);
    const sellNotional = sellQty * sellBidPrice;
    const sellMargin = sellNotional / sellLeverage;
    const sellSpreadCost = (sell.price - sellBidPrice) * sellQty;
    const sellOvernightEst = sellNotional * OVERNIGHT_RATE;

    const sellMktEl = document.getElementById('hub-sell-market-price');
    if (sellMktEl) sellMktEl.textContent = `${_fmt(sell.price, sell.currency)}/kg`;
    document.getElementById('hub-sell-est-price').textContent = `${_fmt(sellBidPrice, sell.currency)}/kg`;
    document.getElementById('hub-sell-total-cost').textContent = _fmt(sellNotional, sell.currency);
    const sellMarginEl = document.getElementById('hub-sell-margin');
    if (sellMarginEl) sellMarginEl.textContent = _fmt(sellMargin, sell.currency);
    document.getElementById('hub-sell-commission').textContent = _fmt(sellSpreadCost, sell.currency);
    const sellOvEl = document.getElementById('hub-sell-overnight');
    if (sellOvEl) sellOvEl.textContent = sellQty > 0 ? `${(OVERNIGHT_RATE * 100).toFixed(3)}%/day (~${_fmt(sellOvernightEst, sell.currency)}/night)` : '0.014%/day';

    // Update button labels with commitment summary
    const buyBtnLabel = document.getElementById('hub-buy-btn-label');
    if (buyBtnLabel) {
        buyBtnLabel.textContent = buyQty > 0
            ? `BUY ${buyQty.toLocaleString()} kg — ${_fmt(buyMargin, buy.currency)}`
            : 'Place Buy Order';
    }
    const sellBtnLabel = document.getElementById('hub-sell-btn-label');
    if (sellBtnLabel) {
        sellBtnLabel.textContent = sellQty > 0
            ? `SELL ${sellQty.toLocaleString()} kg — ${_fmt(sellMargin, sell.currency)}`
            : 'Place Sell Order';
    }

    // Handle limit price visibility
    const buyOrderType = document.getElementById('hub-buy-order-type')?.value;
    const sellOrderType = document.getElementById('hub-sell-order-type')?.value;

    document.getElementById('hub-buy-limit-price-group').style.display = buyOrderType === 'limit' ? 'block' : 'none';
    document.getElementById('hub-sell-limit-price-group').style.display = sellOrderType === 'limit' ? 'block' : 'none';

    // Update position display
    updateHubPositionInfo();

    // Update chart title to match selected symbol
    const hubTitle = document.getElementById('hub-chart-title');
    const indexSymbols = getIndexSymbols();
    const isIndex = indexSymbols.includes(buySymbol);

    const priceDisplay = document.querySelector('#trading-hub-chart-panel .price-display h3');
    const changeDisplay = document.querySelector('#trading-hub-chart-panel .price-display .change');

    const _prevCi = _getHubCurrencyInfoForSymbol(buySymbol);
    const _prevC = _prevCi.symbol;
    const _prevM = _prevCi.multiplier;
    const _fmtP = (v) => {
        const dv = v * _prevM;
        if (dv >= 10000) return _prevC + dv.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        if (dv >= 100) return _prevC + dv.toFixed(1);
        return _prevC + dv.toFixed(2);
    };

    if (isIndex) {
        const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
        const lookupSymbol = buySymbol === 'KENYAN' ? 'KENYA' : buySymbol;
        const index = indexes.find(idx => idx.symbol === lookupSymbol);
        if (hubTitle && index) {
            hubTitle.textContent = index.name || buySymbol;
        }
        if (priceDisplay && index) {
            priceDisplay.textContent = _fmtP(index.price || 0);
            const change = index.change || 0;
            if (changeDisplay) {
                changeDisplay.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
                changeDisplay.className = `change ${change >= 0 ? 'up' : 'down'}`;
            }
        }
    } else {
        const tea = state.teas?.find(t => t.symbol === buySymbol);
        if (hubTitle && tea) {
            hubTitle.textContent = tea.name || buySymbol;
        }
        if (priceDisplay && tea) {
            priceDisplay.textContent = `$${tea.current_price?.toFixed(2) || '0.00'}`;
            const change = tea.previous_price ? ((tea.current_price - tea.previous_price) / tea.previous_price * 100) : 0;
            if (changeDisplay) {
                changeDisplay.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
                changeDisplay.className = `change ${change >= 0 ? 'up' : 'down'}`;
            }
        }
    }

    // Load chart data for new symbol from cache/DB and redraw
    state.hubChartData = generateHubChartData();
    const hubSym = document.getElementById('hub-buy-symbol')?.value || 'KENYA';

    // Clear Y-axis cache for this symbol so chart starts fresh with new bounds
    if (window.hubYAxisCache) {
        delete window.hubYAxisCache[hubSym];
    }

    loadOrGenerateHubChartData(hubSym).then(data => {
        state.hubChartData = data;
        if (state.maximizedPanel?.classList.contains('panel-maximized')) {
            drawHubChart();
        }
    });
    if (state.maximizedPanel?.classList.contains('panel-maximized')) {
        drawHubChart();
    }
}

// =============================================
// HUB TRADE EXECUTION
// =============================================

async function executeHubTrade(side) {
    if (!state.currentUser) {
        showToast('Please log in to trade', 'error');
        return;
    }

    let symbol = document.getElementById(`hub-${side}-symbol`)?.value;
    const quantity = parseFloat(document.getElementById(`hub-${side}-quantity`)?.value);
    const orderType = document.getElementById(`hub-${side}-order-type`)?.value;
    const leverage = parseFloat(document.getElementById(`hub-${side}-leverage`)?.value) || 10;

    if (!quantity || quantity <= 0) {
        showToast('Please enter a valid quantity', 'error');
        return;
    }

    // Check if this is an index trade
    const lookupSymbol = symbol === 'KENYAN' ? 'KENYA' : symbol;
    const isIndex = isIndexSymbol(lookupSymbol);

    let price, productName, teaId = null;

    if (isIndex) {
        // INDEX TRADE — recalculate from state.teas right now (freshest possible price)
        const freshIndexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
        const index = freshIndexes.find(idx => idx.symbol === lookupSymbol);

        if (!index || !index.price) {
            showToast('Index not found', 'error');
            return;
        }

        price = orderType === 'limit'
            ? parseFloat(document.getElementById(`hub-${side}-limit-price`)?.value)
            : index.price;

        if (!price || price <= 0) {
            showToast('Could not determine index price — try again', 'error');
            return;
        }

        productName = index.name || symbol;

        // Use first underlying tea's ID for database reference
        const underlyingTea = state.teas?.find(t => index.teas?.includes(t.symbol));
        teaId = underlyingTea?.id || null;

    } else {
        // TEA TRADE — use current_price straight from state.teas (kept fresh by Realtime)
        const tea = state.teas?.find(t => t.symbol === symbol);
        if (!tea) {
            showToast('Product not found. Please select a valid symbol.', 'error');
            return;
        }

        price = orderType === 'limit'
            ? parseFloat(document.getElementById(`hub-${side}-limit-price`)?.value)
            : tea.current_price;

        if (!price || price <= 0) {
            showToast('Could not determine tea price — try again', 'error');
            return;
        }

        productName = tea.name || symbol;
        teaId = tea.id;
    }

    if ((orderType === 'limit' || orderType === 'stop') && (!price || price <= 0)) {
        showToast('Please enter a valid ' + orderType + ' price', 'error');
        return;
    }

    try {
        const total = quantity * price;

        if (orderType === 'limit' || orderType === 'stop') {
            // PENDING ORDER: place limit or stop order server-side
            const result = await apiPlaceOrder(
                isIndex ? lookupSymbol : symbol,
                isIndex,
                side.toUpperCase(),
                orderType.toUpperCase(),
                quantity,
                price,
                null
            );
            if (!result.success) {
                throw new Error(result.error || 'Order placement failed');
            }
            if (result.new_balance !== undefined) {
                setActiveBalance(result.new_balance);
            }
            showToast(
                `${orderType.toUpperCase()} ${side.toUpperCase()} order placed`,
                `${symbol} ${quantity} kg @ $${price.toFixed(2)} — will fill when price is reached`
            );
            loadPendingOrders();
        } else if (isIndex) {
            const result = await apiExecuteIndexTrade(lookupSymbol, side.toUpperCase(), quantity, price, leverage);
            if (!result.success) {
                throw new Error(result.error || 'Index trade failed');
            }
            setActiveBalance(result.new_balance);
            const _ci = _getHubCurrencyInfoForSymbol(symbol);
            const _dp = (result.execution_price || price) * _ci.multiplier;
            const _dps = _dp >= 100 ? _ci.symbol + _dp.toFixed(1) : _ci.symbol + _dp.toFixed(2);
            const _sc = result.spread_cost ? ` | Spread: $${Number(result.spread_cost).toFixed(2)}` : '';
            const _mu = result.margin_used ? ` | Margin: $${Number(result.margin_used).toFixed(2)}` : '';
            showToast(`${side.toUpperCase()} filled: ${symbol} ${quantity}kg @ ${_dps} (${leverage}x)${_sc}${_mu}`, 'success');
        } else {
            const result = await apiExecuteTrade(symbol, side.toUpperCase(), quantity, leverage);
            if (!result.success) {
                throw new Error(result.error || 'Trade failed');
            }
            setActiveBalance(result.new_balance);
            const execP = result.execution_price || price;
            const _sc = result.spread_cost ? ` | Spread: $${Number(result.spread_cost).toFixed(2)}` : '';
            showToast(`${side.toUpperCase()} filled: ${symbol} ${quantity}kg @ $${execP.toFixed(2)} (${leverage}x)${_sc}${_mu}`, 'success');
        }

        if (typeof completeFirstTradeMissionTrade === 'function') {
            completeFirstTradeMissionTrade();
        }

        addTradeToLog({
            time: new Date(),
            symbol: symbol,
            side: side,
            quantity: quantity,
            price: price
        });

        document.getElementById(`hub-${side}-quantity`).value = '';
        updateHubOrderPreview();

        if (typeof loadPositions === 'function') await loadPositions();
        if (typeof loadIndexPositions === 'function') await loadIndexPositions();
        if (typeof loadUserTrades === 'function') loadUserTrades();

        updateHubPositionInfo();
        drawHubChart();

    } catch (err) {
        console.error('Trade error:', err);
        showToast('Error placing order: ' + err.message, 'error');
    }
}

// =============================================
// TRADE LOG SIMULATION
// =============================================

function startTradeLogSimulation() {
    // Disabled logic for Phase 6 LIVE Environment Transition
    // Real trades should populate this via Realtime subscription in the future.
    tradeLogEntries = [];
    if (state.tradeLogInterval) clearInterval(state.tradeLogInterval);
    renderTradeLog();
}

function addTradeToLog(trade) {
    tradeLogEntries.unshift(trade);
    if (tradeLogEntries.length > 20) {
        tradeLogEntries.pop();
    }
    renderTradeLog();
}

function renderTradeLog() {
    const container = document.getElementById('trade-log-content');
    if (!container) return;

    container.innerHTML = tradeLogEntries.map(trade => {
        const time = trade.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const symbolShort = trade.symbol.split('-')[1] || trade.symbol;
        const c = typeof getCurrencyForSymbol === 'function' ? getCurrencyForSymbol(trade.symbol) : '$';

        return `
            <div class="trade-log-item">
                <span class="trade-log-time">${time}</span>
                <span class="trade-log-symbol">${escapeHtml(symbolShort)}</span>
                <span class="trade-log-side ${trade.side}">${escapeHtml(trade.side.toUpperCase())}</span>
                <span class="trade-log-qty">${trade.quantity.toLocaleString()} kg</span>
                <span class="trade-log-price">${c}${trade.price.toFixed(2)}</span>
            </div>
        `;
    }).join('');
}

// =============================================
// ESCAPE KEY HANDLER
// =============================================

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.maximizedPanel) {
        toggleMaximize(state.maximizedPanel.id);
    }
});
