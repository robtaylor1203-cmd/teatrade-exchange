/**
 * TeaTrade Exchange - Chart Rendering Module
 * Main price chart, technical indicators, RSI sub-chart, order annotations,
 * crosshair / tooltip, and all chart-control UI wiring.
 *
 * Globals from config.js : studyColors, leftMargin, rightMargin, bottomMargin,
 *                          timeframeConfig, isIndexSymbol, getIndexSymbols
 * Globals from market.js : getPriceHistory, getPriceHistorySync,
 *                          calculateRegionalIndexes
 * Globals from utils.js  : showToast, formatDate, formatVolume, closeAllDropdowns
 */

// =============================================
// MODULE-LEVEL STATE (chart-internal only)
// =============================================
let lastLivePrice = null;
let livePriceDirection = 0; // 1 = up, -1 = down, 0 = neutral

/**
 * Resolve the currency symbol and forex multiplier for the currently
 * displayed chart. Returns { symbol: '$', multiplier: 1 } for USD,
 * or e.g. { symbol: 'Rs', multiplier: 305 } for LKR-converted charts.
 * The multiplier converts raw USD price_history values to local currency.
 */
function _getChartCurrencyInfo() {
    const mcd = state.mainChartData;
    if (!mcd) return { symbol: '$', multiplier: 1 };

    const curr = mcd.currency || '$';
    if (curr === '$') return { symbol: '$', multiplier: 1 };

    // Try live forex rate from macroIndicators first
    if (mcd.forexKey && state.macroIndicators?.[mcd.forexKey]) {
        return { symbol: curr, multiplier: Number(state.macroIndicators[mcd.forexKey]) || 1 };
    }

    // Fall back to index definition (DB + hardcoded defaults merged)
    const idx = typeof _findIndexDef === 'function' ? _findIndexDef(mcd.symbol) : null;
    if (idx) {
        if (idx.forexKey && state.macroIndicators?.[idx.forexKey]) {
            return { symbol: curr, multiplier: Number(state.macroIndicators[idx.forexKey]) || idx.multiplier || 1 };
        }
        if (idx.multiplier && idx.multiplier > 1) {
            return { symbol: curr, multiplier: idx.multiplier };
        }
    }
    return { symbol: curr, multiplier: 1 };
}

// Shared window state set during drawChart so hover handlers can use it
let _chartWStart    = null;
let _chartWDuration = 0;
let _chartDisplayData = null;

// Timeframe → milliseconds (module-level so drawRSIChart and hover handlers can use it)
const WINDOW_MS = {
    '1D': 86400000, '1W': 604800000, '1M': 2592000000,
    '3M': 7776000000, '1Y': 31536000000, 'ALL': null
};

// =============================================
// CHART-SPECIFIC DATE FORMATTER
// =============================================
function formatChartDate(date, timeframe) {
    if (timeframe === '1D') {
        return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    } else if (timeframe === '1W' || timeframe === '1M') {
        return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    } else {
        return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }
}

// =============================================
// CHART CONTROLS
// =============================================

function toggleTimeframeMenu() {
    const menu = document.getElementById('timeframe-menu');
    menu.classList.toggle('visible');
}

function setTimeframe(tf) {
    const oldTimeframe = state.currentTimeframe;
    state.currentTimeframe = tf;
    // Clear Y-axis cache so the new timeframe rescales from scratch
    if (window.mainYAxisCache) window.mainYAxisCache = {};

    // Update dropdown label
    document.getElementById('timeframe-label').textContent = tf;

    // Update active state in menu
    document.querySelectorAll('.timeframe-item').forEach(item => {
        item.classList.toggle('active', item.textContent === tf);
    });

    // Close all dropdowns
    closeAllDropdowns();

    // Invalidate the price cache for the current symbol so data is
    // re-fetched with the correct time range for this timeframe.
    if (oldTimeframe !== tf) {
        invalidatePriceCacheForCurrentChart();
    }

    drawChart();
}

// Clear the price cache entry for whatever symbol the main chart is showing
// so the next drawChart() triggers a fresh DB fetch for the new timeframe.
function invalidatePriceCacheForCurrentChart() {
    const select = document.getElementById('trade-tea-select');
    const selectedSymbol = select?.value;
    const selectedTea = state.teas && state.teas.find(t => t.symbol === selectedSymbol);

    let baseKey;
    if (selectedTea) {
        baseKey = selectedTea.symbol;
    } else {
        const indexSymbol = state.mainChartData?.symbol || 'KENYA';
        baseKey = `INDEX_${indexSymbol}`;
    }

    // Clear all timeframe variants of this symbol's cache
    if (state.priceDataCache) {
        Object.keys(state.priceDataCache.data || {}).forEach(k => {
            if (k === baseKey || k.startsWith(baseKey + '_')) {
                delete state.priceDataCache.data[k];
                delete state.priceDataCache.lastUpdate[k];
                delete state.priceDataCache.loaded[k];
            }
        });
    }

    // Also clear the cached timeframe so drawChart regenerates chart data
    state.cachedTimeframe = null;
}

function setChartType(type) {
    state.chartType = type;
    document.getElementById('btn-line').classList.toggle('active', type === 'line');
    document.getElementById('btn-candle').classList.toggle('active', type === 'candle');
    drawChart();
}

function toggleStudiesMenu() {
    const menu = document.getElementById('studies-menu');
    menu.classList.toggle('visible');
}

function toggleStudy(study) {
    state.activeStudies[study] = !state.activeStudies[study];
    const toggle = document.getElementById('toggle-' + study);
    toggle.classList.toggle('active', state.activeStudies[study]);

    // Close studies menu on selection
    closeAllDropdowns();

    // Update button appearance
    const hasActive = Object.values(state.activeStudies).some(v => v);
    document.getElementById('studies-btn').classList.toggle('has-active', hasActive);

    // Show/hide RSI panel
    if (study === 'rsi') {
        const rsiContainer = document.getElementById('rsi-chart-container');
        rsiContainer.style.display = state.activeStudies.rsi ? 'block' : 'none';
    }

    drawChart();

    // Draw RSI if active
    if (state.activeStudies.rsi) {
        drawRSIChart();
    }
}

// =============================================
// CHART DATA GENERATION
// =============================================

