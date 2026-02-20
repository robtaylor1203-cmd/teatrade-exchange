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

            // Database empty or too sparse — store [] but with lastUpdate=0
            // so the very next call triggers a fresh DB fetch instead of
            // serving cached emptiness for 60 seconds.
            console.log(`Insufficient price history for ${cacheKey} (${dbData ? dbData.length : 0} candles) — will retry on next request`);
            state.priceDataCache.data[cacheKey] = [];
            state.priceDataCache.loaded[cacheKey] = false;
            state.priceDataCache.lastUpdate[cacheKey] = 0;
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
// Limits are sized for the split-query strategy in apiFetchPriceHistory:
//   • Simulated rows : 1 row/day  → trivial for any window
//   • Live rows      : 1 row/5 min (market-ticker now writes every 5 min)
// The limit passed to apiFetchPriceHistory caps the live-rows query (5 000).
// These per-timeframe limits are kept for the convertToOHLC call only.
const TIMEFRAME_CONFIG = {
    '1D':  { interval: 5,     hoursBack: 24,   limit: 5000  },
    '1W':  { interval: 60,    hoursBack: 168,  limit: 5000  },
    '1M':  { interval: 240,   hoursBack: 720,  limit: 5000  },
    '3M':  { interval: 1440,  hoursBack: 2160, limit: 5000  },
    '1Y':  { interval: 1440,  hoursBack: 8760, limit: 5000  },
    'ALL': { interval: 10080, hoursBack: null,  limit: 10000 }
};

// Load chart data from database with timeframe-aware filtering
async function loadChartDataFromHistory(symbol, symbolType = 'tea', timeframeOverride = null) {
    const tf = timeframeOverride || state.currentTimeframe || '1D';
    const cfg = TIMEFRAME_CONFIG[tf] || TIMEFRAME_CONFIG['1D'];

    let since = null;
    if (cfg.hoursBack) {
        since = new Date(Date.now() - cfg.hoursBack * 3600000).toISOString();
    }

    // For indexes, build composite OHLC from constituent tea price histories.
    // The pre-averaged INDEX rows in price_history have negligible variation
    // because Gaussian noise averages out across teas. Constituent tea rows
    // contain real trade-driven price movement that makes charts meaningful.
    if (symbolType === 'index') {
        const _rev = { 'KENYA': 'MOMBASA', 'INDIA': 'KOLKATA', 'CEYLON': 'COLOMBO', 'ASIA': 'FUTURES' };
        const idxDef = state.dbIndexes?.find(i => i.symbol === symbol)
                    || state.dbIndexes?.find(i => i.symbol === (_rev[symbol] || symbol));
        if (idxDef?.teas?.length) {
            const compositeCandles = await _loadCompositeIndexOHLC(idxDef.teas, cfg, since);
            if (compositeCandles && compositeCandles.length >= 3) return compositeCandles;
        }
    }

    const rawData = await loadPriceHistory(symbol, cfg.limit, since);

    if (rawData && rawData.length >= 3) {
        return convertToOHLC(rawData, cfg.interval);
    }

    return null;
}

