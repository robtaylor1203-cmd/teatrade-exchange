/**
 * TeaTrade Exchange — Market / Price Engine (market.js)
 * =====================================================
 * Handles price data cache, index calculations, Realtime ticker processing,
 * price alerts, market status, and chart data management.
 *
 * ALL price data comes from the server (Supabase Edge Functions).
 * This module is a PASSIVE consumer — no simulation, no random generation.
 *
 * Globals used from config.js : supabaseClient, state, cardData, studyColors,
 *   timeframeConfig, leftMargin, rightMargin, bottomMargin, getIndexSymbols,
 *   isIndexSymbol, TICKER_DEBOUNCE_MS, teaDisplayData
 * Globals used from api.js   : apiFetchPriceHistory,
 *   subscribeToTicker, subscribeToMacro, apiFetchMarketState
 * Globals used from utils.js : showToast, formatIndexPrice
 *
 * Functions called from other files (available at runtime as globals):
 *   drawChart, updateQuoteBoard, updateAuctionTable, updateWatchlistTeas,
 *   updateQuickQuoteLivePrice, updateMultiChartPrices, updatePortfolioDisplay,
 *   displayUserTrades, populateTeaSelect, populateHubTeaSelects,
 *   updatePairsTable, drawHubChart, drawMultiChartPanel, drawQuickQuoteChart,
 *   updateQuickTradeSummary, updateQQMarketDepth, loadTeas, loadUserTrades,
 *   loadPositions, updateUIForLoggedInUser, updateTradeSummary,
 *   updateMacroIndicators
 */

// =============================================
// PRICE DATA CACHE
// =============================================

async function getPriceHistory(symbol, symbolType = 'tea') {
    const cacheKey = symbolType === 'index' ? `INDEX_${symbol}` : symbol;

    // Return cached data if available and recently updated (within 60s)
    if (state.priceDataCache.data[cacheKey] && state.priceDataCache.data[cacheKey].length > 0) {
        const age = Date.now() - (state.priceDataCache.lastUpdate[cacheKey] || 0);
        if (age < 60000) {
            return state.priceDataCache.data[cacheKey];
        }
    }

    // If already loading, wait for it
    if (state.priceDataCache.loading[cacheKey]) {
        return state.priceDataCache.loading[cacheKey];
    }

    // Start loading from database
    state.priceDataCache.loading[cacheKey] = (async () => {
        try {
            const dbData = await loadChartDataFromHistory(symbol, symbolType);

            if (dbData && dbData.length >= 2) {
                state.priceDataCache.data[cacheKey] = dbData;
                state.priceDataCache.loaded[cacheKey] = true;
                state.priceDataCache.lastUpdate[cacheKey] = Date.now();
                console.log(`Loaded ${dbData.length} candles for ${cacheKey} from database`);
                return dbData;
            }

            // Database empty or too sparse — return empty array. The Edge
            // Function will populate price_history over time.
            console.log(`Insufficient price history for ${cacheKey} (${dbData ? dbData.length : 0} candles) — waiting for server data`);
            state.priceDataCache.data[cacheKey] = [];
            state.priceDataCache.loaded[cacheKey] = true;
            state.priceDataCache.lastUpdate[cacheKey] = Date.now();
            return [];
        } finally {
            delete state.priceDataCache.loading[cacheKey];
        }
    })();

    return state.priceDataCache.loading[cacheKey];
}

// Synchronous version — returns cached data or empty array
function getPriceHistorySync(symbol, symbolType = 'tea') {
    const cacheKey = symbolType === 'index' ? `INDEX_${symbol}` : symbol;

    if (state.priceDataCache.data[cacheKey] && state.priceDataCache.data[cacheKey].length > 0) {
        return state.priceDataCache.data[cacheKey];
    }

    // Trigger async load in background
    getPriceHistory(symbol, symbolType).catch(() => {});

    return [];
}

