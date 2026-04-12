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
// INDEX LOOKUP HELPER
// =============================================

const _IDX_ALIASES = {
    'KENYA': 'MOMBASA', 'MOMBASA': 'KENYA',
    'INDIA': 'KOLKATA', 'KOLKATA': 'INDIA',
    'CEYLON': 'COLOMBO', 'COLOMBO': 'CEYLON',
    'ASIA': 'FUTURES', 'FUTURES': 'ASIA',
    'INDONESIA': 'JAKARTA', 'JAKARTA': 'INDONESIA',
    'BANGLADESH': 'CHITTAGONG', 'CHITTAGONG': 'BANGLADESH',
    'MALAWI': 'LIMBE', 'LIMBE': 'MALAWI',
};

const _CARD_TO_INDEX = {
    'MOMBASA': 'KENYA', 
    'KOLKATA': 'INDIA', 
    'COLOMBO': 'CEYLON', 
    'JAKARTA': 'INDONESIA', 
    'CHITTAGONG': 'BANGLADESH', 
    'LIMBE': 'MALAWI', 
    'FUTURES': 'ASIA',
    'KENYAN': 'KENYA' // Handle legacy 'KENYAN'
};

function _findIndexDef(symbol) {
    const db = state.dbIndexes?.length ? state.dbIndexes : [];
    const all = [...db];
    for (const d of defaultDbIndexes) {
        if (!all.some(m => m.symbol === d.symbol)) all.push(d);
    }
    return all.find(i => i.symbol === symbol)
        || all.find(i => i.symbol === (_IDX_ALIASES[symbol] || symbol))
        || null;
}

function _allIndexDefs() {
    const db = state.dbIndexes?.length ? state.dbIndexes : [];
    const all = [...db];
    for (const d of defaultDbIndexes) {
        if (!all.some(m => m.symbol === d.symbol)) all.push(d);
    }
    return all;
}

// =============================================
// PRICE DATA CACHE
// =============================================

async function getPriceHistory(symbol, symbolType = 'tea', forcedTimeframe = null) {
    const tf = forcedTimeframe || state.currentTimeframe || '1D';
    const cacheKey = (symbolType === 'index' ? `INDEX_${symbol}` : symbol) + `_${tf}`;

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
            const dbData = await loadChartDataFromHistory(symbol, symbolType, tf);

            if (dbData && dbData.length >= 1) {
                state.priceDataCache.data[cacheKey] = dbData;
            } else {
                state.priceDataCache.data[cacheKey] = [];
            }
            // Always mark as loaded to prevent infinite retry loops on new assets
            state.priceDataCache.loaded[cacheKey] = true;
            state.priceDataCache.lastUpdate[cacheKey] = Date.now();
            return state.priceDataCache.data[cacheKey];

        } finally {
            delete state.priceDataCache.loading[cacheKey];
        }
    })();

    return state.priceDataCache.loading[cacheKey];
}

// Synchronous version — returns cached data or empty array
function getPriceHistorySync(symbol, symbolType = 'tea', forcedTimeframe = null) {
    const tf = forcedTimeframe || state.currentTimeframe || '1D';
    const cacheKey = (symbolType === 'index' ? `INDEX_${symbol}` : symbol) + `_${tf}`;

    if (state.priceDataCache.data[cacheKey] && state.priceDataCache.data[cacheKey].length > 0) {
        return state.priceDataCache.data[cacheKey];
    }

    // Trigger async load in background
    getPriceHistory(symbol, symbolType, forcedTimeframe).catch(() => { });

    return [];
}

// Update the unified cache with a new price tick (called when prices change)
function updatePriceCache(symbol, newPrice, symbolType = 'tea') {
    const tf = state.currentTimeframe || '1D';
    const cacheKey = (symbolType === 'index' ? `INDEX_${symbol}` : symbol) + `_${tf}`;

    // Ensure the cache array exists
    if (!state.priceDataCache.data[cacheKey]) {
        state.priceDataCache.data[cacheKey] = [];
    }
    const data = state.priceDataCache.data[cacheKey];

    // If cache is empty, seed it with the first live-tick candle.
    // Do NOT set lastUpdate here — that field is reserved for DB loads.
    // Leaving it unset forces getPriceHistory to still do its DB query
    // even though we have a single seeded candle, so historical data
    // is loaded correctly (fixing blank charts on first card click).
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

    // Load all tea symbols (force 1D for fast UI/sparklines on load)
    if (state.teas && state.teas.length > 0) {
        state.teas.forEach(tea => {
            loadPromises.push(getPriceHistory(tea.symbol, 'tea', '1D'));
        });
    }

    // Load all index symbols from DB (force 1D for fast UI/sparklines on load)
    getIndexSymbols().forEach(symbol => {
        loadPromises.push(getPriceHistory(symbol, 'index', '1D'));
    });

    await Promise.allSettled(loadPromises);
    console.log('Price cache initialized');
}

// =============================================
// CHART DATA FROM DATABASE
// =============================================