function generateChartData(timeframe) {
    if (state.isFetchingHistory) return [];

    const config = timeframeConfig[timeframe];
    if (!config) return [];

    // Determine what to chart.
    // Priority: explicit isTea/isIndex flags on mainChartData (set by index card clicks
    // and search selections) take precedence over the hub trade dropdown.
    // The hub dropdown only drives the chart when mainChartData hasn't been explicitly set.
    let fullHistory;
    let symbol, symbolType;

    // Market card display symbols → tradable index symbols for data lookup
    const _cardToIndex = { 'KENYAN': 'KENYA' };

    if (state.mainChartData?.isTea) {
        symbol = state.mainChartData.symbol;
        symbolType = 'tea';
    } else if (state.mainChartData?.isIndex) {
        symbol = _cardToIndex[state.mainChartData.symbol] || state.mainChartData.symbol;
        symbolType = 'index';
    } else {
        // Fallback: check hub trade dropdown (default initial state).
        // Dropdown values are numeric tea IDs (e.g. "3") or "INDEX_KENYA".
        const select = document.getElementById('trade-tea-select');
        const selectedVal = select?.value;
        if (selectedVal && !selectedVal.startsWith('INDEX_')) {
            const tea = state.teas?.find(t => t.id === parseInt(selectedVal));
            if (tea) {
                symbol = tea.symbol;
                symbolType = 'tea';
            }
        }
        if (!symbol) {
            symbol = state.mainChartData?.symbol || 'KENYA';
            symbolType = 'index';
        }
    }

    fullHistory = getPriceHistorySync(symbol, symbolType);

    if (!fullHistory || fullHistory.length === 0) {
        state.isFetchingHistory = true;
        getPriceHistory(symbol, symbolType)
            .catch(() => {})
            .finally(() => {
                state.isFetchingHistory = false;
                state.cachedTimeframe = null;
                drawChart();
            });
    }

    const sampled = sampleHistoricalData(fullHistory, timeframe, config);
    return sampled;
}

function sampleHistoricalData(fullHistory, timeframe, config) {
    if (!fullHistory || fullHistory.length === 0) {
        return [];
    }

    // Data is already at the correct candle interval (set by TIMEFRAME_CONFIG
    // in market.js). Just slice the most recent N candles plus warm-up buffer
    // for technical indicators (Bollinger Bands need 20 periods).
    const warmupPeriod = 25;
    const maxPoints = (config.points || 96) + warmupPeriod;
    return fullHistory.slice(-maxPoints);
}

// =============================================
// TECHNICAL INDICATOR CALCULATIONS
// =============================================

function calculateSMA(data, period) {
    const sma = [];
    let firstValue = null;

    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) {
            sma.push(null);
        } else {
            let sum = 0;
            for (let j = 0; j < period; j++) {
                sum += data[i - j].close;
            }
            const val = sum / period;
            if (firstValue === null) firstValue = val;
            sma.push(val);
        }
    }

    // Backfill nulls with first calculated value
    for (let i = 0; i < sma.length; i++) {
        if (sma[i] === null && firstValue !== null) {
            sma[i] = firstValue;
        } else {
            break;
        }
    }

    return sma;
}

function calculateEMA(data, period) {
    const ema = [];
    const multiplier = 2 / (period + 1);
    let firstValue = null;

    // Start with SMA for first EMA value
    let sum = 0;
    for (let i = 0; i < period && i < data.length; i++) {
        sum += data[i].close;
    }
    let prevEma = sum / Math.min(period, data.length);

    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) {
            ema.push(null);
        } else if (i === period - 1) {
            if (firstValue === null) firstValue = prevEma;
            ema.push(prevEma);
        } else {
            const currentEma = (data[i].close - prevEma) * multiplier + prevEma;
            ema.push(currentEma);
            prevEma = currentEma;
        }
    }

    // Backfill nulls with first calculated value
    for (let i = 0; i < ema.length; i++) {
        if (ema[i] === null && firstValue !== null) {
            ema[i] = firstValue;
        } else {
            break;
        }
    }

    return ema;
}

function calculateBollingerBands(data, period = 20, stdDev = 2) {
    const sma = calculateSMA(data, period);
    const upper = [];
    const lower = [];
    let firstUpper = null;
    let firstLower = null;

    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) {
            upper.push(null);
            lower.push(null);
        } else {
            // Calculate standard deviation
            let sumSquares = 0;
            for (let j = 0; j < period; j++) {
                sumSquares += Math.pow(data[i - j].close - sma[i], 2);
            }
            const std = Math.sqrt(sumSquares / period);
            const u = sma[i] + stdDev * std;
            const l = sma[i] - stdDev * std;
            if (firstUpper === null) {
                firstUpper = u;
                firstLower = l;
            }
            upper.push(u);
            lower.push(l);
        }
    }

    // Backfill nulls
    for (let i = 0; i < upper.length; i++) {
        if (upper[i] === null && firstUpper !== null) {
            upper[i] = firstUpper;
            lower[i] = firstLower;
        } else {
            break;
        }
    }

    return { middle: sma, upper, lower };
}

function calculateRSI(data, period = 14) {
    const rsi = [];
    let gains = [];
    let losses = [];
    let firstValue = null;

    for (let i = 0; i < data.length; i++) {
        if (i === 0) {
            rsi.push(null);
            continue;
        }

        const change = data[i].close - data[i - 1].close;
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? Math.abs(change) : 0;

        gains.push(gain);
        losses.push(loss);

        if (i < period) {
            rsi.push(null);
        } else if (i === period) {
            const avgGain = gains.reduce((a, b) => a + b, 0) / period;
            const avgLoss = losses.reduce((a, b) => a + b, 0) / period;
            const rs = (avgGain === 0 && avgLoss === 0) ? 0 : (avgLoss === 0 ? 100 : avgGain / avgLoss);
            const val = (avgGain === 0 && avgLoss === 0) ? 50 : 100 - (100 / (1 + rs));
            if (firstValue === null) firstValue = val;
            rsi.push(val);
        } else {
            // Smoothed averages
            const prevAvgGain = gains.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
            const prevAvgLoss = losses.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
            const avgGain = (prevAvgGain * (period - 1) + gain) / period;
            const avgLoss = (prevAvgLoss * (period - 1) + loss) / period;
            const rs = (avgGain === 0 && avgLoss === 0) ? 0 : (avgLoss === 0 ? 100 : avgGain / avgLoss);
            rsi.push((avgGain === 0 && avgLoss === 0) ? 50 : 100 - (100 / (1 + rs)));
        }
    }

    // Backfill nulls with first calculated value
    for (let i = 0; i < rsi.length; i++) {
        if (rsi[i] === null && firstValue !== null) {
            rsi[i] = firstValue;
        } else if (rsi[i] !== null) {
            break;
        }
    }

    return rsi;
}

// =============================================
// CANVAS RESIZE
// =============================================