// Update the unified cache with a new price tick (called when prices change)
function updatePriceCache(symbol, newPrice, symbolType = 'tea') {
    const cacheKey = symbolType === 'index' ? `INDEX_${symbol}` : symbol;

    // Ensure the cache array exists
    if (!state.priceDataCache.data[cacheKey]) {
        state.priceDataCache.data[cacheKey] = [];
    }
    const data = state.priceDataCache.data[cacheKey];

    // If cache is empty, seed it with the first candle
    if (data.length === 0) {
        const now = new Date();
        data.push({
            date: new Date(Math.floor(now.getTime() / 3600000) * 3600000),
            open: newPrice,
            high: newPrice,
            low: newPrice,
            close: newPrice,
            volume: 0
        });
        state.priceDataCache.lastUpdate[cacheKey] = Date.now();
        if (symbolType === 'index') {
            state.indexHistoricalData[symbol] = data;
        } else {
            state.teaHistoricalData[symbol] = data;
        }
        return;
    }

    const now = new Date();
    const lastCandle = data[data.length - 1];
    const lastCandleTime = lastCandle.date instanceof Date ? lastCandle.date.getTime() : new Date(lastCandle.date).getTime();

    // Determine candle interval from data
    const candleInterval = data.length > 1
        ? (data[1].date instanceof Date ? data[1].date.getTime() : new Date(data[1].date).getTime()) -
          (data[0].date instanceof Date ? data[0].date.getTime() : new Date(data[0].date).getTime())
        : 3600000;

    if (now.getTime() - lastCandleTime < candleInterval) {
        // Update current candle
        lastCandle.high = Math.max(lastCandle.high, newPrice);
        lastCandle.low = Math.min(lastCandle.low, newPrice);
        lastCandle.close = newPrice;
    } else {
        // Create new candle
        data.push({
            date: new Date(Math.floor(now.getTime() / candleInterval) * candleInterval),
            open: lastCandle.close,
            high: Math.max(lastCandle.close, newPrice),
            low: Math.min(lastCandle.close, newPrice),
            close: newPrice,
            volume: 0
        });

        // Keep array at max 1000 candles
        if (data.length > 1000) data.shift();
    }

    // Update legacy cache for backward compatibility
    if (symbolType === 'index') {
        state.teaHistoricalData[cacheKey] = data;
        state.indexHistoricalData[symbol] = data;
    } else {
        state.teaHistoricalData[symbol] = data;
    }
}

// Initialize price cache from database for all known symbols
async function initializePriceCache() {
    console.log('Initializing price cache from database...');
    const loadPromises = [];

    // Load all tea symbols
    if (state.teas && state.teas.length > 0) {
        state.teas.forEach(tea => {
            loadPromises.push(getPriceHistory(tea.symbol, 'tea'));
        });
    }

    // Load all index symbols from DB
    getIndexSymbols().forEach(symbol => {
        loadPromises.push(getPriceHistory(symbol, 'index'));
    });

    await Promise.allSettled(loadPromises);
    console.log('Price cache initialized');
}

// =============================================
// CHART DATA FROM DATABASE
// =============================================

// Timeframe → candle interval (minutes) and lookback window
const TIMEFRAME_CONFIG = {
    '1D':  { interval: 5,     hoursBack: 24,        limit: 500 },
    '1W':  { interval: 60,    hoursBack: 168,       limit: 1000 },
    '1M':  { interval: 240,   hoursBack: 720,       limit: 2000 },
    '3M':  { interval: 1440,  hoursBack: 2160,      limit: 3000 },
    '1Y':  { interval: 1440,  hoursBack: 8760,      limit: 5000 },
    'ALL': { interval: 10080, hoursBack: null,       limit: 10000 }
};

// Load chart data from database with timeframe-aware filtering
async function loadChartDataFromHistory(symbol, symbolType = 'tea') {
    const tf = state.currentTimeframe || '1D';
    const cfg = TIMEFRAME_CONFIG[tf] || TIMEFRAME_CONFIG['1D'];

    // Calculate the "since" timestamp for this timeframe
    let since = null;
    if (cfg.hoursBack) {
        since = new Date(Date.now() - cfg.hoursBack * 3600000).toISOString();
    }

    const rawData = await loadPriceHistory(symbol, cfg.limit, since);

    if (rawData && rawData.length >= 3) {
        return convertToOHLC(rawData, cfg.interval);
    }

    return null;
}

