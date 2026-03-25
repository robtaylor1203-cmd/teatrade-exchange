/**
 * TeaTrade Exchange - TradingView Lightweight Charts Implementation
 * Radically simplified chart rendering using the industry-standard TV library.
 */

// =============================================
// GLOBAL TRADINGVIEW INSTANCES
// =============================================
let tvChart = null;
let mainSeries = null;
let volumeSeries = null;
let rsiChart = null;
let rsiSeries = null;
let bbUpperSeries = null;
let bbLowerSeries = null;
let bbMiddleSeries = null;

let sma10Series = null;
let sma20Series = null;
let sma50Series = null;
let ema10Series = null;
let ema20Series = null;

let activePriceLines = [];

// =============================================
// CORE CHART CONTROLS
// =============================================
function toggleTimeframeMenu() {
    document.getElementById('timeframe-menu').classList.toggle('visible');
}

function setTimeframe(tf) {
    const oldTimeframe = state.currentTimeframe;
    state.currentTimeframe = tf;
    document.getElementById('timeframe-label').textContent = tf;
    document.querySelectorAll('.timeframe-item').forEach(item => {
        item.classList.toggle('active', item.textContent === tf);
    });
    closeAllDropdowns();

    if (oldTimeframe !== tf) {
        invalidatePriceCacheForCurrentChart();
    }
    drawChart();
}

function invalidatePriceCacheForCurrentChart() {
    const select = document.getElementById('trade-tea-select');
    const selectedSymbol = select?.value;
    const selectedTea = state.teas && state.teas.find(t => t.symbol === selectedSymbol);

    let baseKey = selectedTea ? selectedTea.symbol : `INDEX_${state.mainChartData?.symbol || 'KENYA'}`;

    if (state.priceDataCache) {
        Object.keys(state.priceDataCache.data || {}).forEach(k => {
            if (k === baseKey || k.startsWith(baseKey + '_')) {
                delete state.priceDataCache.data[k];
                delete state.priceDataCache.lastUpdate[k];
                delete state.priceDataCache.loaded[k];
            }
        });
    }
    state.cachedTimeframe = null;
}

function setChartType(type) {
    state.chartType = type;
    document.getElementById('btn-line').classList.toggle('active', type === 'line');
    document.getElementById('btn-candle').classList.toggle('active', type === 'candle');
    _initTvChartIfNull(); // Re-inits with correct series type
    drawChart();
}

function toggleStudiesMenu() {
    document.getElementById('studies-menu').classList.toggle('visible');
}

function toggleStudy(study) {
    state.activeStudies[study] = !state.activeStudies[study];
    document.getElementById('toggle-' + study).classList.toggle('active', state.activeStudies[study]);
    closeAllDropdowns();

    const hasActive = Object.values(state.activeStudies).some(v => v);
    document.getElementById('studies-btn').classList.toggle('has-active', hasActive);

    const rsiContainer = document.getElementById('rsi-chart-container');
    if (rsiContainer) rsiContainer.style.display = state.activeStudies.rsi ? 'block' : 'none';

    drawChart();
}

function resizeCanvas() {
    if (tvChart) tvChart.timeScale().fitContent();
    if (rsiChart) rsiChart.timeScale().fitContent();
}