async function _loadCompositeIndexOHLC(teaSymbols, cfg, since) {
    const allRows = await Promise.all(
        teaSymbols.map(sym => loadPriceHistory(sym, cfg.limit, since))
    );

    // Bucket all teas' ticks by time interval, then average per bucket
    const intervalMs = cfg.interval * 60000;
    const buckets = {};

    allRows.forEach((rows, teaIdx) => {
        if (!rows) return;
        rows.forEach(tick => {
            const t = new Date(tick.recorded_at).getTime();
            const bk = Math.floor(t / intervalMs) * intervalMs;
            if (!buckets[bk]) buckets[bk] = { prices: new Array(teaSymbols.length).fill(null) };
            // Keep the latest price per tea per bucket
            buckets[bk].prices[teaIdx] = tick.price;
        });
    });

    // Fill forward: within each bucket, if a tea has no tick, carry from previous bucket
    const sortedKeys = Object.keys(buckets).map(Number).sort((a, b) => a - b);
    const lastKnown = new Array(teaSymbols.length).fill(null);
    const candles = [];

    for (const bk of sortedKeys) {
        const bp = buckets[bk].prices;
        // Carry forward
        for (let i = 0; i < bp.length; i++) {
            if (bp[i] != null) lastKnown[i] = bp[i];
            else bp[i] = lastKnown[i];
        }
        const valid = bp.filter(p => p != null && p > 0);
        if (valid.length === 0) continue;
        const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
        candles.push({ date: new Date(bk), open: avg, high: avg, low: avg, close: avg, volume: 0 });
    }

    // Build proper OHLC from consecutive candle close prices
    // Each candle represents one interval; open = previous close, high/low track intra-bucket
    if (candles.length > 1) {
        for (let i = 1; i < candles.length; i++) {
            candles[i].open = candles[i - 1].close;
            candles[i].high = Math.max(candles[i].open, candles[i].close);
            candles[i].low = Math.min(candles[i].open, candles[i].close);
        }
    }

    return candles.length >= 3 ? candles : null;
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

    const _getLiveMultiplier = (idx) => {
        if (idx.forexKey && state.macroIndicators[idx.forexKey]) {
            return Number(state.macroIndicators[idx.forexKey]) || idx.multiplier || 1;
        }
        return idx.multiplier || 1;
    };

    const calcIndex = (symbols, multiplier = 1) => {
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
            const mult = _getLiveMultiplier(idx);
            const calc = calcIndex(idx.teas || [], mult);
            result[idx.symbol] = calc;
        });
    } else {
        const lkr = Number(state.macroIndicators.usd_lkr) || 305;
        const inr = Number(state.macroIndicators.usd_inr) || 83.5;
        const idr = Number(state.macroIndicators.usd_idr) || 15700;
        const bdt = Number(state.macroIndicators.usd_bdt) || 110;
        result.KENYA = calcIndex(['KEN-BP1', 'KEN-PF1', 'KEN-DUST']);
        result.MOMBASA = calcIndex(['KEN-BP1', 'KEN-PF1', 'KEN-DUST', 'KEN-PD', 'KEN-BMF', 'KEN-FNGS']);
        result.KOLKATA = calcIndex(['IND-ASM', 'IND-DRJ', 'KOL-SF', 'KOL-AUT', 'KOL-GOLD'], inr);
        result.COLOMBO = calcIndex(['SRI-BOP', 'SRI-PEK', 'SRI-OP', 'SRI-FBOP', 'SRI-DUST', 'SRI-BOP1'], lkr);
        result.JAKARTA = calcIndex(['IDN-BOP', 'IDN-PF', 'IDN-DUST', 'IDN-BT'], idr);
        result.CHITTAGONG = calcIndex(['BGD-BOP', 'BGD-BP', 'BGD-DUST', 'BGD-FNGS'], bdt);
        result.GUWAHATI = calcIndex(['GUW-BOP', 'GUW-BP', 'GUW-OF', 'GUW-PF'], inr);
        result.JALPAIGURI = calcIndex(['JAL-BOP', 'JAL-BP', 'JAL-DUST', 'JAL-PF'], inr);
        result.COCHIN = calcIndex(['COC-BOP', 'COC-OP', 'COC-DUST', 'COC-PF'], inr);
        result.COIMBATORE = calcIndex(['CMB-BOP', 'CMB-BP', 'CMB-DUST', 'CMB-OP'], inr);
        result.LIMBE = calcIndex(['MLW-BP1', 'MLW-PF1', 'MLW-DUST', 'MLW-FNGS']);
        result.SILIGURI = calcIndex(['SIL-DRJ', 'SIL-BOP', 'SIL-DUST', 'SIL-FNGS'], inr);
        result.COONOOR = calcIndex(['COO-BOP', 'COO-OP', 'COO-DUST', 'COO-PF'], inr);
        result.FUTURES = calcIndex(['KEN-BP1', 'IND-ASM', 'SRI-BOP', 'IDN-BOP', 'BGD-BOP', 'MLW-BP1'], 1000);
    }

    return result;
}