// Load historical price data from database
async function loadPriceHistory(symbol, limit = 500, since = null) {
    if (!supabaseClient) return null;

    try {
        const { data, error } = await apiFetchPriceHistory(symbol, limit, since);
        if (error) {
            console.debug('Price history load:', error.message);
            return null;
        }
        return data;
    } catch (e) {
        console.debug('Price history load skipped:', e.message);
        return null;
    }
}

// Convert raw price ticks to OHLC candles for charting
function convertToOHLC(priceData, intervalMinutes = 60) {
    if (!priceData || priceData.length === 0) return [];

    const candles = [];
    const intervalMs = intervalMinutes * 60 * 1000;

    let currentBucket = null;
    let bucketData = [];

    priceData.forEach(tick => {
        const tickTime = new Date(tick.recorded_at).getTime();
        const bucketStart = Math.floor(tickTime / intervalMs) * intervalMs;

        if (currentBucket !== bucketStart) {
            if (bucketData.length > 0) {
                const prices = bucketData.map(d => d.price);
                candles.push({
                    date: new Date(currentBucket),
                    open: prices[0],
                    high: Math.max(...prices),
                    low: Math.min(...prices),
                    close: prices[prices.length - 1],
                    volume: bucketData.reduce((sum, d) => sum + (d.volume || 0), 0)
                });
            }
            currentBucket = bucketStart;
            bucketData = [];
        }

        bucketData.push({ price: tick.price, volume: tick.volume || 0 });
    });

    // Last bucket
    if (bucketData.length > 0) {
        const prices = bucketData.map(d => d.price);
        candles.push({
            date: new Date(currentBucket),
            open: prices[0],
            high: Math.max(...prices),
            low: Math.min(...prices),
            close: prices[prices.length - 1],
            volume: bucketData.reduce((sum, d) => sum + (d.volume || 0), 0)
        });
    }

    return candles;
}

// Append a new price tick to existing chart data (real-time update)
function appendPriceToChart(chartDataArray, newPrice, timestamp = new Date()) {
    if (!chartDataArray || chartDataArray.length === 0) return chartDataArray;

    const lastCandle = chartDataArray[chartDataArray.length - 1];
    const lastCandleTime = lastCandle.date.getTime();
    const newTime = timestamp.getTime();

    const candleInterval = chartDataArray.length > 1
        ? chartDataArray[1].date.getTime() - chartDataArray[0].date.getTime()
        : 3600000;

    if (newTime - lastCandleTime < candleInterval) {
        lastCandle.high = Math.max(lastCandle.high, newPrice);
        lastCandle.low = Math.min(lastCandle.low, newPrice);
        lastCandle.close = newPrice;
    } else {
        const newCandle = {
            date: new Date(Math.floor(newTime / candleInterval) * candleInterval),
            open: lastCandle.close,
            high: Math.max(lastCandle.close, newPrice),
            low: Math.min(lastCandle.close, newPrice),
            close: newPrice,
            volume: 0
        };
        chartDataArray.push(newCandle);

        if (chartDataArray.length > 500) {
            chartDataArray.shift();
        }
    }

    return chartDataArray;
}

// =============================================
// MARKET INDEXES
// =============================================

// Calculate market display indexes from real tea data
function calculateMarketIndexes() {
    if (!state.teas || state.teas.length === 0) return null;

    const teaMap = {};
    state.teas.forEach(t => teaMap[t.symbol] = t);

    const calcIndex = (symbols, currency = '$', multiplier = 1) => {
        const validTeas = symbols.map(s => teaMap[s]).filter(t => t && t.current_price > 0);
        if (validTeas.length === 0) return { price: 0, change: 0 };

        const avgPrice = validTeas.reduce((sum, t) => sum + t.current_price, 0) / validTeas.length * multiplier;
        const avgPrevPrice = validTeas.reduce((sum, t) => sum + (t.previous_price || t.current_price), 0) / validTeas.length * multiplier;
        const change = avgPrevPrice > 0 ? ((avgPrice - avgPrevPrice) / avgPrevPrice) * 100 : 0;

        return { price: avgPrice, change: change };
    };

    const result = {};

    if (state.dbIndexes.length > 0) {
        state.dbIndexes.forEach(idx => {
            const calc = calcIndex(idx.teas || [], idx.currency || '$', idx.multiplier || 1);
            result[idx.symbol] = calc;
        });
    } else {
        result.KENYA = calcIndex(['KEN-BP1', 'KEN-PF1', 'KEN-DUST']);
        result.MOMBASA = calcIndex(['KEN-BP1', 'KEN-PF1', 'KEN-DUST']);
        result.KOLKATA = calcIndex(['IND-ASM', 'IND-DRJ'], '\u20B9', 83);
        result.COLOMBO = calcIndex(['SRI-BOP', 'SRI-PEK']);
        result.FUTURES = calcIndex(['KEN-BP1', 'IND-ASM', 'SRI-BOP', 'CHN-YUN', 'IND-DRJ'], '$', 1000);
    }

    return result;
}