// =============================================
// TRADINGVIEW INITIALIZATION
// =============================================
function _initTvChartIfNull() {
    const container = document.getElementById('tv-chart');
    if (!container) return;

    if (tvChart) {
        if (tvChart._ro) {
            tvChart._ro.disconnect();
        }
        tvChart.remove();
        tvChart = null;
    }

    // Reset initialization flag so the newly created chart instance will auto-scale properly
    window._tvInitialScaleDone = false;

    const isCandle = state.chartType === 'candle';

    const chartOptions = {
        layout: {
            textColor: '#94a3b8',
            background: { type: 'solid', color: 'transparent' }
        },
        grid: {
            vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
            horzLines: { color: 'rgba(255, 255, 255, 0.05)' }
        },
        timeScale: {
            timeVisible: true,
            secondsVisible: false,
            rightOffset: 0,
            borderVisible: false,
            fixLeftEdge: false,
            fixRightEdge: false
        },
        rightPriceScale: {
            borderVisible: false,
            autoScale: true
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
        },
        autoSize: false, // Turn off autoSize to take control ourselves
    };

    tvChart = LightweightCharts.createChart(container, chartOptions);

    // Explicitly watch the container to force correct sizing
    const ro = new ResizeObserver(entries => {
        if (!tvChart) return;
        const cr = entries[0].contentRect;
        tvChart.resize(cr.width, cr.height);
    });
    ro.observe(container);
    // Bind to the chart object so it doesn't get GC'd prematurely and we could clean it up if needed
    tvChart._ro = ro;

    if (isCandle) {
        mainSeries = tvChart.addCandlestickSeries({
            upColor: '#10b981',
            downColor: '#ef4444',
            borderVisible: false,
            wickUpColor: '#10b981',
            wickDownColor: '#ef4444',
            priceFormat: { type: 'price', precision: 2, minMove: 0.01 }
        });
    } else {
        mainSeries = tvChart.addLineSeries({
            color: '#1a73e8',
            lineWidth: 2,
            priceFormat: { type: 'price', precision: 2, minMove: 0.01 }
        });

        // Add area under line
        const areaSeries = tvChart.addAreaSeries({
            topColor: 'rgba(26, 115, 232, 0.4)',
            bottomColor: 'rgba(26, 115, 232, 0)',
            lineColor: 'transparent',
            lineWidth: 0,
        });
        // We will sync data to areaSeries below
        mainSeries._linkedArea = areaSeries;
    }

    volumeSeries = tvChart.addHistogramSeries({
        color: '#26a69a',
        priceFormat: { type: 'volume' },
        priceScaleId: 'volumeOverlay', // Give it a real ID so scaleMargins work
    });
    tvChart.priceScale('volumeOverlay').applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
        visible: false, // Hide the axis labels for volume
    });

    // Initialize RSI Chart if needed
    _initRsiChartIfNull();

    // Sync crosshairs between charts
    tvChart.subscribeCrosshairMove(param => {
        if (!param.time || !rsiChart) return;
        rsiChart.setCrosshairPosition(param.price, param.time, rsiSeries);
    });
}