// Timeframe → candle interval (minutes) and lookback window
// Limits are sized for the split-query strategy in apiFetchPriceHistory:
//   • Simulated rows : 1 row/day  → trivial for any window
//   • Live rows      : 1 row/5 min (market-ticker now writes every 5 min)
// The limit passed to apiFetchPriceHistory caps the live-rows query (5 000).
// These per-timeframe limits are kept for the convertToOHLC call only.
const TIMEFRAME_CONFIG = {
    '1D': { interval: 5, hoursBack: 24, limit: 100 },
    '1W': { interval: 60, hoursBack: 168, limit: 5000 },
    '1M': { interval: 240, hoursBack: 720, limit: 5000 },
    '3M': { interval: 1440, hoursBack: 2160, limit: 5000 },
    '1Y': { interval: 1440, hoursBack: 8760, limit: 5000 },
    'ALL': { interval: 10080, hoursBack: null, limit: 10000 }
};

// Load chart data from database with timeframe-aware filtering.
// When the primary time window yields too few candles, progressively widens
// the window so the chart always has meaningful data to render.
async function loadChartDataFromHistory(symbol, symbolType = 'tea', timeframeOverride = null) {
    const tf = timeframeOverride || state.currentTimeframe || '1D';
    const cfg = TIMEFRAME_CONFIG[tf] || TIMEFRAME_CONFIG['1D'];

    const _sinceFromHours = h => h ? new Date(Date.now() - h * 3600000).toISOString() : null;
    let since = _sinceFromHours(cfg.hoursBack);

    const idxDef = symbolType === 'index' ? _findIndexDef(symbol) : null;

    // Attempt load at the requested window first, then widen if too sparse.
    // Wider windows re-use the same OHLC interval so candle size stays consistent.
    const windows = [since];
    if (cfg.hoursBack) {
        windows.push(_sinceFromHours(cfg.hoursBack * 4));   // 4× wider
        windows.push(null);                                   // all-time fallback
    }

    let result = null;
    for (const win of windows) {
        if (idxDef?.teas?.length) {
            const compositeCandles = await _loadCompositeIndexOHLC(idxDef.teas, cfg, win);
            if (compositeCandles && compositeCandles.length >= 1) { result = compositeCandles; break; }
        }

        const rawData = await loadPriceHistory(symbol, cfg.limit, win);
        if (rawData && rawData.length >= 2) {
            result = convertToOHLC(rawData, cfg.interval);
            break;
        }
    }

    if (!result || result.length === 0) return null;

    // Legacy logic used to forward-fill flat candles to "now".
    // TradingView handles current-time tracking without needing padding candles.
    return result;
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

async function _loadCompositeIndexOHLC(teaSymbols, cfg, since) {
    const allRows = await Promise.all(
        teaSymbols.map(sym => loadPriceHistory(sym, cfg.limit, since))
    );

    const intervalMs = cfg.interval * 60000;

    // Combine all ticks into a single array
    const allTicks = [];
    allRows.forEach((rows, teaIdx) => {
        if (!rows) return;
        rows.forEach(tick => {
            allTicks.push({ time: new Date(tick.recorded_at).getTime(), teaIdx, price: tick.price });
        });
    });

    if (allTicks.length === 0) return null;

    // Group ticks exactly by their millisecond timestamp
    const timeGroups = {};
    for (const t of allTicks) {
        if (!timeGroups[t.time]) timeGroups[t.time] = [];
        timeGroups[t.time].push(t);
    }
    const uniqueTimes = Object.keys(timeGroups).map(Number).sort((a, b) => a - b);

    // Track the last known price for each tea to compute rolling cross-tea averages
    const lastKnown = new Array(teaSymbols.length).fill(null);
    const averagedTicks = [];

    // Pre-fill lastKnown with the earliest available price for each tea
    for (const time of uniqueTimes) {
        const ticks = timeGroups[time];
        for (const t of ticks) {
            if (lastKnown[t.teaIdx] === null) {
                lastKnown[t.teaIdx] = t.price;
            }
        }
        // Once we've seen at least one price for everything, break
        if (!lastKnown.includes(null)) break;
    }

    // Now walk through chronologically and generate a single average price point per timestamp
    for (const time of uniqueTimes) {
        const ticks = timeGroups[time];

        // Update all teas that had a tick at this exact timestamp simultaneously
        for (const t of ticks) {
            lastKnown[t.teaIdx] = t.price;
        }

        // Compute average of all currently known tea prices
        let sum = 0;
        let totalVol = 0;
        for (let i = 0; i < lastKnown.length; i++) {
            if (lastKnown[i] !== null && lastKnown[i] > 0) {
                const teaSymbol = teaSymbols[i];
                const tea = state.teas?.find(t => t.symbol === teaSymbol);
                let vol = tea ? (tea.volume_24h || 0) : 0;

                // Fallback to static volume weights if live volume hasn't loaded yet
                if (vol <= 0) {
                    vol = typeof teaDisplayData !== 'undefined' && teaDisplayData[teaSymbol]
                        ? (teaDisplayData[teaSymbol].qty || 10000)
                        : 10000;
                }

                if (vol > 0) {
                    sum += (lastKnown[i] * vol);
                    totalVol += vol;
                }
            }
        }

        if (totalVol > 0) {
            averagedTicks.push({ time: time, price: sum / totalVol });
        } else {
            // Ultimate fallback to simple average (should rarely hit this now)
            let sSum = 0;
            let sCount = 0;
            for (let i = 0; i < lastKnown.length; i++) {
                if (lastKnown[i] !== null && lastKnown[i] > 0) {
                    sSum += lastKnown[i];
                    sCount++;
                }
            }
            if (sCount > 0) {
                averagedTicks.push({ time: time, price: sSum / sCount });
            }
        }
    }

    // Group the averaged series into candles
    const candles = [];
    let currentBucket = null;
    let bucketData = [];

    averagedTicks.forEach(tick => {
        const bucketStart = Math.floor(tick.time / intervalMs) * intervalMs;

        if (currentBucket !== bucketStart) {
            if (bucketData.length > 0) {
                let high = Math.max(...bucketData);
                let low = Math.min(...bucketData);
                
                if (bucketData.length === 1 && high === low) {
                    high = high * 1.002;
                    low = low * 0.998;
                }

                candles.push({
                    date: new Date(currentBucket),
                    open: bucketData[0],
                    high: high,
                    low: low,
                    close: bucketData[bucketData.length - 1],
                    volume: 0
                });
            }
            currentBucket = bucketStart;
            bucketData = [];
        }
        bucketData.push(tick.price);
    });

    if (bucketData.length > 0) {
        let high = Math.max(...bucketData);
        let low = Math.min(...bucketData);
        
        if (bucketData.length === 1 && high === low) {
            high = high * 1.002;
            low = low * 0.998;
        }

        candles.push({
            date: new Date(currentBucket),
            open: bucketData[0],
            high: high,
            low: low,
            close: bucketData[bucketData.length - 1],
            volume: 0
        });
    }

    if (candles.length < 1) return null;
    // Note: We deliberately DONT force Open = Previous Close.
    // TradingView handles gaps naturally. Forcing gap closures generates artificially massive wicks.
    return _fillCandleGaps(candles, intervalMs);
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
                const open = prices[0];
                const close = prices[prices.length - 1];
                let high = Math.max(...prices);
                let low = Math.min(...prices);

                // If only 1 tick exists, TradingView renders an invisible flat line.
                // Apply a tiny simulated wick to give the candle visible structure on sparse timeframes (like 1Y).
                if (prices.length === 1 && high === low) {
                    high = high * 1.002;
                    low = low * 0.998;
                }

                candles.push({
                    date: new Date(currentBucket),
                    open: open,
                    high: high,
                    low: low,
                    close: close,
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
        const open = prices[0];
        const close = prices[prices.length - 1];
        let high = Math.max(...prices);
        let low = Math.min(...prices);

        if (prices.length === 1 && high === low) {
            high = high * 1.002;
            low = low * 0.998;
        }

        candles.push({
            date: new Date(currentBucket),
            open: open,
            high: high,
            low: low,
            close: close,
            volume: bucketData.reduce((sum, d) => sum + (d.volume || 0), 0)
        });
    }

    return _fillCandleGaps(candles, intervalMs);
}

function _fillCandleGaps(candles, intervalMs) {
    // Forward-fill missing candles so the chart doesn't display as choppy/gapped.
    // For daily candles (1440 min), skip weekends (Sat/Sun) since markets are closed.
    // For shorter intervals, fill all gaps.
    if (!candles || candles.length < 2) return candles;

    const isDailyOrLarger = intervalMs >= 1440 * 60000;
    const filled = [candles[0]];

    for (let i = 1; i < candles.length; i++) {
        const prev = candles[i - 1];
        const curr = candles[i];
        const prevTime = prev.date.getTime();
        const currTime = curr.date.getTime();
        const gap = currTime - prevTime;

        // Fill missing intervals between prev and curr
        if (gap > intervalMs * 1.5) {
            let fillTime = prevTime + intervalMs;
            const lastClose = prev.close;
            while (fillTime < currTime - intervalMs * 0.5) {
                const fillDate = new Date(fillTime);
                // Skip weekends for daily+ candles
                if (isDailyOrLarger) {
                    const day = fillDate.getUTCDay();
                    if (day === 0 || day === 6) {
                        fillTime += intervalMs;
                        continue;
                    }
                }
                filled.push({
                    date: fillDate,
                    open: lastClose,
                    high: lastClose * 1.001,
                    low: lastClose * 0.999,
                    close: lastClose,
                    volume: 0
                });
                fillTime += intervalMs;
            }
        }
        filled.push(curr);
    }

    return filled;
}

// Seed a chart array with a first candle if empty, otherwise append.
function _seedOrAppendChart(stateObj, key, price) {
    if (!stateObj[key]) stateObj[key] = [];
    if (stateObj[key].length === 0) {
        const now = new Date();
        stateObj[key].push({
            date: new Date(Math.floor(now.getTime() / 3600000) * 3600000),
            open: price, high: price, low: price, close: price, volume: 0
        });
    } else {
        appendPriceToChart(stateObj[key], price);
    }
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

// Update all market index displays with real calculated prices
function updateAllMarketIndexes() {
    const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
    if (!indexes || indexes.length === 0) return;

    const _getLiveMultiplier = (sourceObj) => {
        if (sourceObj && sourceObj.forexKey && state.macroIndicators[sourceObj.forexKey]) {
            return Number(state.macroIndicators[sourceObj.forexKey]) || sourceObj.multiplier || 1;
        }
        return sourceObj?.multiplier || 1;
    };

    const idxMap = {};
    indexes.forEach(idx => idxMap[idx.symbol] = idx);

    // Update main chart if it's showing an index
    const mainIdxSym = _CARD_TO_INDEX[state.mainChartData.symbol] || state.mainChartData.symbol;
    if (idxMap[mainIdxSym]) {
        const _idx = idxMap[mainIdxSym];
        const forexSource = state.mainChartData.forexKey ? state.mainChartData : _idx;
        state.mainChartData.basePrice = _idx.price * _getLiveMultiplier(forexSource);
        state.mainChartData.change = _idx.change;
    }

    // Update card data
    cardData.forEach((card, i) => {
        const idx = idxMap[card.symbol];
        if (idx) {
            const forexSource = card.forexKey ? card : idx;
            card.basePrice = idx.price * _getLiveMultiplier(forexSource);
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
        changeEl.style.color = chg >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
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

    // Incrementally update index price caches (do NOT wipe history).
    Object.entries(idxMap).forEach(([symbol]) => {
        // Fix: Assign the correct calculated index price to usdPrice
        const usdPrice = idxMap[symbol].price;
        if (usdPrice && usdPrice > 0) {
            updatePriceCache(symbol, usdPrice, 'index');
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
        state.mainChartData = { ...clickedCardData, isIndex: true, isTea: false };
        if (typeof updateMobileTradePrices === 'function') updateMobileTradePrices();
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
        if (mainChangeEl) {
            mainChangeEl.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%`;
            mainChangeEl.style.color = chg >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
        }
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
        // Clear Y-axis cache so the new instrument rescales from its own data
        if (window.mainYAxisCache) window.mainYAxisCache = {};

        // Invalidate price cache for the new symbol (all timeframes)
        if (state.priceDataCache) {
            const _base = `INDEX_${state.mainChartData.symbol}`;
            Object.keys(state.priceDataCache.data || {}).forEach(k => {
                if (k === _base || k.startsWith(_base + '_')) {
                    delete state.priceDataCache.data[k];
                    delete state.priceDataCache.lastUpdate[k];
                    delete state.priceDataCache.loaded[k];
                }
            });
        }

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
        ? state.dbIndexes
        : defaultDbIndexes;

    return indexes.map(idx => {
        let count = 0;
        let sum = 0;
        let prevCount = 0;
        let prevSum = 0;
        let totalVol = 0;

        idx.teas.forEach(s => {
            const tea = teaMap[s];
            if (tea && tea.current_price > 0 && tea.volume_24h > 0) {
                sum += (tea.current_price * tea.volume_24h);
                totalVol += tea.volume_24h;

                if (tea.previous_price > 0) {
                    prevSum += (tea.previous_price * tea.volume_24h);
                }
            }
        });

        // Volume-weighted average calculation
        const avgPrice = totalVol > 0 ? (sum / totalVol) : 0;
        const avgPrevPrice = totalVol > 0 && prevSum > 0 ? (prevSum / totalVol) : avgPrice;
        const change = avgPrevPrice > 0 ? ((avgPrice - avgPrevPrice) / avgPrevPrice) * 100 : 0;

        return {
            ...idx,
            price: avgPrice,
            previousPrice: avgPrevPrice,
            change: change,
            isIndex: true,
            volume: totalVol
        };
    });
}

// Update main chart display with real-time data from tea prices
function updateMainChartWithRealData() {
    if (!state.teas || state.teas.length === 0) return;

    const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
    const resolvedMainSym = _CARD_TO_INDEX[state.mainChartData.symbol] || state.mainChartData.symbol;
    const targetIndex = indexes.find(idx => idx.symbol === resolvedMainSym);

    if (targetIndex) {
        const forexSource = state.mainChartData.forexKey ? state.mainChartData : targetIndex;
        let activeMultiplier = forexSource?.multiplier || 1;
        if (forexSource?.forexKey && state.macroIndicators?.[forexSource.forexKey]) {
            activeMultiplier = Number(state.macroIndicators[forexSource.forexKey]) || activeMultiplier;
        }

        const calculatedPrice = targetIndex.price * activeMultiplier;
        
        state.mainChartData.basePrice = calculatedPrice;
        state.mainChartData.change = targetIndex.change;

        const priceEl = document.getElementById('main-chart-price');
        const changeEl = document.getElementById('main-chart-change');
        const curr = state.mainChartData.currency || '$';

        if (priceEl) {
            priceEl.textContent = formatIndexPrice(calculatedPrice, curr, state.mainChartData.symbol);
            priceEl.className = 'chart-stat-value ' + (targetIndex.change >= 0 ? 'up' : 'down');
            
            const labelEl = priceEl.nextElementSibling;
            if (labelEl && labelEl.classList.contains('chart-stat-label')) {
                const codeMap = { '₹': 'INR', 'Rs': 'LKR', 'Rp': 'IDR', '৳': 'BDT' };
                const currencyCode = codeMap[curr] || 'USD';
                labelEl.textContent = `Last Trade Price (${currencyCode}/kg)`;
            }
        }

        if (changeEl) {
            const chg = targetIndex.change >= 0 ? `+${targetIndex.change.toFixed(2)}` : targetIndex.change.toFixed(2);
            changeEl.textContent = `${chg}%`;
            changeEl.className = 'chart-stat-value ' + (targetIndex.change >= 0 ? 'up' : 'down');
        }

        // Force the chart to redraw if the latest live price updated
        if (typeof drawChart === 'function') {
            drawChart();
        }
    }
}

function updateMainChartStats() {
    const priceEl = document.getElementById('main-chart-price');
    const changeEl = document.getElementById('main-chart-change');

    if (priceEl && state.mainChartData) {
        const price = Number(state.mainChartData.basePrice) || 0;
        const change = Number(state.mainChartData.change) || 0;
        const isUp = change >= 0;
        const curr = state.mainChartData.currency || '$';

        priceEl.textContent = formatIndexPrice(price, curr, state.mainChartData.symbol);
        priceEl.className = 'chart-stat-value ' + (isUp ? 'up' : 'down');

        const labelEl = priceEl.nextElementSibling;
        if (labelEl && labelEl.classList.contains('chart-stat-label')) {
            const codeMap = { '₹': 'INR', 'Rs': 'LKR', 'Rp': 'IDR', '৳': 'BDT' };
            const currencyCode = codeMap[curr] || 'USD';
            labelEl.textContent = `Last Trade Price (${currencyCode}/kg)`;
        }

        if (changeEl) {
            const changeAmt = (price * change / 100).toFixed(2);
            changeEl.textContent = `${isUp ? '+' : ''}${curr}${changeAmt} (${isUp ? '+' : ''}${change.toFixed(1)}%)`;
            changeEl.style.color = isUp ? 'var(--accent-green)' : 'var(--accent-red)';
        }
    }

    syncMobileHeader();
}

function syncMobileHeader() {
    const d = state.mainChartData;
    if (!d) return;

    const curr = d.currency || '$';
    const price = Number(d.basePrice) || 0;
    const change = Number(d.change) || 0;
    const isUp = change >= 0;
    const m = state.chartMetrics || {};

    const sym = document.getElementById('mobile-trade-tea-select');
    const priceEl = document.getElementById('mobile-header-price');
    const changeEl = document.getElementById('mobile-header-change');
    const volEl = document.getElementById('mobile-header-vol');
    const highEl = document.getElementById('mobile-header-high');
    const lowEl = document.getElementById('mobile-header-low');

    // Update the dropdown selection to match the currently viewed asset
    if (sym) {
        let valToSelect = null;
        if (d.isIndex) {
            valToSelect = 'INDEX_' + (d.symbol === 'KENYAN' ? 'KENYA' : d.symbol);
        } else {
            const t = state.teas?.find(x => x.symbol === d.symbol);
            if (t) valToSelect = String(t.id);
        }

        if (valToSelect && sym.querySelector(`option[value="${valToSelect}"]`)) {
            sym.value = valToSelect;
        }
    }

    if (priceEl) priceEl.textContent = formatIndexPrice(price, curr, d.symbol);
    if (changeEl) {
        const pct = `${isUp ? '+' : ''}${change.toFixed(2)}%`;
        changeEl.textContent = pct;
        changeEl.classList.toggle('negative', !isUp);
    }
    if (volEl) volEl.textContent = d.volume || '—';
    if (highEl) highEl.textContent = m.highPrice ? `${curr}${m.highPrice.toFixed(2)}` : '—';
    if (lowEl) lowEl.textContent = m.lowPrice ? `${curr}${m.lowPrice.toFixed(2)}` : '—';
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
        // Keep today's open as previous_price (set by loadTeas); don't overwrite with last tick
        if (!state.teas[idx].previous_price || state.teas[idx].previous_price <= 0) {
            state.teas[idx].previous_price = state.teas[idx].current_price;
        }
        state.teas[idx].current_price = updated.current_price;
        if (updated.price_change_24h != null) state.teas[idx].price_change_24h = updated.price_change_24h;
        if (updated.last_update) state.teas[idx].last_update = updated.last_update;
        if (updated.anchor_price) state.teas[idx].anchor_price = updated.anchor_price;
        if (updated.reference_forex) state.teas[idx].reference_forex = updated.reference_forex;
        if (updated.volume_24h != null) state.teas[idx].volume_24h = updated.volume_24h;

        const symbol = state.teas[idx].symbol;
        const newPrice = updated.current_price;

        // FIX: Push new price into the unified price cache (candle history)
        updatePriceCache(symbol, newPrice, 'tea');

        // FIX: If this symbol is currently displayed on any chart, push the
        // price directly into the active chart data array and redraw immediately
        // — without waiting for the debounce batch.
        _pushPriceToActiveCharts(symbol, newPrice);
    }

    // Debounce: the Edge Function updates N teas at once; batch them
    clearTimeout(_tickerDebounceTimer);
    _tickerDebounceTimer = setTimeout(onTickerBatchComplete, TICKER_DEBOUNCE_MS);
}

/**
 * Resolve the symbol currently shown on the main chart.
 * Returns the symbol string (e.g. 'KENYA', 'KEN-BP1') or null.
 */
function _getMainChartSymbol() {
    const sym = state.mainChartData?.symbol;
    if (!sym) return null;
    return _CARD_TO_INDEX[sym] || sym;
}

/**
 * Resolve whether the main chart is showing a 'tea' or 'index'.
 */
function _getMainChartSymbolType() {
    if (state.mainChartData?.isTea) return 'tea';
    if (state.mainChartData?.isIndex) return 'index';
    const sym = state.mainChartData?.symbol;
    if (sym && typeof isIndexSymbol === 'function') return isIndexSymbol(sym) ? 'index' : 'tea';
    return 'index';
}

/**
 * Compute a live index price from current state.teas values.
 * Returns null if the index can't be resolved or has no valid teas.
 */
function _liveIndexPrice(indexSymbol) {
    const idxDef = _findIndexDef(indexSymbol);
    if (!idxDef?.teas?.length) return null;
    const teaMap = {};
    state.teas.forEach(t => { teaMap[t.symbol] = t; });

    let sum = 0;
    let totalVol = 0;

    idxDef.teas.forEach(s => {
        const tea = teaMap[s];
        if (tea && tea.current_price > 0 && tea.volume_24h > 0) {
            sum += (tea.current_price * tea.volume_24h);
            totalVol += tea.volume_24h;
        }
    });

    if (totalVol === 0) return null;
    return sum / totalVol;
}

/**
 * When a real-time tick arrives for `symbol` (a tea), push the new price
 * into every live chart's state array (chartData, hubChartData, etc.).
 * This function ONLY mutates state — it never calls draw functions.
 * Rendering is batched via updateChartsWithNewPrices() (debounced).
 */
function _pushPriceToActiveCharts(symbol, newPrice) {
    // NOTE: state.chartData is populated exclusively by generateChartData() in drawChart(),
    // which reads from priceDataCache via getPriceHistorySync(). We must NOT independently
    // push to state.chartData here — doing so causes every tick to insert the same candle
    // twice (once from priceDataCache + once from this direct push), producing duplicate
    // timestamps that TradingView rejects with errors.
    //
    // updatePriceCache() (called just before this in handleTickerUpdate) already updated
    // priceDataCache. That is the single source of truth for the main chart.
    //
    // We only update index price caches here (for indexes dependent on this tea tick).

    const mainSymbol = _getMainChartSymbol();
    const mainType = _getMainChartSymbolType();

    if (mainType === 'index') {
        const idxDef = _findIndexDef(mainSymbol);
        if (idxDef?.teas?.includes(symbol)) {
            const idxPrice = _liveIndexPrice(mainSymbol);
            if (idxPrice > 0) {
                // Update the index's own priceDataCache — drawChart will read this.
                updatePriceCache(mainSymbol, idxPrice, 'index');
            }
        }
    }

    // ── Hub fullscreen chart: update index priceDataCache on every tick ──
    // Previously gated on panel-maximized, which meant the hub chart would NOT
    // receive live price updates if the panel was opened after a period of ticks.
    // Always update the cache so that when the user opens fullscreen, the data is fresh.
    const hubRaw = document.getElementById('hub-buy-symbol')?.value || '';
    if (hubRaw) {
        const _cardMap = { 'KENYAN': 'KENYA' };
        const hubSymbol = _cardMap[hubRaw] || hubRaw;
        const hubIsIdx = typeof isIndexSymbol === 'function' && isIndexSymbol(hubSymbol);

        if (hubIsIdx) {
            const idxDef = _findIndexDef(hubSymbol);
            if (idxDef?.teas?.includes(symbol)) {
                const idxPrice = _liveIndexPrice(hubSymbol);
                if (idxPrice > 0) {
                    updatePriceCache(hubSymbol, idxPrice, 'index');
                }
            }
        } else if (hubSymbol === symbol) {
            // For tea charts: push tea's own new price into hub chart cache too
            updatePriceCache(hubSymbol, newPrice, 'tea');
        }
    }

    // ── Quick-quote modal: this reads/writes priceDataCache directly, which is correct ──
    const qqModal = document.getElementById('quick-quote-modal');
    if (state.qqCurrentTea && qqModal?.classList.contains('active')) {
        const qqSym = state.qqCurrentTea.symbol;
        const qqIsIdx = state.qqCurrentTea.isIndex;
        let qqPrice = null;

        if (!qqIsIdx && qqSym === symbol) {
            qqPrice = newPrice;
        } else if (qqIsIdx) {
            const idxDef = _findIndexDef(qqSym);
            if (idxDef?.teas?.includes(symbol)) {
                qqPrice = _liveIndexPrice(qqSym);
            }
        }

        if (qqPrice && qqPrice > 0) {
            const _tf = state.currentTimeframe || '1D';
            const _qqCk = (qqIsIdx ? `INDEX_${qqSym}` : qqSym) + `_${_tf}`;
            if (state.priceDataCache?.data?.[_qqCk]?.length > 0) {
                appendPriceToChart(state.priceDataCache.data[_qqCk], qqPrice);
            }
            state.qqCurrentTea = { ...state.qqCurrentTea, current_price: qqPrice };
        }
    }
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

    // Keep the trade form's Ask/Bid price in sync with latest market price
    if (typeof updateTradeSummary === 'function') updateTradeSummary();
    if (typeof updateHubOrderPreview === 'function') updateHubOrderPreview();

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

    // Subscribe to live order-flow / market depth updates
    state.pressureSubscription = subscribeToMarketPressure(handleMarketPressureUpdate);

    // Seed depth bars immediately from DB snapshot (don't wait for first trade)
    loadMarketPressure();

    console.log('Realtime ticker subscriptions started (prices + macro + order flow)');
}

/**
 * Called whenever the market_pressure table row for any symbol changes.
 * Fires within ~100ms of a trade insert — much faster than the 5-min cron.
 *
 * Updates state.marketPressure and immediately redraws the market depth bars.
 */
function handleMarketPressureUpdate(payload) {
    const row = payload.new;
    if (!row || !row.symbol) return;

    state.marketPressure[row.symbol] = {
        buy5m: Number(row.buy_volume_5m) || 0,
        sell5m: Number(row.sell_volume_5m) || 0,
        buy30m: Number(row.buy_volume_30m) || 0,
        sell30m: Number(row.sell_volume_30m) || 0,
        tradeCount5m: Number(row.trade_count_5m) || 0,
        tradeCount30m: Number(row.trade_count_30m) || 0,
        lastSide: row.last_side,
        lastQty: Number(row.last_qty) || 0,
        updatedAt: row.updated_at,
    };

    // Immediately redraw market depth — this fires on every trade
    if (typeof updateMarketDepth === 'function') updateMarketDepth();
}

/**
 * Seed state.marketPressure from the DB on page load so depth bars
 * show real data before the first Realtime event arrives.
 */
async function loadMarketPressure() {
    try {
        const { data, error } = await apiFetchMarketPressure();
        if (error || !data) return;
        data.forEach(row => {
            state.marketPressure[row.symbol] = {
                buy5m: Number(row.buy_volume_5m) || 0,
                sell5m: Number(row.sell_volume_5m) || 0,
                buy30m: Number(row.buy_volume_30m) || 0,
                sell30m: Number(row.sell_volume_30m) || 0,
                tradeCount5m: Number(row.trade_count_5m) || 0,
                tradeCount30m: Number(row.trade_count_30m) || 0,
                lastSide: row.last_side,
                lastQty: Number(row.last_qty) || 0,
                updatedAt: row.updated_at,
            };
        });
        console.log(`📊 Market pressure seeded for ${data.length} symbol(s)`);
        if (typeof updateMarketDepth === 'function') updateMarketDepth();
    } catch (e) {
        console.warn('Could not load initial market pressure:', e.message);
    }
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

            // Snapshot the DB values as the session baseline.
            // The live forex feed will overwrite macroIndicators with fresh rates;
            // the % change shown in the macro panel will reflect drift vs the
            // last server tick rather than always showing 0%.
            const forexKeys = ['usd_kes', 'usd_inr', 'usd_lkr', 'usd_cny', 'brent_crude'];
            const baseline = {};
            forexKeys.forEach(k => {
                const v = Number(state.macroIndicators[k]);
                if (!isNaN(v) && v > 0) baseline[k] = v;
            });
            if (Object.keys(baseline).length > 0) {
                state.macroBaseline = baseline;
            }
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
// LIVE FOREX FEED (browser-direct, no cron dependency)
// =============================================

/**
 * Fetch the latest forex rates directly from the open exchange rate API.
 * Runs on page load and every FOREX_REFRESH_MS milliseconds.
 * This keeps macro indicators live independently of the server cron.
 * On the first successful call the values are snapshotted as
 * state.macroBaseline so the macro panel can show a meaningful
 * "change since session start" percentage.
 */
const FOREX_REFRESH_MS = 60_000; // 1 minute — free tier limit
let _forexRefreshTimer = null;

async function fetchLiveForex() {
    try {
        const resp = await fetch('https://open.er-api.com/v6/latest/USD');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data.result !== 'success' || !data.rates) throw new Error('bad shape');

        const r = data.rates;
        const incoming = {
            usd_kes: r.KES,
            usd_inr: r.INR,
            usd_lkr: r.LKR,
            usd_cny: r.CNY,
        };

        Object.entries(incoming).forEach(([key, val]) => {
            if (val != null && !isNaN(val)) state.macroIndicators[key] = val;
        });

        if (typeof updateMacroIndicators === 'function') updateMacroIndicators();
        if (typeof updateGlobalTicker === 'function') updateGlobalTicker();
        console.log(`💱 Live forex: KES ${r.KES?.toFixed(2)} | INR ${r.INR?.toFixed(2)} | LKR ${r.LKR?.toFixed(2)} | CNY ${r.CNY?.toFixed(4)}`);
    } catch (e) {
        console.warn('Live forex fetch failed (will retry):', e.message);
    }
}

/**
 * Fetch a live Brent crude price from Yahoo Finance chart API.
 * Falls back to the last DB value if unavailable.
 */
async function fetchLiveBrent() {
    try {
        const url = 'https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?interval=1d&range=5d';
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (!price || isNaN(price)) throw new Error('no price');

        state.macroIndicators['brent_crude'] = price;

        if (typeof updateMacroIndicators === 'function') updateMacroIndicators();
        if (typeof updateGlobalTicker === 'function') updateGlobalTicker();
        console.log(`🛢️  Live Brent crude: $${price.toFixed(2)}/bbl`);

        // Cache 5-day close history for the popout sparkline
        const result = data?.chart?.result?.[0];
        const timestamps = result?.timestamp ?? [];
        const closes = result?.indicators?.quote?.[0]?.close ?? [];
        if (timestamps.length > 0 && closes.length > 0) {
            const history = timestamps.map((ts, i) => ({
                date: new Date(ts * 1000).toISOString().split('T')[0],
                rate: closes[i] ?? null
            })).filter(d => d.rate != null);
            // Store in macro-popout cache so the sparkline picks it up
            if (typeof _macroHistoryCache !== 'undefined') {
                _macroHistoryCache['brent_crude'] = { fetchedAt: Date.now(), history };
            }
        }
    } catch (e) {
        console.warn('Live Brent fetch failed (will use DB value):', e.message);
    }
}

function startLiveForexFeed() {
    // Fetch forex and Brent concurrently on start
    fetchLiveForex();
    fetchLiveBrent();
    clearInterval(_forexRefreshTimer);
    _forexRefreshTimer = setInterval(() => {
        fetchLiveForex();
        fetchLiveBrent();
    }, FOREX_REFRESH_MS);
    console.log(`💱 Live forex + Brent feed started (refreshes every ${FOREX_REFRESH_MS / 1000}s)`);
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

// Safety-net refresh: if the Realtime subscription ever lags or drops a batch,
// a full teas reload every 5 minutes ensures state.teas never drifts more than
// 5 minutes behind the DB. This prevents the ">10% deviation" trade errors that
// occur when state.teas prices are stale vs actual DB prices.
setInterval(async () => {
    if (typeof loadTeas === 'function') {
        try {
            await loadTeas();
            updateAllMarketIndexes();
        } catch (e) {
            console.warn('Periodic teas refresh failed:', e.message);
        }
    }
}, 300_000); // every 5 minutes

// =============================================
// CHART UPDATES (driven by Realtime events)
// =============================================

/**
 * Called after the debounced ticker batch completes.
 * Updates DOM price/change displays AND redraws all active charts
 * exactly once per batch (main chart, hub chart, quick-quote chart).
 */
function updateChartsWithNewPrices() {
    // ── Main chart price display ──────────────────────────────────────────
    const mainSymbol = _getMainChartSymbol();
    const mainType = _getMainChartSymbolType();
    let mainPrice = null;

    if (mainType === 'tea' && mainSymbol) {
        const tea = state.teas?.find(t => t.symbol === mainSymbol);
        mainPrice = tea?.current_price;
    } else if (mainType === 'index' && mainSymbol) {
        const rawUsd = _liveIndexPrice(mainSymbol);
        if (rawUsd && rawUsd > 0) {
            const fk = state.mainChartData?.forexKey;
            let mult = (fk && state.macroIndicators?.[fk]) ? Number(state.macroIndicators[fk]) : 0;
            if (!mult || mult <= 0) {
                const _idxDef = _findIndexDef(mainSymbol);
                mult = _idxDef?.multiplier || 1;
            }
            mainPrice = rawUsd * mult;
        }
    }

    if (mainPrice && mainPrice > 0) {
        // Store the RAW USD price in basePrice so charts.js can apply the forex
        // multiplier itself (charts.js divides basePrice by _fx at render time).
        // For USD indexes, rawUsd === mainPrice so this is a no-op.
        const fkForStore = state.mainChartData?.forexKey;
        const multForStore = (fkForStore && state.macroIndicators?.[fkForStore])
            ? Number(state.macroIndicators[fkForStore]) : 1;
        const rawUsdForStore = multForStore > 1 ? mainPrice / multForStore : mainPrice;
        state.mainChartData.basePrice = rawUsdForStore > 0 ? rawUsdForStore : mainPrice;

        const priceEl = document.getElementById('main-chart-price');
        if (priceEl) {
            priceEl.textContent = formatIndexPrice(mainPrice, state.mainChartData.currency || '$');
        }
    }

    // ── Redraw all active charts exactly once per batch ────────────────────
    // FIX: The old guard checked for 'priceChart' (legacy canvas ID that no longer
    // exists). The app now uses TradingView via 'tv-chart', so guard against that instead.
    if (typeof drawChart === 'function' && document.getElementById('tv-chart')) {
        drawChart();
    }

    const hubSection = document.getElementById('chart-section');
    if (typeof drawHubChart === 'function' && hubSection?.classList.contains('panel-maximized')) {
        drawHubChart();
    }

    const qqModal = document.getElementById('quick-quote-modal');
    if (typeof drawQuickQuoteChart === 'function' && state.qqCurrentTea && qqModal?.classList.contains('active')) {
        drawQuickQuoteChart(state.qqCurrentTea);
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