// Update all market index displays with real calculated prices
function updateAllMarketIndexes() {
    const indexes = calculateMarketIndexes();
    if (!indexes) return;

    // Update main chart if it's showing KENYA
    if (state.mainChartData.symbol === 'KENYA' && indexes.KENYA) {
        state.mainChartData.basePrice = indexes.KENYA.price;
        state.mainChartData.change = indexes.KENYA.change;
    }

    // Update card data
    cardData.forEach((card, i) => {
        const idx = indexes[card.symbol];
        if (idx) {
            card.basePrice = idx.price;
            card.change = idx.change;
        }
    });

    // Update DOM displays
    const priceEl = document.getElementById('main-chart-price');
    if (priceEl) {
        priceEl.textContent = formatIndexPrice(state.mainChartData.basePrice || 0, state.mainChartData.currency);
        const chg = Number(state.mainChartData.change) || 0;
        priceEl.className = 'chart-stat-value ' + (chg >= 0 ? 'up' : 'down');
    }

    const changeEl = document.getElementById('main-chart-change');
    if (changeEl) {
        const chg = Number(state.mainChartData.change) || 0;
        const changeVal = chg >= 0 ? '+' : '';
        changeEl.textContent = `${changeVal}${chg.toFixed(1)}%`;
    }

    // Update market cards
    cardData.forEach((card, i) => {
        const valueEl = document.getElementById(`card-value-${i}`);
        const cardChangeEl = document.getElementById(`card-change-${i}`);

        if (valueEl) {
            valueEl.textContent = formatIndexPrice(card.basePrice || 0, card.currency);
        }
        if (cardChangeEl) {
            const chg = Number(card.change) || 0;
            cardChangeEl.textContent = (chg >= 0 ? '\u25B2 +' : '\u25BC ') + Math.abs(chg).toFixed(1) + '%';
            cardChangeEl.className = 'market-card-change ' + (chg >= 0 ? 'up' : 'down');
        }
    });

    // Incrementally update index price caches (do NOT wipe history)
    Object.entries(indexes).forEach(([symbol, idx]) => {
        if (idx && idx.price > 0) {
            updatePriceCache(symbol, idx.price, 'index');
        }
    });
}

// Swap chart with a market card index
function swapChartIndex(cardIndex) {
    const clickedCardData = cardData[cardIndex];
    if (!clickedCardData) return;

    const previousMainData = { ...state.mainChartData };

    const chartSection = document.getElementById('chart-section');
    chartSection.style.opacity = '0.7';
    chartSection.style.transform = 'scale(0.98)';

    setTimeout(() => {
        state.mainChartData = { ...clickedCardData };
        const titleEl = document.getElementById('main-chart-title');
        if (titleEl) titleEl.textContent = state.mainChartData.name;
        const priceEl = document.getElementById('main-chart-price');
        if (priceEl) {
            priceEl.textContent = formatIndexPrice(state.mainChartData.basePrice || 0, state.mainChartData.currency);
            const chg = Number(state.mainChartData.change) || 0;
            priceEl.className = 'chart-stat-value ' + (chg >= 0 ? 'up' : 'down');
        }

        const chg = Number(state.mainChartData.change) || 0;
        const mainChangeEl = document.getElementById('main-chart-change');
        if (mainChangeEl) mainChangeEl.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%`;
        const volEl = document.getElementById('main-chart-volume');
        if (volEl) volEl.textContent = state.mainChartData.volume || '';

        cardData[cardIndex] = previousMainData;
        const cardLabel = document.querySelector(`#market-card-${cardIndex} .market-card-label`);
        if (cardLabel) cardLabel.textContent = previousMainData.name;
        const cardValue = document.getElementById(`card-value-${cardIndex}`);
        if (cardValue) cardValue.textContent = formatIndexPrice(previousMainData.basePrice || 0, previousMainData.currency);
        const cardChangeEl = document.getElementById(`card-change-${cardIndex}`);
        if (cardChangeEl) {
            const prevChg = Number(previousMainData.change) || 0;
            cardChangeEl.textContent = (prevChg >= 0 ? '\u25B2 +' : '\u25BC ') + Math.abs(prevChg).toFixed(1) + '%';
            cardChangeEl.className = 'market-card-change ' + (prevChg >= 0 ? 'up' : 'down');
        }

        state.cachedTimeframe = null;
        state.chartData = [];
        drawChart();

        chartSection.style.opacity = '1';
        chartSection.style.transform = 'scale(1)';
    }, 150);
}