function _initRsiChartIfNull() {
    const rsiContainer = document.getElementById('rsi-chart-container');
    if (!rsiContainer) return;

    // Clear old canvas if it exists
    const oldCanvas = document.getElementById('rsiChart');
    if (oldCanvas) oldCanvas.remove();

    if (!document.getElementById('tv-rsi-chart')) {
        const tvRsiDiv = document.createElement('div');
        tvRsiDiv.id = 'tv-rsi-chart';
        tvRsiDiv.style.width = '100%';
        tvRsiDiv.style.height = '100px';
        rsiContainer.appendChild(tvRsiDiv);
    }

    if (rsiChart) {
        rsiChart.remove();
        rsiChart = null;
    }

    rsiChart = LightweightCharts.createChart(document.getElementById('tv-rsi-chart'), {
        layout: { textColor: '#94a3b8', background: { type: 'solid', color: 'transparent' } },
        grid: { vertLines: { color: 'rgba(255,255,255,0.05)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
        timeScale: { visible: false },
        rightPriceScale: { borderVisible: false },
        autoSize: true,
    });

    rsiSeries = rsiChart.addLineSeries({
        color: '#ec4899',
        lineWidth: 2,
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 }
    });

    // Add 30/70 reference lines
    rsiSeries.createPriceLine({ price: 70, color: 'rgba(255,255,255,0.2)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false });
    rsiSeries.createPriceLine({ price: 30, color: 'rgba(255,255,255,0.2)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false });
}

// =============================================
// DATA GENERATION & FORMATTING
// =============================================
function generateChartData(timeframe) {
    if (state.isFetchingHistory) return [];
    const config = timeframeConfig[timeframe];
    if (!config) return [];

    let symbol, symbolType;

    if (state.mainChartData?.isTea) {
        symbol = state.mainChartData.symbol;
        symbolType = 'tea';
    } else if (state.mainChartData?.isIndex) {
        symbol = _CARD_TO_INDEX[state.mainChartData.symbol] || state.mainChartData.symbol;
        symbolType = 'index';
    } else {
        const select = document.getElementById('trade-tea-select');
        const selectedVal = select?.value;
        if (selectedVal && !selectedVal.startsWith('INDEX_')) {
            const tea = state.teas?.find(t => t.id === parseInt(selectedVal));
            if (tea) { symbol = tea.symbol; symbolType = 'tea'; }
        }
        if (!symbol) {
            symbol = state.mainChartData?.symbol || 'KENYA';
            symbolType = 'index';
        }
    }

    const fullHistory = getPriceHistorySync(symbol, symbolType);
    const cacheKey = (symbolType === 'index' ? `INDEX_${symbol}` : symbol) + `_${timeframe}`;
    const isOfficiallyLoaded = state.priceDataCache?.loaded?.[cacheKey];

    // If we only have 0-1 items and we haven't officially loaded from DB,
    // the single point is likely a live-tick spooling into an empty cache wrapper.
    if (!isOfficiallyLoaded || !fullHistory || fullHistory.length < 2) {
        if (!state.isFetchingHistory) {
            state.isFetchingHistory = true;
            getPriceHistory(symbol, symbolType, timeframe)
                .catch(() => { })
                .finally(() => {
                    state.isFetchingHistory = false;
                    state.cachedTimeframe = null;
                    drawChart();
                });
        }
        return fullHistory || []; // Fallback to whatever exists while waiting
    }

    // Return full history so TradingView can natively handle zooming and panning
    return fullHistory;
}

function _getChartCurrencyInfo() {
    const mcd = state.mainChartData;
    if (!mcd) return { symbol: '$', multiplier: 1 };
    const curr = mcd.currency || '$';
    if (curr === '$') return { symbol: '$', multiplier: 1 };

    if (mcd.forexKey && state.macroIndicators?.[mcd.forexKey]) {
        return { symbol: curr, multiplier: Number(state.macroIndicators[mcd.forexKey]) || 1 };
    }
    const idx = typeof _findIndexDef === 'function' ? _findIndexDef(mcd.symbol) : null;
    if (idx && idx.forexKey && state.macroIndicators?.[idx.forexKey]) {
        return { symbol: curr, multiplier: Number(state.macroIndicators[idx.forexKey]) || idx.multiplier || 1 };
    }
    return { symbol: curr, multiplier: 1 };
}

// =============================================
// MAIN DRAW / BINDING
// =============================================
// Tracks the last known chart symbol/timeframe so we know when we must call setData vs update
let _chartLastSymbol = null;
let _chartLastTimeframe = null;
let _chartLastDataLength = 0;
let _chartLastType = null;

function drawChart() {
    if (!document.getElementById('tv-chart')) return;
    if (!tvChart) _initTvChartIfNull();

    const previousLength = state.chartData ? state.chartData.length : 0;
    const isNewTimeframe = state.cachedTimeframe !== state.currentTimeframe;

    state.chartData = generateChartData(state.currentTimeframe);
    const newLength = state.chartData ? state.chartData.length : 0;
    state.cachedTimeframe = state.currentTimeframe;

    if (!state.chartData || newLength === 0) return;

    // Determine if this is a full reload (new symbol, new timeframe, or first load)
    // vs a live-tick update (same symbol/timeframe, data grew by ≤1 candle)
    const currentSymbol = state.mainChartData?.symbol || '';
    const currentTimeframe = state.currentTimeframe;
    const isNewSymbol = currentSymbol !== _chartLastSymbol;
    const isSameState = !isNewSymbol && !isNewTimeframe && state.chartType === _chartLastType;
    const isLiveTick = isSameState && newLength > 0 && (newLength - _chartLastDataLength) <= 1 && _chartLastDataLength > 2;

    // Force rescale when:
    // 1) First load
    // 2) Transition from empty spoof/cache to full history
    // 3) User manually switches the timeframe horizon / symbol
    let forceRescale = false;
    if (!window._tvInitialScaleDone || (previousLength < 2 && newLength >= 2) || isNewTimeframe || isNewSymbol) {
        forceRescale = true;
    }

    const _ci = _getChartCurrencyInfo();
    let _fx = _ci.multiplier || 1;

    // Sanity FX check
    if (_fx > 1) {
        const _rawCloses = state.chartData.map(d => Number(d.close) || 0).filter(p => p > 0).sort((a, b) => a - b);
        if (_rawCloses.length > 0 && _rawCloses[Math.floor(_rawCloses.length / 2)] > 50) _fx = 1;
    }

    // Convert to TV Format Data
    const tvData = [];
    const volData = [];

    // Ensure data is strictly ascending and unique by timestamp (required by TV)
    const sortedData = [...state.chartData]
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Synchronize the last candle with the live ticker basePrice to prevent mismatch
    if (sortedData.length > 0 && state.mainChartData && state.mainChartData.basePrice) {
        const livePriceUSD = Number(state.mainChartData.basePrice) / _fx;
        if (livePriceUSD > 0) {
            const lastCandle = sortedData[sortedData.length - 1];
            lastCandle.close = livePriceUSD;
            if (livePriceUSD > lastCandle.high) lastCandle.high = livePriceUSD;
            if (livePriceUSD < lastCandle.low) lastCandle.low = livePriceUSD;
        }
    }

    let lastTime = 0;
    sortedData.forEach(d => {
        const tvTime = Math.floor(new Date(d.date).getTime() / 1000);
        if (tvTime <= lastTime && lastTime !== 0) return;
        lastTime = tvTime;

        const open = d.open * _fx;
        const close = d.close * _fx;
        const high = d.high * _fx;
        const low = d.low * _fx;

        if (state.chartType === 'candle') {
            tvData.push({ time: tvTime, open, high, low, close });
        } else {
            tvData.push({ time: tvTime, value: close });
        }

        let vol = d.volume;
        if (!vol || vol <= 0) {
            const spread = Math.abs(high - low);
            let pseudoVol = spread * 50000;
            pseudoVol += (tvTime % 100) * 10;
            vol = pseudoVol > 0 ? pseudoVol : 20;
        }

        volData.push({
            time: tvTime,
            value: vol,
            color: close >= open ? 'rgba(16, 185, 129, 0.5)' : 'rgba(239, 68, 68, 0.5)'
        });
    });

    if (tvData.length === 0) return;

    // ── SMART UPDATE: live tick → use .update() to avoid wiping chart history ──
    if (isLiveTick) {
        const lastCandle = tvData[tvData.length - 1];
        const lastVol = volData[volData.length - 1];
        try {
            mainSeries.update(lastCandle);
            if (mainSeries._linkedArea) mainSeries._linkedArea.update({ time: lastCandle.time, value: lastCandle.close });
            volumeSeries.update(lastVol);
        } catch (e) {
            // Fallback to full setData if update fails (e.g. time went backwards)
            mainSeries.setData(tvData);
            if (mainSeries._linkedArea) mainSeries._linkedArea.setData(tvData);
            volumeSeries.setData(volData);
        }
    } else {
        // Full reload: new symbol, new timeframe, or initial load
        mainSeries.setData(tvData);
        if (mainSeries._linkedArea) mainSeries._linkedArea.setData(tvData);
        volumeSeries.setData(volData);
    }

    // Update tracking state
    _chartLastSymbol = currentSymbol;
    _chartLastTimeframe = currentTimeframe;
    _chartLastDataLength = newLength;
    _chartLastType = state.chartType;

    // Auto-scale to fit data frame on load or timeframe/symbol swap
    if (forceRescale) {
        setTimeout(() => {
            if (tvChart) {
                if (tvData.length < 15) {
                    tvChart.timeScale().setVisibleLogicalRange({
                        from: tvData.length - 30,
                        to: tvData.length + 2
                    });
                } else {
                    tvChart.timeScale().fitContent();
                }
            }
        }, 50);
        window._tvInitialScaleDone = true;
    }

    // Apply Technicals: Bollinger Bands
    if (state.activeStudies.bollinger) {
        if (!bbUpperSeries) {
            bbUpperSeries = tvChart.addLineSeries({ color: 'rgba(96, 165, 250, 0.6)', lineWidth: 1, crosshairMarkerVisible: false });
            bbLowerSeries = tvChart.addLineSeries({ color: 'rgba(96, 165, 250, 0.6)', lineWidth: 1, crosshairMarkerVisible: false });
            bbMiddleSeries = tvChart.addLineSeries({ color: 'rgba(96, 165, 250, 0.3)', lineWidth: 1, crosshairMarkerVisible: false });
        }
        const bbData = calculateBollingerBands(tvData);
        bbUpperSeries.setData(bbData.upper);
        bbLowerSeries.setData(bbData.lower);
        bbMiddleSeries.setData(bbData.middle);
    } else if (bbUpperSeries) {
        tvChart.removeSeries(bbUpperSeries);
        tvChart.removeSeries(bbLowerSeries);
        tvChart.removeSeries(bbMiddleSeries);
        bbUpperSeries = null;
    }
    // Draw Moving Averages
    _drawMovingAverages(tvData);

    // Apply Technicals: RSI
    if (state.activeStudies.rsi && rsiSeries) {
        const rsiPts = calculateRSI(tvData);
        rsiSeries.setData(rsiPts);
    }

    // Draw Open Positions (price lines — lightweight, no DOM thrash)
    _attachOrderBadges(tvData[tvData.length - 1].close);
    // NOTE: Header price/change DOM is owned by market.js → updateMainChartStats()
    // Do NOT write to #main-chart-price or #main-chart-change here.
}

function _attachOrderBadges(currentPrice) {
    if (!mainSeries) return;

    // Clean up old ones
    activePriceLines.forEach(pl => mainSeries.removePriceLine(pl));
    activePriceLines = [];

    const symbol = state.mainChartData?.symbol;
    if (!symbol) return;

    const trades = getOpenTradesForSymbol(symbol);

    trades.forEach(trade => {
        // PnL = direction × (currentPrice − entryPrice) × quantity
        // Leverage reduces required margin; it does NOT multiply physical quantity in PnL.
        const pnl = (trade.trade_type === 'BUY' ? 1 : -1) * (currentPrice - trade.entry_price) * trade.quantity;
        const pnlStr = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);

        const pl = mainSeries.createPriceLine({
            price: trade.entry_price,
            color: trade.trade_type === 'BUY' ? '#10b981' : '#ef4444',
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: `${trade.trade_type} ${trade.quantity}kg [${pnlStr}]`,
        });
        activePriceLines.push(pl);
    });
}

function getOpenTradesForSymbol(symbol) {
    if (!symbol) return [];
    const trades = [];
    (state.positions || []).forEach(p => {
        const teaSym = p.teas?.symbol || state.teas?.find(t => t.id === p.tea_id)?.symbol || '';
        const idxSym = state.mainChartData?.isIndex ? (_cardToIndex[state.mainChartData.symbol] || state.mainChartData.symbol) : '';

        if (teaSym === symbol || (p.pos_type === 'index' && teaSym === idxSym)) {
            trades.push({
                entry_price: p.avg_entry_price || p.entry_price || 0,
                trade_type: p.quantity >= 0 ? 'BUY' : 'SELL',
                quantity: Math.abs(p.quantity),
                symbol: teaSym,
                leverage: p.leverage || 1,
            });
        }
    });
    return trades;
}

// =============================================
// INDICATOR MATH ALGORITHMS
// =============================================

function calculateSMA(data, period = 20) {
    const sma = [];
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) continue;
        let sum = 0;
        for (let j = 0; j < period; j++) {
            const val = data[i - j].close !== undefined ? data[i - j].close : data[i - j].value;
            sum += val;
        }
        sma.push({ time: data[i].time, value: sum / period });
    }
    return sma;
}

function calculateEMA(data, period = 20) {
    if (data.length < period) return [];
    const ema = [];
    const k = 2 / (period + 1);

    let sum = 0;
    for (let i = 0; i < period; i++) {
        const val = data[i].close !== undefined ? data[i].close : data[i].value;
        sum += val;
    }
    let prevEma = sum / period;
    ema.push({ time: data[period - 1].time, value: prevEma });

    for (let i = period; i < data.length; i++) {
        const val = data[i].close !== undefined ? data[i].close : data[i].value;
        prevEma = val * k + prevEma * (1 - k);
        ema.push({ time: data[i].time, value: prevEma });
    }
    return ema;
}

function calculateBollingerBands(data, period = 20, stdDev = 2) {
    const upper = [], lower = [], middle = [];
    if (data.length < period) return { upper, lower, middle };
    const sma = calculateSMA(data, period);

    const smaMap = {};
    sma.forEach(s => smaMap[s.time] = s.value);

    for (let i = period - 1; i < data.length; i++) {
        const t = data[i].time;
        const sValue = smaMap[t];
        if (sValue !== undefined) {
            let sumSquares = 0;
            for (let j = 0; j < period; j++) {
                const val = data[i - j].close !== undefined ? data[i - j].close : data[i - j].value;
                sumSquares += Math.pow(val - sValue, 2);
            }
            const std = Math.sqrt(sumSquares / period);
            upper.push({ time: t, value: sValue + stdDev * std });
            lower.push({ time: t, value: sValue - stdDev * std });
            middle.push({ time: t, value: sValue });
        }
    }
    return { upper, lower, middle };
}

function calculateRSI(data, period = 14) {
    if (data.length <= period) return [];

    const rsi = [];
    let avgGain = 0;
    let avgLoss = 0;

    for (let i = 1; i <= period; i++) {
        const val = data[i].close !== undefined ? data[i].close : data[i].value;
        const prevVal = data[i - 1].close !== undefined ? data[i - 1].close : data[i - 1].value;
        const change = val - prevVal;
        avgGain += change > 0 ? change : 0;
        avgLoss += change < 0 ? Math.abs(change) : 0;
    }

    avgGain /= period;
    avgLoss /= period;

    let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi.push({
        time: data[period].time,
        value: avgLoss === 0 ? 100 : 100 - (100 / (1 + rs))
    });

    for (let i = period + 1; i < data.length; i++) {
        const val = data[i].close !== undefined ? data[i].close : data[i].value;
        const prevVal = data[i - 1].close !== undefined ? data[i - 1].close : data[i - 1].value;
        const change = val - prevVal;

        const currentGain = change > 0 ? change : 0;
        const currentLoss = change < 0 ? Math.abs(change) : 0;

        avgGain = (avgGain * (period - 1) + currentGain) / period;
        avgLoss = (avgLoss * (period - 1) + currentLoss) / period;

        rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsi.push({
            time: data[i].time,
            value: avgLoss === 0 ? 100 : 100 - (100 / (1 + rs))
        });
    }

    return rsi;
}

function _drawMovingAverages(tvData) {
    if (!tvChart) return;

    if (state.activeStudies.sma10) {
        if (!sma10Series) sma10Series = tvChart.addLineSeries({ color: 'rgba(234, 179, 8, 0.8)', lineWidth: 1, crosshairMarkerVisible: false });
        sma10Series.setData(calculateSMA(tvData, 10));
    } else if (sma10Series) {
        tvChart.removeSeries(sma10Series);
        sma10Series = null;
    }

    if (state.activeStudies.sma20) {
        if (!sma20Series) sma20Series = tvChart.addLineSeries({ color: 'rgba(56, 189, 248, 0.8)', lineWidth: 1, crosshairMarkerVisible: false });
        sma20Series.setData(calculateSMA(tvData, 20));
    } else if (sma20Series) {
        tvChart.removeSeries(sma20Series);
        sma20Series = null;
    }

    if (state.activeStudies.sma50) {
        if (!sma50Series) sma50Series = tvChart.addLineSeries({ color: 'rgba(168, 85, 247, 0.8)', lineWidth: 1, crosshairMarkerVisible: false });
        sma50Series.setData(calculateSMA(tvData, 50));
    } else if (sma50Series) {
        tvChart.removeSeries(sma50Series);
        sma50Series = null;
    }

    if (state.activeStudies.ema10) {
        if (!ema10Series) ema10Series = tvChart.addLineSeries({ color: 'rgba(239, 68, 68, 0.8)', lineWidth: 1, crosshairMarkerVisible: false });
        ema10Series.setData(calculateEMA(tvData, 10));
    } else if (ema10Series) {
        tvChart.removeSeries(ema10Series);
        ema10Series = null;
    }

    if (state.activeStudies.ema20) {
        if (!ema20Series) ema20Series = tvChart.addLineSeries({ color: 'rgba(34, 197, 94, 0.8)', lineWidth: 1, crosshairMarkerVisible: false });
        ema20Series.setData(calculateEMA(tvData, 20));
    } else if (ema20Series) {
        tvChart.removeSeries(ema20Series);
        ema20Series = null;
    }
}