function resizeCanvas() {
    const canvas = document.getElementById('priceChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth * window.devicePixelRatio;
    canvas.height = canvas.offsetHeight * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    drawChart();
}

// =============================================
// MAIN CHART DRAW
// =============================================

function drawChart() {
    const canvas = document.getElementById('priceChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    const config = timeframeConfig[state.currentTimeframe];

    if (!config || !w || !h) return;

    ctx.clearRect(0, 0, w, h);

    // Generate data only when timeframe changes
    if (state.cachedTimeframe !== state.currentTimeframe || state.chartData.length === 0) {
        state.chartData = generateChartData(state.currentTimeframe);
        state.cachedTimeframe = state.currentTimeframe;
    }

    // No data yet (waiting for server) — show placeholder
    if (!state.chartData || state.chartData.length === 0) {
        ctx.font = '13px JetBrains Mono, monospace';
        ctx.fillStyle = '#6b7280';
        ctx.textAlign = 'center';
        ctx.fillText('Waiting for market data\u2026', w / 2, h / 2);
        return;
    }

    // Forex multiplier: data stored in USD, display in local currency
    const _ci = _getChartCurrencyInfo();
    let _fx = _ci.multiplier || 1;
    const _toDate = d => (d instanceof Date) ? d : new Date(d);

    // Sanity guard: detect data that is ALREADY in local currency (i.e. was
    // double-converted somewhere upstream). Compare the raw median close against
    // the expected USD range for the symbol. If the median is already > 50 (no
    // single tea costs > $50/kg), the data is likely already in local currency
    // and must NOT be multiplied again.
    if (_fx > 1) {
        const _rawCloses = state.chartData.map(d => Number(d.close) || 0).filter(p => p > 0).sort((a, b) => a - b);
        const _rawMedian = _rawCloses.length > 0 ? _rawCloses[Math.floor(_rawCloses.length / 2)] : 0;
        if (_rawMedian > 50) {
            _fx = 1;
        }
    }

    const displayData = state.chartData.map(d => ({
        ...d,
        open: d.open * _fx, high: d.high * _fx, low: d.low * _fx, close: d.close * _fx
    }));

    const prices = displayData.map(d => Number(d.close) || 0).filter(p => p > 0);
    if (prices.length === 0) return;

    const chartWidth = w - leftMargin - rightMargin;
    const chartHeight = h - bottomMargin - (h * 0.1);

    // ── Strict time boundaries (right edge = now, left edge = now - span) ──
    const now = Date.now();
    const timeRangeMs = WINDOW_MS[state.currentTimeframe];
    let wEndMs = now;
    let wStartMs;

    if (timeRangeMs) {
        wStartMs = now - timeRangeMs;
    } else {
        // 'ALL': span from earliest data point to now
        const firstTs = displayData.length > 0 ? _toDate(displayData[0].date).getTime() : NaN;
        wStartMs = (!isNaN(firstTs) ? firstTs : now) - 86400000;
    }

    let wDuration = Math.max(wEndMs - wStartMs, 3600000);
    wStartMs = wEndMs - wDuration;

    // Filter visible data for Y-axis scaling
    let visibleData = displayData.filter(d => {
        if (!d.date) return true;
        const t = _toDate(d.date).getTime();
        return !isNaN(t) && t >= wStartMs && t <= wEndMs;
    });

    // If no candles fall in window, expand to show whatever data exists
    if (visibleData.length === 0 && displayData.length > 0) {
        const dts = displayData.map(d => d.date ? _toDate(d.date).getTime() : null).filter(t => t && !isNaN(t));
        if (dts.length > 0) {
            const earliest = Math.min(...dts);
            const latest = Math.max(...dts);
            const span = Math.max(latest - earliest, 3600000);
            wStartMs = earliest - span * 0.05;
            wEndMs = Math.max(now, latest + span * 0.15);
            wDuration = wEndMs - wStartMs;
            visibleData = displayData;
        }
    }

    const yData = visibleData.length > 0 ? visibleData : displayData;

    // Y-AXIS: use actual min/max of ALL visible candle data (highs & lows)
    // so no data point ever clips off the chart.
    const allHighs = yData.map(d => Math.max(Number(d.high) || 0, Number(d.close) || 0)).filter(p => p > 0);
    const allLows  = yData.map(d => {
        const l = Math.min(Number(d.low) || Infinity, Number(d.close) || Infinity);
        return l > 0 && isFinite(l) ? l : null;
    }).filter(p => p !== null);
    if (allHighs.length === 0) return;

    const dataMax = Math.max(...allHighs);
    const dataMin = allLows.length > 0 ? Math.min(...allLows) : dataMax * 0.9;

    let rawSpan = dataMax - dataMin;
    if (rawSpan === 0) rawSpan = dataMin * 0.02 || 0.1;
    const padTop    = rawSpan * 0.15;
    const padBottom = rawSpan * 0.10;

    let minPrice = Math.max(0, dataMin - padBottom);
    let maxPrice = dataMax + padTop;

    // Ratchet: axis only EXPANDS to fit new data, never shrinks, so labels
    // stay stable. Resets on symbol/timeframe change (cache cleared elsewhere).
    const chartedSymbol = state.mainChartData?.symbol || 'MAIN';
    const cacheKey = `main_${chartedSymbol}_${state.currentTimeframe}`;
    if (!window.mainYAxisCache) window.mainYAxisCache = {};
    const prev = window.mainYAxisCache[cacheKey];
    if (prev) {
        const prevRange = prev.max - prev.min;
        const newRange  = maxPrice - minPrice;
        const ratio = prevRange / newRange;
        if (ratio > 3 || ratio < 0.33) {
            // Snap immediately for large scale changes (symbol switch, currency)
        } else {
            // Ratchet: take the wider of previous and new bounds
            minPrice = Math.min(prev.min, minPrice);
            maxPrice = Math.max(prev.max, maxPrice);
            // Slowly release if data has contracted significantly (>20% smaller)
            const currentRange = maxPrice - minPrice;
            const targetRange  = (dataMax + padTop) - Math.max(0, dataMin - padBottom);
            if (targetRange < currentRange * 0.8) {
                const ease = 0.02;
                minPrice = prev.min + ((dataMin - padBottom) - prev.min) * ease;
                maxPrice = prev.max + ((dataMax + padTop)    - prev.max) * ease;
                minPrice = Math.max(0, minPrice);
            }
        }
    }
    // Hard guarantee: current live price MUST be within the visible area.
    // Compute it early so we can enforce the constraint before caching.
    const currentPrice = prices[prices.length - 1];
    if (currentPrice > 0) {
        const cpPad = rawSpan * 0.12;
        if (currentPrice + cpPad > maxPrice) maxPrice = currentPrice + cpPad;
        if (currentPrice - cpPad < minPrice) minPrice = Math.max(0, currentPrice - cpPad);
    }

    window.mainYAxisCache[cacheKey] = { min: minPrice, max: maxPrice };

    const priceRange = maxPrice - minPrice;
    const visibleCloses = yData.map(d => Number(d.close) || 0).filter(p => p > 0);
    const avgPrice = visibleCloses.reduce((a, b) => a + b, 0) / visibleCloses.length;
    const highPrice = Math.max(...visibleCloses);
    const lowPrice = Math.min(...visibleCloses);
    const openPrice = Number(displayData[0].open) || currentPrice;
    const totalChange = openPrice > 0 ? ((currentPrice - openPrice) / openPrice * 100) : 0;

    state.chartMetrics = { minPrice, maxPrice, priceRange, avgPrice, highPrice, lowPrice, currentPrice, openPrice, totalChange };
    // Share with hover handlers
    const wStart = new Date(wStartMs);
    _chartWStart    = wStart;
    _chartWDuration = wDuration;
    _chartDisplayData = displayData;

    // Time-based X coordinate mapper — strict linear mapping from timestamp to pixel
    const getX = (timestamp) => leftMargin + ((timestamp - wStartMs) / wDuration) * chartWidth;

    // Convenience wrapper: maps candle index → X via its date timestamp
    function candleX(i) {
        const d = displayData[i]?.date;
        if (!d) return null;
        const t = _toDate(d).getTime();
        if (isNaN(t)) return null;
        return getX(t);
    }

    // Draw grid lines and Y-axis labels
    ctx.strokeStyle = '#1a2332';
    ctx.lineWidth = 1;
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'right';

    const _ccurr = (state.mainChartData?.currency || '$');
    const _cfmt = (v) => {
        if (v >= 1000) return _ccurr + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        if (v >= 100) return _ccurr + v.toFixed(1);
        return _ccurr + v.toFixed(2);
    };

    for (let i = 0; i <= 5; i++) {
        const y = h * 0.1 + chartHeight * (i / 5);
        const priceVal = maxPrice - (priceRange * (i / 5));

        ctx.beginPath();
        ctx.moveTo(leftMargin, y);
        ctx.lineTo(w - rightMargin, y);
        ctx.stroke();

        ctx.fillText(_cfmt(priceVal), leftMargin - 8, y + 3);
    }

    // Draw X-axis labels — decoupled time grid (~1 label every 90px)
    ctx.textAlign = 'center';
    ctx.fillStyle = '#6b7280';
    const maxLabels = Math.max(2, Math.floor(chartWidth / 90));
    const timeStep  = wDuration / maxLabels;
    for (let i = 0; i <= maxLabels; i++) {
        const gridTime = wStartMs + (i * timeStep);
        const x = getX(gridTime);
        ctx.fillText(formatChartDate(new Date(gridTime), state.currentTimeframe), x, h - 8);
    }

    // Draw average line (dashed)
    const avgY = h * 0.1 + (1 - (avgPrice - minPrice) / priceRange) * chartHeight;
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(leftMargin, avgY);
    ctx.lineTo(w - rightMargin, avgY);
    ctx.stroke();
    ctx.setLineDash([]);

    // lastX / lastY: position of the most-recent valid candle in the window
    let lastX = leftMargin + chartWidth;
    const lastY = h * 0.1 + (1 - (currentPrice - minPrice) / priceRange) * chartHeight;
    for (let i = displayData.length - 1; i >= 0; i--) {
        const x = candleX(i);
        if (x !== null) { lastX = x; break; }
    }

    // Setup strict clipping region so data doesn't bleed into the axes
    ctx.save();
    ctx.beginPath();
    ctx.rect(leftMargin, 0, chartWidth, h);
    ctx.clip();

    if (state.chartType === 'candle') {
        const candleWidth = Math.max(4, Math.min(20, (chartWidth / Math.max(displayData.length, 1)) * 0.7));

        displayData.forEach((d, i) => {
            const x = candleX(i);
            if (x === null) return;

            const openY  = h * 0.1 + (1 - (Number(d.open)  - minPrice) / priceRange) * chartHeight;
            const closeY = h * 0.1 + (1 - (Number(d.close) - minPrice) / priceRange) * chartHeight;
            const highY  = h * 0.1 + (1 - (Number(d.high)  - minPrice) / priceRange) * chartHeight;
            const lowY   = h * 0.1 + (1 - (Number(d.low)   - minPrice) / priceRange) * chartHeight;

            const isUp  = d.close >= d.open;
            const color = isUp ? '#10b981' : '#ef4444';

            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, highY);
            ctx.lineTo(x, lowY);
            ctx.stroke();

            const bodyTop    = Math.min(openY, closeY);
            const bodyHeight = Math.max(1, Math.abs(closeY - openY));
            ctx.fillStyle  = color;
            ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
            ctx.strokeStyle = color;
            ctx.strokeRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
        });
    } else {
        ctx.beginPath();
        ctx.strokeStyle = '#1a73e8';
        ctx.lineWidth = 2;

        let lineStarted = false;
        let lineLastX = lastX;
        displayData.forEach((d, i) => {
            const p = Number(d.close) || 0;
            if (!p) return;
            const x = candleX(i);
            if (x === null) return;
            const y = h * 0.1 + (1 - (p - minPrice) / priceRange) * chartHeight;
            if (!lineStarted) { ctx.moveTo(x, y); lineStarted = true; }
            else ctx.lineTo(x, y);
            lineLastX = x;
        });
        ctx.stroke();

        // Area fill back to bottom-left
        if (lineStarted) {
            ctx.lineTo(lineLastX, h * 0.1 + chartHeight);
            ctx.lineTo(leftMargin, h * 0.1 + chartHeight);
            ctx.closePath();
            ctx.fillStyle = 'rgba(26, 115, 232, 0.15)';
            ctx.fill();
        }
    }

    // =============================================
    // DRAW TECHNICAL INDICATORS
    // =============================================

    function drawIndicatorLine(values, color, lineWidth = 2) {
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        let started = false;

        // values[i] aligns with state.chartData[i], so use candleX for position
        values.forEach((val, i) => {
            if (val === null) return;
            const x = candleX(i);
            if (x === null) return;
            const y = h * 0.1 + (1 - (val - minPrice) / priceRange) * chartHeight;
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
    }

    if (state.activeStudies.sma10) {
        const sma10 = calculateSMA(displayData, 10);
        drawIndicatorLine(sma10, studyColors.sma10, 1.5);
    }
    if (state.activeStudies.sma20) {
        const sma20 = calculateSMA(displayData, 20);
        drawIndicatorLine(sma20, studyColors.sma20, 1.5);
    }
    if (state.activeStudies.sma50) {
        const sma50 = calculateSMA(displayData, 50);
        drawIndicatorLine(sma50, studyColors.sma50, 1.5);
    }
    if (state.activeStudies.ema10) {
        const ema10 = calculateEMA(displayData, 10);
        drawIndicatorLine(ema10, studyColors.ema10, 1.5);
    }
    if (state.activeStudies.ema20) {
        const ema20 = calculateEMA(displayData, 20);
        drawIndicatorLine(ema20, studyColors.ema20, 1.5);
    }
    if (state.activeStudies.bollinger) {
        const bb = calculateBollingerBands(displayData, 20, 2);

        // Draw upper band
        drawIndicatorLine(bb.upper, studyColors.bollinger, 1);

        // Draw lower band
        drawIndicatorLine(bb.lower, studyColors.bollinger, 1);

        // Draw middle band (SMA)
        ctx.setLineDash([4, 4]);
        drawIndicatorLine(bb.middle, studyColors.bollinger, 1);
        ctx.setLineDash([]);

        // Fill between bands
        ctx.beginPath();
        let bbStarted = false;
        bb.upper.forEach((val, i) => {
            if (val === null) return;
            const x = candleX(i);
            if (x === null) return;
            const y = h * 0.1 + (1 - (val - minPrice) / priceRange) * chartHeight;
            if (!bbStarted) { ctx.moveTo(x, y); bbStarted = true; }
            else ctx.lineTo(x, y);
        });
        for (let i = bb.lower.length - 1; i >= 0; i--) {
            if (bb.lower[i] === null) continue;
            const x = candleX(i);
            if (x === null) continue;
            const y = h * 0.1 + (1 - (bb.lower[i] - minPrice) / priceRange) * chartHeight;
            ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = 'rgba(96, 165, 250, 0.1)';
        ctx.fill();
    }

    // High/Low markers (line chart only)
    if (state.chartType === 'line') {
        // Find high/low candle index from state.chartData (not filtered prices array)
        let highIdx = -1, lowIdx = -1;
        displayData.forEach((d, i) => {
            const c = Number(d.close) || 0;
            if (!c) return;
            if (highIdx < 0 || c >= Number(displayData[highIdx].close)) highIdx = i;
            if (lowIdx  < 0 || c <= Number(displayData[lowIdx].close))  lowIdx  = i;
        });

        if (highIdx >= 0) {
            const hx = candleX(highIdx);
            if (hx !== null) {
                const hy = h * 0.1 + (1 - (highPrice - minPrice) / priceRange) * chartHeight;
                ctx.fillStyle = '#10b981';
                ctx.beginPath();
                ctx.arc(hx, hy, 4, 0, Math.PI * 2);
                ctx.fill();
                ctx.font = '9px JetBrains Mono, monospace';
                ctx.fillStyle = '#10b981';
                ctx.textAlign = 'center';
                ctx.fillText('H ' + _ci.symbol + highPrice.toFixed(2), hx, hy - 10);
            }
        }

        if (lowIdx >= 0) {
            const lx = candleX(lowIdx);
            if (lx !== null) {
                const ly = h * 0.1 + (1 - (lowPrice - minPrice) / priceRange) * chartHeight;
                ctx.fillStyle = '#ef4444';
                ctx.beginPath();
                ctx.arc(lx, ly, 4, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#ef4444';
                ctx.textAlign = 'center';
                ctx.fillText('L ' + _ci.symbol + lowPrice.toFixed(2), lx, ly + 16);
            }
        }

        // Current price marker at last candle position
        ctx.fillStyle = '#1a73e8';
        ctx.beginPath();
        ctx.arc(lastX, lastY, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    // Average label
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.fillStyle = '#f59e0b';
    ctx.textAlign = 'left';
    ctx.fillText('AVG ' + _ci.symbol + avgPrice.toFixed(2), leftMargin + 5, avgY - 5);

    // Remove clipping region for UI overlays
    ctx.restore();

    // =============================================
    // LIVE PRICE CALLOUT (Trading212 style)
    // =============================================
    drawPriceCallout(ctx, w, h, currentPrice, lastY, priceRange > 0, _ci.symbol);

    // =============================================
    // DRAW ORDER POSITION LINES (Trading212 style)
    // =============================================
    drawOrderAnnotations(ctx, w, h, chartWidth, chartHeight, minPrice, maxPrice, priceRange, currentPrice);

    // Draw RSI if active
    if (state.activeStudies.rsi) {
        drawRSIChart();
    }
}

// =============================================
// LIVE PRICE CALLOUT BOX
// =============================================

function drawPriceCallout(ctx, w, h, price, priceY, isValid, currSymbol) {
    if (!isValid || !price) return;

    // Determine direction from last price
    if (lastLivePrice !== null && lastLivePrice !== price) {
        livePriceDirection = price > lastLivePrice ? 1 : -1;
    }
    lastLivePrice = price;

    const boxWidth = 70;
    const boxHeight = 22;
    const boxX = w - boxWidth - 5;
    const boxY = Math.max(20, Math.min(h - boxHeight - 30, priceY - boxHeight / 2));

    // Determine color based on direction
    const bgColor = livePriceDirection > 0 ? '#10b981' : livePriceDirection < 0 ? '#ef4444' : '#1a73e8';

    // Draw connecting line from price point to callout
    ctx.strokeStyle = bgColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(w - 60, priceY);
    ctx.lineTo(boxX, boxY + boxHeight / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw callout box with rounded corners
    ctx.fillStyle = bgColor;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 4);
    ctx.fill();

    // Draw price text
    ctx.font = 'bold 11px JetBrains Mono, monospace';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    const _cs = currSymbol || '$';
    ctx.fillText(_cs + price.toFixed(2), boxX + boxWidth / 2, boxY + boxHeight / 2 + 4);

    // Draw small arrow indicator
    const arrowX = boxX + 8;
    const arrowY = boxY + boxHeight / 2;
    ctx.fillStyle = '#ffffff';
    if (livePriceDirection > 0) {
        // Up arrow
        ctx.beginPath();
        ctx.moveTo(arrowX, arrowY + 3);
        ctx.lineTo(arrowX - 4, arrowY + 3);
        ctx.lineTo(arrowX - 2, arrowY - 4);
        ctx.closePath();
        ctx.fill();
    } else if (livePriceDirection < 0) {
        // Down arrow
        ctx.beginPath();
        ctx.moveTo(arrowX, arrowY - 3);
        ctx.lineTo(arrowX - 4, arrowY - 3);
        ctx.lineTo(arrowX - 2, arrowY + 4);
        ctx.closePath();
        ctx.fill();
    }
}

// =============================================
// ORDER POSITION ANNOTATIONS
// =============================================

function drawOrderAnnotations(ctx, w, h, chartWidth, chartHeight, minPrice, maxPrice, priceRange, currentPrice) {
    if (!state.positions || state.positions.length === 0) return;

    // Get the currently selected tea from trade form
    const select = document.getElementById('trade-tea-select');
    const selectedTeaId = select?.value ? parseInt(select.value) : null;

    state.positions.forEach(position => {
        // Only show positions for the currently selected tea (or all if none selected)
        if (selectedTeaId && position.tea_id !== selectedTeaId) return;

        const entryPrice = position.avg_entry_price;
        if (!entryPrice || entryPrice < minPrice || entryPrice > maxPrice) return;

        // Get current price for this tea
        const tea = state.teas.find(t => t.id === position.tea_id);
        if (!tea) return;

        const teaCurrentPrice = tea.current_price;

        // Calculate P/L
        const pnl = (teaCurrentPrice - entryPrice) * position.quantity;
        const pnlPercent = ((teaCurrentPrice - entryPrice) / entryPrice * 100);
        const isProfit = pnl >= 0;

        // Calculate Y position
        const entryY = h * 0.1 + (1 - (entryPrice - minPrice) / priceRange) * chartHeight;

        // Draw dotted line
        ctx.strokeStyle = isProfit ? '#10b981' : '#ef4444';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(leftMargin, entryY);
        ctx.lineTo(w - rightMargin, entryY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw entry marker (small triangle on left)
        ctx.fillStyle = isProfit ? '#10b981' : '#ef4444';
        ctx.beginPath();
        ctx.moveTo(leftMargin - 6, entryY);
        ctx.lineTo(leftMargin, entryY - 4);
        ctx.lineTo(leftMargin, entryY + 4);
        ctx.closePath();
        ctx.fill();

        // Draw P/L label on right side
        const pnlText = `${isProfit ? '+' : ''}$${pnl.toFixed(2)} (${isProfit ? '+' : ''}${pnlPercent.toFixed(1)}%)`;
        ctx.font = 'bold 10px JetBrains Mono, monospace';
        ctx.fillStyle = isProfit ? '#10b981' : '#ef4444';
        ctx.textAlign = 'right';

        // Background for P/L label
        const textWidth = ctx.measureText(pnlText).width;
        ctx.fillStyle = 'rgba(13, 17, 23, 0.85)';
        ctx.fillRect(w - rightMargin - textWidth - 12, entryY - 16, textWidth + 8, 14);

        // P/L text
        ctx.fillStyle = isProfit ? '#10b981' : '#ef4444';
        ctx.fillText(pnlText, w - rightMargin - 8, entryY - 6);

        // Entry price label on left
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = isProfit ? '#10b981' : '#ef4444';
        ctx.fillText('ENTRY $' + entryPrice.toFixed(2), leftMargin + 5, entryY - 6);
    });
}

// =============================================
// RSI SUB-CHART
// =============================================

function drawRSIChart() {
    const rsiCanvas = document.getElementById('rsiChart');
    if (!rsiCanvas) return;

    const rsiCtx = rsiCanvas.getContext('2d');

    // Set canvas size
    rsiCanvas.width = rsiCanvas.offsetWidth * window.devicePixelRatio;
    rsiCanvas.height = rsiCanvas.offsetHeight * window.devicePixelRatio;
    rsiCtx.scale(window.devicePixelRatio, window.devicePixelRatio);

    const w = rsiCanvas.offsetWidth;
    const h = rsiCanvas.offsetHeight;
    const chartWidth = w - leftMargin - rightMargin;
    const topPadding = 20;
    const bottomPadding = 5;
    const chartHeight = h - topPadding - bottomPadding;

    // Clear
    rsiCtx.clearRect(0, 0, w, h);

    // Calculate RSI
    const rsiData = calculateRSI(displayData || state.chartData, 14);

    // Update RSI value display
    const currentRSI = rsiData[rsiData.length - 1];
    const rsiValueEl = document.getElementById('rsi-value');
    if (currentRSI !== null) {
        let rsiColor = '#fff';
        if (currentRSI >= 70) rsiColor = '#ef4444';
        else if (currentRSI <= 30) rsiColor = '#10b981';
        rsiValueEl.textContent = currentRSI.toFixed(1);
        rsiValueEl.style.color = rsiColor;
    }

    // Draw background bands
    // Overbought zone (70-100)
    rsiCtx.fillStyle = 'rgba(239, 68, 68, 0.1)';
    rsiCtx.fillRect(leftMargin, topPadding, chartWidth, chartHeight * 0.3);

    // Oversold zone (0-30)
    rsiCtx.fillStyle = 'rgba(16, 185, 129, 0.1)';
    rsiCtx.fillRect(leftMargin, topPadding + chartHeight * 0.7, chartWidth, chartHeight * 0.3);

    // Draw horizontal reference lines
    rsiCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    rsiCtx.lineWidth = 1;

    // 70 line (overbought)
    const y70 = topPadding + chartHeight * 0.3;
    rsiCtx.beginPath();
    rsiCtx.setLineDash([4, 4]);
    rsiCtx.moveTo(leftMargin, y70);
    rsiCtx.lineTo(w - rightMargin, y70);
    rsiCtx.stroke();

    // 50 line (middle)
    const y50 = topPadding + chartHeight * 0.5;
    rsiCtx.beginPath();
    rsiCtx.moveTo(leftMargin, y50);
    rsiCtx.lineTo(w - rightMargin, y50);
    rsiCtx.stroke();

    // 30 line (oversold)
    const y30 = topPadding + chartHeight * 0.7;
    rsiCtx.beginPath();
    rsiCtx.moveTo(leftMargin, y30);
    rsiCtx.lineTo(w - rightMargin, y30);
    rsiCtx.stroke();

    rsiCtx.setLineDash([]);

    // Draw Y-axis labels
    rsiCtx.font = '9px JetBrains Mono, monospace';
    rsiCtx.fillStyle = '#6b7280';
    rsiCtx.textAlign = 'right';
    rsiCtx.fillText('70', leftMargin - 5, y70 + 3);
    rsiCtx.fillText('50', leftMargin - 5, y50 + 3);
    rsiCtx.fillText('30', leftMargin - 5, y30 + 3);

    // Setup clipping region for RSI data
    rsiCtx.save();
    rsiCtx.beginPath();
    rsiCtx.rect(leftMargin, 0, chartWidth, h);
    rsiCtx.clip();

    // Draw RSI line
    rsiCtx.beginPath();
    rsiCtx.strokeStyle = studyColors.rsi;
    rsiCtx.lineWidth = 1.5;

    // RSI uses the same strict time-based X mapping as the main chart
    function rsiCandleX(i) {
        if (!_chartWStart || !_chartWDuration) return null;
        const d = state.chartData[i]?.date;
        if (!d) return null;
        const t = (d instanceof Date ? d : new Date(d)).getTime();
        if (isNaN(t)) return null;
        return leftMargin + ((t - _chartWStart.getTime()) / _chartWDuration) * chartWidth;
    }

    let started = false;
    rsiData.forEach((val, i) => {
        if (val === null) return;
        const x = rsiCandleX(i);
        if (x === null) return;
        const y = topPadding + (1 - val / 100) * chartHeight;
        if (!started) { rsiCtx.moveTo(x, y); started = true; }
        else rsiCtx.lineTo(x, y);
    });
    rsiCtx.stroke();

    // Draw fill under line
    if (started) {
        const lastRsiX = rsiCandleX(rsiData.length - 1) ?? (w - rightMargin);
        rsiCtx.lineTo(lastRsiX, topPadding + chartHeight);
        rsiCtx.lineTo(leftMargin, topPadding + chartHeight);
        rsiCtx.closePath();
        rsiCtx.fillStyle = 'rgba(236, 72, 153, 0.1)';
        rsiCtx.fill();
    }

    // Remove clipping region
    rsiCtx.restore();
}

// =============================================
// RSI CHART HOVER
// =============================================

function setupRSIHover() {
    const rsiCanvas = document.getElementById('rsiChart');
    const rsiContainer = document.getElementById('rsi-chart-container');
    const rsiTooltip = document.getElementById('rsi-tooltip');
    const rsiCrosshair = document.getElementById('rsi-crosshair');

    if (!rsiCanvas || !rsiContainer) return;

    rsiCanvas.addEventListener('mousemove', function (e) {
        if (!state.activeStudies.rsi) return;

        const rect = rsiCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const w = rsiCanvas.offsetWidth;
        const h = rsiCanvas.offsetHeight;
        const chartWidth = w - leftMargin - rightMargin;
        const topPadding = 20;
        const bottomPadding = 5;
        const chartHeight = h - topPadding - bottomPadding;

        // Check if mouse is in chart area
        if (x < leftMargin || x > w - rightMargin || y < topPadding || y > topPadding + chartHeight) {
            rsiTooltip.classList.remove('visible');
            rsiCrosshair.style.display = 'none';
            return;
        }

        // Calculate RSI data if needed
        const currentRsiData = calculateRSI(state.chartData, 14);

        // Map mouse X → time → nearest data point
        const hoverFrac = (x - leftMargin) / chartWidth;
        const hoverTime = _chartWStart
            ? _chartWStart.getTime() + hoverFrac * _chartWDuration
            : null;

        let index = 0;
        if (hoverTime !== null && state.chartData.length > 0) {
            let bestDist = Infinity;
            state.chartData.forEach((d, i) => {
                if (!d.date) return;
                const t = (d.date instanceof Date ? d.date : new Date(d.date)).getTime();
                const dist = Math.abs(t - hoverTime);
                if (dist < bestDist) { bestDist = dist; index = i; }
            });
        }
        index = Math.max(0, Math.min(index, state.chartData.length - 1));
        const dataPoint = state.chartData[index];
        const rsiValue = currentRsiData[Math.max(0, Math.min(index, currentRsiData.length - 1))];

        if (!dataPoint || rsiValue === null) {
            rsiTooltip.classList.remove('visible');
            rsiCrosshair.style.display = 'none';
            return;
        }

        // Show crosshair
        rsiCrosshair.style.display = 'block';
        rsiCrosshair.querySelector('.crosshair-v').style.left = x + 'px';
        rsiCrosshair.querySelector('.crosshair-h').style.top = y + 'px';

        // Determine RSI condition
        let rsiCondition = '';
        let rsiColor = '#fff';
        if (rsiValue >= 70) {
            rsiCondition = 'Overbought';
            rsiColor = '#ef4444';
        } else if (rsiValue <= 30) {
            rsiCondition = 'Oversold';
            rsiColor = '#10b981';
        } else {
            rsiCondition = 'Neutral';
            rsiColor = '#9ca3af';
        }

        // Build tooltip
        rsiTooltip.innerHTML = `
            <div style="color: ${rsiColor}; font-weight: 600;">RSI: ${rsiValue.toFixed(1)}</div>
            <div style="color: ${rsiColor}; font-size: 9px;">${rsiCondition}</div>
        `;

        // Position tooltip
        let tooltipX = x + 15;
        let tooltipY = y - 30;

        if (tooltipX + 100 > w) tooltipX = x - 100;
        if (tooltipY < 0) tooltipY = y + 20;

        rsiTooltip.style.left = tooltipX + 'px';
        rsiTooltip.style.top = tooltipY + 'px';
        rsiTooltip.classList.add('visible');
    });

    rsiCanvas.addEventListener('mouseleave', function () {
        rsiTooltip.classList.remove('visible');
        rsiCrosshair.style.display = 'none';
    });
}

// =============================================
// MAIN CHART HOVER / CROSSHAIR / TOOLTIP
// =============================================

function setupChartHover() {
    const canvas = document.getElementById('priceChart');
    if (!canvas) return;

    const tooltip = document.getElementById('chart-tooltip');
    const crosshair = document.getElementById('chart-crosshair');

    canvas.addEventListener('mousemove', function (e) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const w = canvas.offsetWidth;
        const h = canvas.offsetHeight;
        const chartWidth = w - leftMargin - rightMargin;
        const chartHeight = h - bottomMargin - (h * 0.1);

        // Check if mouse is in chart area
        if (x < leftMargin || x > w - rightMargin || y < h * 0.1 || y > h * 0.1 + chartHeight) {
            tooltip.classList.remove('visible');
            crosshair.style.display = 'none';
            return;
        }

        // Map mouse X → time → nearest data point
        const hoverFrac = (x - leftMargin) / chartWidth;
        const hoverTime = _chartWStart
            ? _chartWStart.getTime() + hoverFrac * _chartWDuration
            : null;

        let index = 0;
        if (hoverTime !== null && state.chartData.length > 0) {
            let bestDist = Infinity;
            state.chartData.forEach((d, i) => {
                if (!d.date) return;
                const t = (d.date instanceof Date ? d.date : new Date(d.date)).getTime();
                const dist = Math.abs(t - hoverTime);
                if (dist < bestDist) { bestDist = dist; index = i; }
            });
        }
        index = Math.max(0, Math.min(index, state.chartData.length - 1));
        const dataPoint = state.chartData[index];

        if (!dataPoint || !dataPoint.date) return;

        // Show crosshair
        crosshair.style.display = 'block';
        crosshair.querySelector('.crosshair-v').style.left = x + 'px';
        crosshair.querySelector('.crosshair-h').style.top = y + 'px';

        const _ttCi = _getChartCurrencyInfo();
        const _ttFx = _ttCi.multiplier || 1;
        const dpOpen = (Number(dataPoint.open) || 0) * _ttFx;
        const dpHigh = (Number(dataPoint.high) || 0) * _ttFx;
        const dpLow = (Number(dataPoint.low) || 0) * _ttFx;
        const dpClose = (Number(dataPoint.close) || 0) * _ttFx;
        const dpChange = dpOpen > 0 ? ((dpClose - dpOpen) / dpOpen * 100) : 0;
        const changeClass = dpChange >= 0 ? 'up' : 'down';
        const changeSign = dpChange >= 0 ? '+' : '';

        const _tc = _ttCi.symbol || '$';
        const _tf = (v) => v >= 100 ? _tc + v.toFixed(1) : _tc + v.toFixed(3);
        tooltip.innerHTML = `
            <div class="tooltip-date">${formatChartDate(dataPoint.date, state.currentTimeframe)}</div>
            <div class="tooltip-row">
                <span class="tooltip-label">Open</span>
                <span class="tooltip-value">${_tf(dpOpen)}</span>
            </div>
            <div class="tooltip-row">
                <span class="tooltip-label">High</span>
                <span class="tooltip-value up">${_tf(dpHigh)}</span>
            </div>
            <div class="tooltip-row">
                <span class="tooltip-label">Low</span>
                <span class="tooltip-value down">${_tf(dpLow)}</span>
            </div>
            <div class="tooltip-row">
                <span class="tooltip-label">Close</span>
                <span class="tooltip-value">${_tf(dpClose)}</span>
            </div>
            <div class="tooltip-row">
                <span class="tooltip-label">Change</span>
                <span class="tooltip-value ${changeClass}">${changeSign}${dpChange.toFixed(2)}%</span>
            </div>
            ${dataPoint.volume ? `<div class="tooltip-row">
                <span class="tooltip-label">Volume</span>
                <span class="tooltip-value">${formatVolume(dataPoint.volume)} kg</span>
            </div>` : ''}
        `;

        // Position tooltip
        let tooltipX = x + 15;
        let tooltipY = y - 10;

        // Keep tooltip in bounds
        if (tooltipX + 180 > w) tooltipX = x - 175;
        if (tooltipY + 160 > h) tooltipY = y - 150;
        if (tooltipY < 0) tooltipY = 10;

        tooltip.style.left = tooltipX + 'px';
        tooltip.style.top = tooltipY + 'px';
        tooltip.classList.add('visible');
    });

    canvas.addEventListener('mouseleave', function () {
        tooltip.classList.remove('visible');
        crosshair.style.display = 'none';
    });
}

// =============================================
// EVENT LISTENERS (attached after DOM ready)
// =============================================

// Close timeframe menu when clicking outside
document.addEventListener('click', (e) => {
    const dropdown = document.querySelector('.timeframe-dropdown');
    if (dropdown && !dropdown.contains(e.target)) {
        document.getElementById('timeframe-menu')?.classList.remove('visible');
    }
});

// Close studies menu when clicking outside
document.addEventListener('click', (e) => {
    const dropdown = document.querySelector('.studies-dropdown');
    if (dropdown && !dropdown.contains(e.target)) {
        document.getElementById('studies-menu')?.classList.remove('visible');
    }
});

// =============================================
// UNIVERSAL EVENT DELEGATION
// Handles .timeframe-item and indicator buttons in any dynamic context
// (main chart, trading hub fullscreen, quick-quote modal, any popup).
// Buttons with an existing inline onclick are already handled — skip them
// to avoid double-firing. Buttons without onclick (dynamically injected)
// are caught here and routed to the correct chart instance.
// =============================================
document.addEventListener('click', (e) => {
    // ── Timeframe option items ─────────────────────────────────────────────
    const tfItem = e.target.closest('.timeframe-item');
    if (tfItem && !tfItem.getAttribute('onclick')) {
        const tf = tfItem.dataset.tf || tfItem.textContent.trim();
        if (!tf) return;

        if (e.target.closest('#hub-timeframe-menu')) {
            // Hub fullscreen chart
            if (typeof setHubTimeframe === 'function') setHubTimeframe(tf);
        } else if (e.target.closest('#quick-quote-modal')) {
            // Quick-quote modal (uses .qq-tf-btn, but catch .timeframe-item too)
            if (typeof setQQTimeframe === 'function') setQQTimeframe(tf);
        } else {
            // Main chart
            setTimeframe(tf);
        }
        return;
    }

    // ── Quick-quote timeframe buttons (.qq-tf-btn) ─────────────────────────
    const qqTfBtn = e.target.closest('.qq-tf-btn');
    if (qqTfBtn && !qqTfBtn.getAttribute('onclick')) {
        const tf = qqTfBtn.dataset.tf;
        if (tf && typeof setQQTimeframe === 'function') setQQTimeframe(tf);
        return;
    }

    // ── Quick-quote indicator buttons (.qq-indicator-btn) ──────────────────
    const qqIndBtn = e.target.closest('.qq-indicator-btn');
    if (qqIndBtn && !qqIndBtn.getAttribute('onclick')) {
        const ind = qqIndBtn.dataset.ind;
        if (ind && typeof toggleQQIndicator === 'function') toggleQQIndicator(ind);
        return;
    }

    // ── Generic indicator buttons (.indicator-btn) — routed by context ─────
    const indBtn = e.target.closest('.indicator-btn');
    if (indBtn && !indBtn.getAttribute('onclick')) {
        const study = indBtn.dataset.study || indBtn.dataset.ind;
        if (!study) return;

        if (e.target.closest('#quick-quote-modal')) {
            if (typeof toggleQQIndicator === 'function') toggleQQIndicator(study);
        } else if (e.target.closest('#chart-section.panel-maximized')) {
            // Hub fullscreen
            if (typeof toggleHubStudy === 'function') toggleHubStudy(study);
        } else {
            toggleStudy(study);
        }
    }
});

// Initialize chart events after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    setupChartHover();
    setupRSIHover();
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();
});