// Calculate regional indexes from tea data
function calculateRegionalIndexes() {
    if (!state.teas.length) return [];

    const teaMap = {};
    state.teas.forEach(tea => teaMap[tea.symbol] = tea);

    const indexes = state.dbIndexes.length > 0
        ? state.dbIndexes.filter(i => !i.is_market_card)
        : [
            { symbol: 'KENYA', name: 'Kenya Tea Index', teas: ['KEN-BP1', 'KEN-PF1', 'KEN-DUST'], color: 'var(--accent-green)' },
            { symbol: 'INDIA', name: 'India Tea Index', teas: ['IND-ASM', 'IND-DRJ'], color: 'var(--accent-orange)' },
            { symbol: 'CEYLON', name: 'Ceylon Tea Index', teas: ['SRI-BOP', 'SRI-PEK'], color: 'var(--accent-purple)' },
            { symbol: 'CHINA', name: 'China Tea Index', teas: ['CHN-YUN'], color: 'var(--accent-red)' },
            { symbol: 'AFRICA', name: 'African Tea Index', teas: ['KEN-BP1', 'KEN-PF1', 'MLW-BP1', 'RWA-OP'], color: 'var(--accent-green)' },
            { symbol: 'ASIA', name: 'Asian Tea Index', teas: ['IND-ASM', 'IND-DRJ', 'SRI-BOP', 'SRI-PEK', 'CHN-YUN'], color: 'var(--accent-blue)' }
        ];

    return indexes.map(idx => {
        const prices = idx.teas.map(s => teaMap[s]?.current_price || 0).filter(p => p > 0);
        const prevPrices = idx.teas.map(s => teaMap[s]?.previous_price || 0).filter(p => p > 0);

        const avgPrice = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
        const avgPrevPrice = prevPrices.length > 0 ? prevPrices.reduce((a, b) => a + b, 0) / prevPrices.length : avgPrice;
        const change = avgPrevPrice > 0 ? ((avgPrice - avgPrevPrice) / avgPrevPrice) * 100 : 0;

        return {
            ...idx,
            price: avgPrice,
            previousPrice: avgPrevPrice,
            change: change,
            isIndex: true
        };
    });
}

// Update main chart display with real-time data from tea prices
function updateMainChartWithRealData() {
    if (!state.teas || state.teas.length === 0) return;

    const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
    const kenyaIndex = indexes.find(idx => idx.symbol === 'KENYA');

    if (kenyaIndex && state.mainChartData.symbol === 'KENYA') {
        state.mainChartData.basePrice = kenyaIndex.price;
        state.mainChartData.change = kenyaIndex.change;

        const priceEl = document.getElementById('main-chart-price');
        if (priceEl) {
            priceEl.textContent = `$${kenyaIndex.price.toFixed(2)}`;
            priceEl.className = 'chart-stat-value ' + (kenyaIndex.change >= 0 ? 'up' : 'down');
        }

        const changeEl = document.getElementById('main-chart-change');
        if (changeEl) {
            const changeVal = kenyaIndex.change >= 0 ? '+' : '';
            changeEl.textContent = `${changeVal}${kenyaIndex.change.toFixed(2)}%`;
        }

        // Force chart redraw with latest data
        state.cachedTimeframe = null;
        drawChart();
    }
}