// Update all market index displays with real calculated prices
function updateAllMarketIndexes() {
    const indexes = calculateMarketIndexes();
    if (!indexes) return;

    // Update main chart if it's showing a KENYA-equivalent symbol
    const mainIdxSym = _CARD_TO_INDEX[state.mainChartData.symbol] || state.mainChartData.symbol;
    if (indexes[mainIdxSym]) {
        state.mainChartData.basePrice = indexes[mainIdxSym].price;
        state.mainChartData.change = indexes[mainIdxSym].change;
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
        state.mainChartData = { ...clickedCardData, isIndex: true, isTea: false };
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
        : defaultDbIndexes.filter(i => !i.is_market_card);

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

    const resolvedMainSym = _CARD_TO_INDEX[state.mainChartData.symbol] || state.mainChartData.symbol;
    if (kenyaIndex && resolvedMainSym === 'KENYA') {
        state.mainChartData.basePrice = kenyaIndex.price;
        state.mainChartData.change = kenyaIndex.change;

        const priceEl = document.getElementById('main-chart-price');
        if (priceEl) {
            priceEl.textContent = formatIndexPrice(kenyaIndex.price, state.mainChartData.currency || '$');
            priceEl.className = 'chart-stat-value ' + (kenyaIndex.change >= 0 ? 'up' : 'down');
        }

        const changeEl = document.getElementById('main-chart-change');
        if (changeEl) {
            const chg = kenyaIndex.change;
            changeEl.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
            changeEl.style.color = chg >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
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
        // Keep today's open as previous_price (set by loadTeas); don't overwrite with last tick
        if (!state.teas[idx].previous_price || state.teas[idx].previous_price <= 0) {
            state.teas[idx].previous_price = state.teas[idx].current_price;
        }
        state.teas[idx].current_price = updated.current_price;
        if (updated.price_change_24h != null) state.teas[idx].price_change_24h = updated.price_change_24h;
        if (updated.last_update) state.teas[idx].last_update = updated.last_update;
        if (updated.anchor_price) state.teas[idx].anchor_price = updated.anchor_price;
        if (updated.reference_forex) state.teas[idx].reference_forex = updated.reference_forex;

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
const _CARD_TO_INDEX = { 'KENYAN': 'KENYA' };

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
    const _rev = { 'KENYA': 'MOMBASA', 'INDIA': 'KOLKATA', 'CEYLON': 'COLOMBO', 'ASIA': 'FUTURES' };
    const idxDef = state.dbIndexes?.find(i => i.symbol === indexSymbol)
                || state.dbIndexes?.find(i => i.symbol === (_rev[indexSymbol] || indexSymbol));
    if (!idxDef?.teas?.length) return null;
    const teaMap = {};
    state.teas.forEach(t => { teaMap[t.symbol] = t; });
    const prices = idxDef.teas.map(s => teaMap[s]?.current_price || 0).filter(p => p > 0);
    if (prices.length === 0) return null;
    return prices.reduce((a, b) => a + b, 0) / prices.length;
}

/**
 * When a real-time tick arrives for `symbol` (a tea), push the new price
 * into every live chart rendering that symbol OR an index containing it,
 * then redraw. This is the SOLE path for chart data mutation from live
 * ticks — updateChartsWithNewPrices only updates DOM price displays.
 */
function _pushPriceToActiveCharts(symbol, newPrice) {
    // ── Main chart (data stored in USD; forex applied at render) ──────────
    const mainSymbol = _getMainChartSymbol();
    const mainType   = _getMainChartSymbolType();

    if (mainType === 'tea' && mainSymbol === symbol && state.chartData?.length > 0) {
        appendPriceToChart(state.chartData, newPrice);
        if (typeof drawChart === 'function') drawChart();
    } else if (mainType === 'index' && state.chartData?.length > 0) {
        const _revCard = { 'KENYA': 'MOMBASA', 'INDIA': 'KOLKATA', 'CEYLON': 'COLOMBO', 'ASIA': 'FUTURES' };
        const altSymbol = _revCard[mainSymbol] || mainSymbol;
        const idxDef = state.dbIndexes?.find(i => i.symbol === mainSymbol)
                    || state.dbIndexes?.find(i => i.symbol === altSymbol);
        if (idxDef?.teas?.includes(symbol)) {
            const idxPrice = _liveIndexPrice(mainSymbol);
            if (idxPrice > 0) {
                appendPriceToChart(state.chartData, idxPrice);
                updatePriceCache(mainSymbol, idxPrice, 'index');
                if (typeof drawChart === 'function') drawChart();
            }
        }
    }

    // ── Hub fullscreen chart (data stored in USD; forex applied at render) ──
    const hubSection = document.getElementById('chart-section');
    if (hubSection?.classList.contains('panel-maximized') && state.hubChartData?.length > 0) {
        const hubRaw    = document.getElementById('hub-buy-symbol')?.value || '';
        const _cardMap  = { 'KENYAN': 'KENYA' };
        const hubSymbol = _cardMap[hubRaw] || hubRaw;
        const hubIsIdx  = typeof isIndexSymbol === 'function' && isIndexSymbol(hubSymbol);

        if (!hubIsIdx && hubSymbol === symbol) {
            appendPriceToChart(state.hubChartData, newPrice);
            if (typeof drawHubChart === 'function') drawHubChart();
        } else if (hubIsIdx) {
            const idxDef = state.dbIndexes?.find(i => i.symbol === hubSymbol);
            if (idxDef?.teas?.includes(symbol)) {
                const idxPrice = _liveIndexPrice(hubSymbol);
                if (idxPrice > 0) {
                    appendPriceToChart(state.hubChartData, idxPrice);
                    updatePriceCache(hubSymbol, idxPrice, 'index');
                    if (typeof drawHubChart === 'function') drawHubChart();
                }
            }
        }
    }

    // ── Quick-quote modal ─────────────────────────────────────────────────
    const qqModal = document.getElementById('quick-quote-modal');
    if (state.qqCurrentTea && qqModal?.classList.contains('active')) {
        const qqSym   = state.qqCurrentTea.symbol;
        const qqIsIdx = state.qqCurrentTea.isIndex;
        let qqPrice   = null;

        if (!qqIsIdx && qqSym === symbol) {
            qqPrice = newPrice;
        } else if (qqIsIdx) {
            const idxDef = state.dbIndexes?.find(i => i.symbol === qqSym);
            if (idxDef?.teas?.includes(symbol)) {
                qqPrice = _liveIndexPrice(qqSym);
            }
        }

        if (qqPrice && qqPrice > 0) {
            const cacheKey = qqIsIdx ? `INDEX_${qqSym}` : qqSym;
            if (state.priceDataCache?.data?.[cacheKey]?.length > 0) {
                appendPriceToChart(state.priceDataCache.data[cacheKey], qqPrice);
            }
            if (typeof drawQuickQuoteChart === 'function') {
                state.qqCurrentTea = { ...state.qqCurrentTea, current_price: qqPrice };
                drawQuickQuoteChart(state.qqCurrentTea);
            }
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
        buy5m:        Number(row.buy_volume_5m)   || 0,
        sell5m:       Number(row.sell_volume_5m)  || 0,
        buy30m:       Number(row.buy_volume_30m)  || 0,
        sell30m:      Number(row.sell_volume_30m) || 0,
        tradeCount5m: Number(row.trade_count_5m)  || 0,
        tradeCount30m:Number(row.trade_count_30m) || 0,
        lastSide:     row.last_side,
        lastQty:      Number(row.last_qty)         || 0,
        updatedAt:    row.updated_at,
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
                buy5m:         Number(row.buy_volume_5m)   || 0,
                sell5m:        Number(row.sell_volume_5m)  || 0,
                buy30m:        Number(row.buy_volume_30m)  || 0,
                sell30m:       Number(row.sell_volume_30m) || 0,
                tradeCount5m:  Number(row.trade_count_5m)  || 0,
                tradeCount30m: Number(row.trade_count_30m) || 0,
                lastSide:      row.last_side,
                lastQty:       Number(row.last_qty)         || 0,
                updatedAt:     row.updated_at,
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
        if (typeof updateGlobalTicker    === 'function') updateGlobalTicker();
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
        if (typeof updateGlobalTicker    === 'function') updateGlobalTicker();
        console.log(`🛢️  Live Brent crude: $${price.toFixed(2)}/bbl`);

        // Cache 5-day close history for the popout sparkline
        const result = data?.chart?.result?.[0];
        const timestamps = result?.timestamp ?? [];
        const closes     = result?.indicators?.quote?.[0]?.close ?? [];
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
 * Only updates DOM price/change displays. All chart data mutation
 * happens in _pushPriceToActiveCharts which fires per-tick.
 */
function updateChartsWithNewPrices() {
    // ── Main chart price display ──────────────────────────────────────────
    const mainSymbol = _getMainChartSymbol();
    const mainType   = _getMainChartSymbolType();
    let mainPrice    = null;

    if (mainType === 'tea' && mainSymbol) {
        const tea = state.teas?.find(t => t.symbol === mainSymbol);
        mainPrice = tea?.current_price;
    } else if (mainType === 'index' && mainSymbol) {
        const rawUsd = _liveIndexPrice(mainSymbol);
        if (rawUsd && rawUsd > 0) {
            const fk = state.mainChartData?.forexKey;
            const mult = (fk && state.macroIndicators?.[fk]) ? Number(state.macroIndicators[fk]) : 1;
            mainPrice = rawUsd * mult;
        }
    }

    if (mainPrice && mainPrice > 0) {
        state.mainChartData.basePrice = mainPrice;
        const priceEl = document.getElementById('main-chart-price');
        if (priceEl) {
            priceEl.textContent = formatIndexPrice(mainPrice, state.mainChartData.currency || '$');
        }
        if (!state.chartData?.length) {
            state.cachedTimeframe = null;
            drawChart();
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