function updateMainChartStats() {
    const priceEl = document.getElementById('main-chart-price');
    const changeEl = document.getElementById('main-chart-change');

    if (priceEl && state.mainChartData) {
        const price = Number(state.mainChartData.basePrice) || 0;
        const change = Number(state.mainChartData.change) || 0;
        const isUp = change >= 0;

        priceEl.textContent = '$' + price.toFixed(2);
        priceEl.className = 'chart-stat-value ' + (isUp ? 'up' : 'down');

        if (changeEl) {
            const changeAmt = (price * change / 100).toFixed(2);
            changeEl.textContent = `${isUp ? '+' : ''}$${changeAmt} (${isUp ? '+' : ''}${change.toFixed(1)}%)`;
            changeEl.style.color = isUp ? 'var(--accent-green)' : 'var(--accent-red)';
        }
    }
}

// =============================================
// REALTIME TICKER HANDLER
// =============================================

// Debounce timer — batches multiple per-row Realtime events into one UI refresh
let _tickerDebounceTimer = null;

/**
 * Called by the Supabase Realtime channel for every `teas` row UPDATE.
 * Merges the new price into state.teas and schedules a debounced UI refresh.
 */
function handleTickerUpdate(payload) {
    const updated = payload.new;
    if (!updated || !updated.id) return;

    const idx = state.teas.findIndex(t => t.id === updated.id);
    if (idx >= 0) {
        // Preserve previous price for change calculation
        state.teas[idx].previous_price = state.teas[idx].current_price;
        state.teas[idx].current_price = updated.current_price;
        if (updated.price_change_24h != null) state.teas[idx].price_change_24h = updated.price_change_24h;
        if (updated.last_update) state.teas[idx].last_update = updated.last_update;
        if (updated.anchor_price) state.teas[idx].anchor_price = updated.anchor_price;
        if (updated.reference_forex) state.teas[idx].reference_forex = updated.reference_forex;

        // Update unified price cache
        updatePriceCache(state.teas[idx].symbol, updated.current_price, 'tea');
    }

    // Debounce: the Edge Function updates N teas at once; batch them
    clearTimeout(_tickerDebounceTimer);
    _tickerDebounceTimer = setTimeout(onTickerBatchComplete, TICKER_DEBOUNCE_MS);
}

/**
 * Fires once after all per-row ticker updates have been received.
 * Refreshes every UI surface that depends on tea prices.
 */
function onTickerBatchComplete() {
    // Recalculate indexes
    updateAllMarketIndexes();

    // Refresh UI surfaces
    updateQuoteBoard();
    updateMainChartStats();
    updateChartsWithNewPrices();
    updateAuctionTable();
    updateWatchlistTeas();

    // Portfolio / trades
    updatePortfolioDisplay();
    if (state.currentTradesData.length > 0) {
        displayUserTrades(state.currentTradesData);
    }

    // Quick quote modal
    if (state.qqCurrentTea) {
        updateQuickQuoteLivePrice();
    }

    // Multi-chart panels
    updateMultiChartPrices();

    // Pairs table
    updatePairsTable();

    // Global ticker tape (includes tea prices)
    if (typeof updateGlobalTicker === 'function') updateGlobalTicker();

    // Check SL/TP and price alerts
    if (state.currentUser) {
        checkSlTpOrders();
    }
    checkPriceAlerts();
}

/**
 * Called by the Supabase Realtime channel for `market_state` row UPDATEs.
 * Merges macro indicator values into state and refreshes the display.
 */
function handleMacroUpdate(payload) {
    const row = payload.new;
    if (!row || !row.key) return;

    // Route metadata keys to dedicated state fields
    if (row.key === 'data_source') {
        state.dataSource = row.value;
        if (typeof updateDataSourceIndicator === 'function') updateDataSourceIndicator();
        return;
    }
    if (row.key === 'last_tick') {
        state.lastTick = row.value;
        return;
    }

    // Numeric macro indicators (forex, oil)
    state.macroIndicators[row.key] = row.value;

    // Refresh displays
    if (typeof updateMacroIndicators === 'function') updateMacroIndicators();
    if (typeof updateGlobalTicker === 'function') updateGlobalTicker();
}

/**
 * Start Realtime subscriptions for teas and market_state.
 * Called once during app bootstrap (from app.js).
 */
function startTickerSubscription() {
    // Subscribe to tea price updates
    state.tickerSubscription = subscribeToTicker(handleTickerUpdate);

    // Subscribe to macro indicator updates
    state.macroSubscription = subscribeToMacro(handleMacroUpdate);

    console.log('Realtime ticker subscriptions started');
}

/**
 * Load initial macro indicator values from the market_state table.
 */
async function loadMarketState() {
    try {
        const { data, error } = await apiFetchMarketState();
        if (error) throw error;
        if (data) {
            data.forEach(row => {
                if (row.key === 'data_source') {
                    state.dataSource = row.value;
                } else if (row.key === 'last_tick') {
                    state.lastTick = row.value;
                } else {
                    state.macroIndicators[row.key] = row.value;
                }
            });
        }
        // Render initial values
        if (typeof updateMacroIndicators === 'function') updateMacroIndicators();
        if (typeof updateDataSourceIndicator === 'function') updateDataSourceIndicator();
        if (typeof updateGlobalTicker === 'function') updateGlobalTicker();
    } catch (e) {
        console.error('Failed to load market state:', e);
    }
}

// =============================================
// PRICE ALERTS
// =============================================

function openPriceAlertModal(symbol, currentPrice) {
    state.currentAlertSymbol = symbol;
    const modal = document.getElementById('price-alert-modal');
    const existing = state.priceAlerts[symbol];

    document.getElementById('alert-symbol').textContent = symbol;
    document.getElementById('alert-current-price').textContent = `Current: $${currentPrice.toFixed(2)}`;
    document.getElementById('alert-below').value = existing?.below || '';
    document.getElementById('alert-above').value = existing?.above || '';
    document.getElementById('alert-delete-btn').style.display = existing ? 'block' : 'none';

    modal.classList.add('active');
}

function closePriceAlertModal() {
    document.getElementById('price-alert-modal').classList.remove('active');
    state.currentAlertSymbol = null;
}

function savePriceAlert() {
    if (!state.currentAlertSymbol) return;

    const below = document.getElementById('alert-below').value ? parseFloat(document.getElementById('alert-below').value) : null;
    const above = document.getElementById('alert-above').value ? parseFloat(document.getElementById('alert-above').value) : null;

    if (!below && !above) {
        delete state.priceAlerts[state.currentAlertSymbol];
        showToast('Alert Removed', `Price alert for ${state.currentAlertSymbol} cleared`);
    } else {
        state.priceAlerts[state.currentAlertSymbol] = { below, above };
        const alertText = [];
        if (below) alertText.push(`Below $${below.toFixed(2)}`);
        if (above) alertText.push(`Above $${above.toFixed(2)}`);
        showToast('Alert Set!', `${state.currentAlertSymbol}: ${alertText.join(' | ')}`);

        requestNotificationPermission();
    }

    closePriceAlertModal();
    updateAuctionTable();
}

function deletePriceAlert() {
    if (!state.currentAlertSymbol) return;
    delete state.priceAlerts[state.currentAlertSymbol];
    showToast('Alert Deleted', `Price alert for ${state.currentAlertSymbol} removed`);
    closePriceAlertModal();
    updateAuctionTable();
}

async function checkPriceAlerts() {
    for (const symbol of Object.keys(state.priceAlerts)) {
        const alert = state.priceAlerts[symbol];

        const displayData = teaDisplayData[symbol];
        const priceSymbol = displayData?.priceFrom || symbol;
        const tea = state.teas.find(t => t.symbol === priceSymbol);

        if (!tea) continue;

        const currentPrice = tea.current_price;
        let triggered = false;
        let triggerText = '';

        if (alert.below && currentPrice <= alert.below) {
            triggered = true;
            triggerText = `${symbol} dropped below $${alert.below.toFixed(2)}`;
        } else if (alert.above && currentPrice >= alert.above) {
            triggered = true;
            triggerText = `${symbol} rose above $${alert.above.toFixed(2)}`;
        }

        if (triggered) {
            delete state.priceAlerts[symbol];

            showToast('\uD83D\uDD14 Price Alert!', `${triggerText} - Now at $${currentPrice.toFixed(2)}`);

            if ('Notification' in window && Notification.permission === 'granted') {
                new Notification('TeaTrade Price Alert', {
                    body: triggerText,
                    icon: '/favicon.ico'
                });
            }

            updateAuctionTable();
        }
    }
}

function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

// =============================================
// MARKET STATUS (unified — driven by data_source + staleness)
// =============================================

const STALE_THRESHOLD_MS = 120000; // 2 minutes before we consider the feed dead

function updateMarketStatus() {
    // Delegate to the data-source indicator which is the single source of truth
    if (typeof updateDataSourceIndicator === 'function') {
        updateDataSourceIndicator();
    }
}

setInterval(updateMarketStatus, 15000);

// =============================================
// CHART UPDATES (driven by Realtime events)
// =============================================

function updateChartsWithNewPrices() {
    // Update main chart
    if (state.chartData && state.chartData.length > 0) {
        let newPrice = null;

        if (state.mainChartData.isTea) {
            const tea = state.teas?.find(t => t.symbol === state.mainChartData.symbol);
            newPrice = tea?.current_price;
        } else if (state.mainChartData.isIndex || state.mainChartData.symbol) {
            const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
            const idx = indexes.find(i => i.symbol === state.mainChartData.symbol);
            newPrice = idx?.price || state.mainChartData.basePrice;
        }

        if (newPrice && newPrice > 0) {
            appendPriceToChart(state.chartData, newPrice);
            state.mainChartData.basePrice = newPrice;

            const priceEl = document.getElementById('main-chart-price');
            if (priceEl) {
                priceEl.textContent = formatIndexPrice(newPrice, state.mainChartData.currency || '$');
            }

            drawChart();
        }
    }

    // Update hub chart if panel is open
    if (state.hubChartData && state.hubChartData.length > 0 && state.maximizedPanel?.classList.contains('panel-maximized')) {
        const symbol = document.getElementById('hub-buy-symbol')?.value;
        if (symbol) {
            const lookupSymbol = symbol === 'KENYAN' ? 'KENYA' : symbol;
            const isIndex = isIndexSymbol(lookupSymbol);

            let newPrice;
            if (isIndex) {
                const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
                const index = indexes.find(idx => idx.symbol === lookupSymbol);
                newPrice = index?.price;
            } else {
                const tea = state.teas?.find(t => t.symbol === symbol);
                newPrice = tea?.current_price;
            }

            if (newPrice && newPrice > 0) {
                appendPriceToChart(state.hubChartData, newPrice);
                drawHubChart();
            }
        }
    }
}

// =============================================
// SL/TP ORDER CHECKING
// =============================================

async function checkSlTpOrders() {
    for (const teaId of Object.keys(state.pendingSlTpOrders)) {
        const order = state.pendingSlTpOrders[teaId];
        const tea = state.teas.find(t => t.id === parseInt(teaId));
        if (!tea) continue;

        const currentPrice = tea.current_price;
        let triggered = false;
        let triggerType = '';

        if (order.side === 'BUY') {
            if (order.sl && currentPrice <= order.sl) {
                triggered = true;
                triggerType = 'Stop Loss';
            } else if (order.tp && currentPrice >= order.tp) {
                triggered = true;
                triggerType = 'Take Profit';
            }
        }

        if (triggered) {
            if (typeof executeSlTpClose === 'function') {
                await executeSlTpClose(parseInt(teaId), order, currentPrice, triggerType);
            } else {
                console.warn('executeSlTpClose not available — trading module not loaded yet');
            }
        }
    }
}

// =============================================
// TRADE FORM FOCUS TRACKING
// =============================================

document.addEventListener('DOMContentLoaded', () => {
    const tradeFormInputs = ['trade-tea-select', 'trade-qty', 'trade-price', 'sl-input', 'tp-input'];
    tradeFormInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('focus', () => { state.isTradeFormActive = true; });
            el.addEventListener('blur', () => {
                setTimeout(() => {
                    const activeEl = document.activeElement;
                    if (!tradeFormInputs.includes(activeEl?.id)) {
                        state.isTradeFormActive = false;
                    }
                }, 100);
            });
        }
    });
});
