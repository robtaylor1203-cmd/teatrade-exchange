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
    // Load index positions from localStorage
    if (typeof loadIndexPositions === 'function') {
        loadIndexPositions();
    }

    // Pre-populate with current chart symbol (keep indexes as-is, they are tradable)
    let currentSymbol = state.mainChartData?.symbol || '';

    // Normalize KENYAN to KENYA for consistency
    if (currentSymbol === 'KENYAN') currentSymbol = 'KENYA';

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

    // Use main chart data if available, otherwise generate
    if (state.chartData && state.chartData.length > 0) {
        state.hubChartData = [...state.chartData];
    } else {
        state.hubChartData = generateHubChartData();
    }

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

    // Draw hub chart with multiple attempts for layout using requestAnimationFrame
    requestAnimationFrame(() => {
        drawHubChart();
        setTimeout(drawHubChart, 100);
        setTimeout(drawHubChart, 300);
        setTimeout(drawHubChart, 600);
        setTimeout(drawHubChart, 1000);
    });

    // Setup hub chart crosshair and tooltip events
    setupHubChartCrosshair();
}

// =============================================
// HUB CHART CROSSHAIR
// =============================================

function setupHubChartCrosshair() {
    const canvas = document.getElementById('hubPriceChart');
    const wrapper = document.getElementById('hub-canvas-wrapper');
    const crosshair = document.getElementById('hub-crosshair');
    const tooltip = document.getElementById('hub-tooltip');

    if (!canvas || !wrapper || !crosshair || !tooltip) return;

    // Remove old listeners if any (prevent duplicates)
    canvas.removeEventListener('mousemove', hubChartMouseMove);
    canvas.removeEventListener('mouseleave', hubChartMouseLeave);
    wrapper.removeEventListener('mouseleave', hubChartMouseLeave);

    // Add event listeners
    canvas.addEventListener('mousemove', hubChartMouseMove);
    canvas.addEventListener('mouseleave', hubChartMouseLeave);
    wrapper.addEventListener('mouseleave', hubChartMouseLeave);
}

function hubChartMouseMove(e) {
    const canvas = document.getElementById('hubPriceChart');
    const crosshair = document.getElementById('hub-crosshair');
    const tooltip = document.getElementById('hub-tooltip');
    const meta = window.hubChartMeta;

    if (!canvas || !crosshair || !tooltip || !meta || !meta.data || meta.data.length === 0) {
        return;
    }

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const { padding, chartWidth, chartHeight, width, height, minPrice, maxPrice } = meta;

    // Check if mouse is in chart area
    if (x < padding.left || x > width - padding.right ||
        y < padding.top || y > padding.top + chartHeight) {
        crosshair.style.display = 'none';
        tooltip.classList.remove('visible');
        return;
    }

    // Find data point
    const relX = x - padding.left;
    const index = Math.round((relX / chartWidth) * (meta.data.length - 1));
    const dataPoint = meta.data[Math.max(0, Math.min(index, meta.data.length - 1))];

    if (!dataPoint || !dataPoint.date) return;

    // Show crosshair
    crosshair.style.display = 'block';
    crosshair.querySelector('.hub-crosshair-v').style.left = x + 'px';
    crosshair.querySelector('.hub-crosshair-h').style.top = y + 'px';

    // Format date
    const date = dataPoint.date instanceof Date ? dataPoint.date : new Date(dataPoint.date);
    const dateStr = date.toLocaleDateString('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
    });

    // Calculate change (safe against NaN/undefined)
    const dpOpen = Number(dataPoint.open) || 0;
    const dpHigh = Number(dataPoint.high) || 0;
    const dpLow = Number(dataPoint.low) || 0;
    const dpClose = Number(dataPoint.close) || 0;
    const change = dpOpen > 0 ? ((dpClose - dpOpen) / dpOpen * 100) : 0;
    const changeClass = change >= 0 ? 'up' : 'down';
    const changeSign = change >= 0 ? '+' : '';

    // Build tooltip content
    tooltip.innerHTML = `
        <div class="hub-tooltip-date">${dateStr}</div>
        <div class="hub-tooltip-row">
            <span class="hub-tooltip-label">Open</span>
            <span class="hub-tooltip-value">$${dpOpen.toFixed(3)}</span>
        </div>
        <div class="hub-tooltip-row">
            <span class="hub-tooltip-label">High</span>
            <span class="hub-tooltip-value up">$${dpHigh.toFixed(3)}</span>
        </div>
        <div class="hub-tooltip-row">
            <span class="hub-tooltip-label">Low</span>
            <span class="hub-tooltip-value down">$${dpLow.toFixed(3)}</span>
        </div>
        <div class="hub-tooltip-row">
            <span class="hub-tooltip-label">Close</span>
            <span class="hub-tooltip-value">$${dpClose.toFixed(3)}</span>
        </div>
        <div class="hub-tooltip-row">
            <span class="hub-tooltip-label">Change</span>
            <span class="hub-tooltip-value ${changeClass}">${changeSign}${change.toFixed(2)}%</span>
        </div>
        <div class="hub-tooltip-row">
            <span class="hub-tooltip-label">Volume</span>
            <span class="hub-tooltip-value">${formatVolume(dataPoint.volume || 0)} kg</span>
        </div>
    `;

    // Position tooltip
    let tooltipX = x + 15;
    let tooltipY = y - 10;

    // Keep tooltip in bounds
    if (tooltipX + 190 > width) tooltipX = x - 185;
    if (tooltipY + 180 > height) tooltipY = y - 170;
    if (tooltipY < 10) tooltipY = 10;

    tooltip.style.left = tooltipX + 'px';
    tooltip.style.top = tooltipY + 'px';
    tooltip.classList.add('visible');
}

function hubChartMouseLeave() {
    const crosshair = document.getElementById('hub-crosshair');
    const tooltip = document.getElementById('hub-tooltip');

    if (crosshair) crosshair.style.display = 'none';
    if (tooltip) tooltip.classList.remove('visible');
}

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

    // Fallback to generation if cache is empty
    if (!data || data.length === 0) {
        let currentPrice;
        if (isIndex) {
            const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
            const index = indexes.find(idx => idx.symbol === lookupSymbol);
            currentPrice = index?.price || 3.50;
        } else {
            const tea = state.teas?.find(t => t.symbol === symbol);
            currentPrice = tea?.current_price || 3.50;
        }

        data = [];
        let price = currentPrice;
        const now = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;

        // Use a seeded random based on symbol to ensure consistency
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

        // Store in unified cache for consistency
        const cacheKey = symbolType === 'index' ? `INDEX_${lookupSymbol}` : lookupSymbol;
        state.priceDataCache.data[cacheKey] = data;
        state.priceDataCache.lastUpdate[cacheKey] = Date.now();
    }

    return data;
}

function generateHubChartData() {
    const symbol = document.getElementById('hub-buy-symbol')?.value || 'KENYA';

    const lookupSymbol = symbol === 'KENYAN' ? 'KENYA' : symbol;
    const isIndex = isIndexSymbol(lookupSymbol);
    const symbolType = isIndex ? 'index' : 'tea';

    let data = getPriceHistorySync(lookupSymbol, symbolType);

    // If no cached data, generate initial data
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

    const lastPrice = state.hubChartData[state.hubChartData.length - 1].close;
    const firstPrice = state.hubChartData[0].close;
    const change = ((lastPrice - firstPrice) / firstPrice) * 100;

    const priceEl = document.getElementById('hub-chart-price');
    const changeEl = document.getElementById('hub-chart-change');

    if (priceEl) {
        priceEl.textContent = `$${lastPrice.toFixed(2)}`;
        priceEl.className = 'trading-hub-price ' + (change >= 0 ? 'up' : 'down');
    }

    if (changeEl) {
        changeEl.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
        changeEl.className = 'trading-hub-change ' + (change >= 0 ? 'up' : 'down');
    }
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

    if (position && position.quantity > 0) {
        const pnl = (currentPrice - position.avg_entry_price) * position.quantity;
        const pnlPercent = position.avg_entry_price > 0 ? ((currentPrice / position.avg_entry_price) - 1) * 100 : 0;

        if (qtyEl) qtyEl.textContent = `${position.quantity.toLocaleString()} kg`;
        if (entryEl) entryEl.textContent = `$${position.avg_entry_price.toFixed(2)}`;
        if (pnlEl) {
            pnlEl.textContent = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`;
            pnlEl.style.color = pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
        }
    } else {
        if (qtyEl) qtyEl.textContent = '0 kg';
        if (entryEl) entryEl.textContent = '$\u2014';
        if (pnlEl) {
            pnlEl.textContent = '$0.00';
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

function drawHubChart() {
    const canvas = document.getElementById('hubPriceChart');
    const wrapper = document.getElementById('hub-canvas-wrapper');

    if (!canvas || !wrapper) {
        return;
    }

    // Ensure we have data
    if (!state.hubChartData || state.hubChartData.length === 0) {
        state.hubChartData = generateHubChartData();
    }

    // Get dimensions - try multiple methods
    let width = wrapper.offsetWidth;
    let height = wrapper.offsetHeight;

    // If still no dimensions, use getBoundingClientRect
    if (width < 100 || height < 100) {
        const rect = wrapper.getBoundingClientRect();
        width = rect.width;
        height = rect.height;
    }

    // Final fallback - use viewport-based dimensions
    if (width < 100) width = (window.innerWidth - 400) * 0.9;
    if (height < 100) height = 350;

    // Set canvas size
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = Math.floor(width) + 'px';
    canvas.style.height = Math.floor(height) + 'px';

    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    const padding = { top: 25, right: 65, bottom: 35, left: 25 };

    // Clear canvas and fill with background
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, width, height);

    // Safety check for data validity
    if (!state.hubChartData || state.hubChartData.length === 0) {
        ctx.fillStyle = '#888';
        ctx.font = '14px sans-serif';
        ctx.fillText('No chart data available', width / 2 - 80, height / 2);
        return;
    }

    // Calculate price range with Y-axis stabilization
    let dataMinPrice = Infinity, dataMaxPrice = -Infinity;
    state.hubChartData.forEach(d => {
        if (d && typeof d.low === 'number' && typeof d.high === 'number') {
            dataMinPrice = Math.min(dataMinPrice, d.low);
            dataMaxPrice = Math.max(dataMaxPrice, d.high);
        }
    });

    // Expand range to include entry price if user has a position
    if (window.hubEntryPrice && isFinite(window.hubEntryPrice)) {
        dataMinPrice = Math.min(dataMinPrice, window.hubEntryPrice);
        dataMaxPrice = Math.max(dataMaxPrice, window.hubEntryPrice);
    }

    // Fallback if prices are invalid
    if (!isFinite(dataMinPrice) || !isFinite(dataMaxPrice) || dataMinPrice === dataMaxPrice) {
        dataMinPrice = 3.0;
        dataMaxPrice = 4.0;
    }

    // Y-AXIS STABILIZATION: Use wider, stable range to prevent frequent rescaling
    const dataRange = dataMaxPrice - dataMinPrice;
    const midPrice = (dataMaxPrice + dataMinPrice) / 2;

    // Minimum range is 10% of mid price (prevents tiny ranges from zooming in too much)
    const minRange = midPrice * 0.10;
    const stableRange = Math.max(dataRange, minRange);

    // Add extra padding (20% on each side) for headroom
    let minPrice = midPrice - (stableRange * 0.7);
    let maxPrice = midPrice + (stableRange * 0.7);

    // Use cached Y-axis bounds if data is within 80% of current range (prevents flickering)
    const hubSymbol = document.getElementById('hub-buy-symbol')?.value || 'KENYA';
    if (!window.hubYAxisCache) window.hubYAxisCache = {};

    if (window.hubYAxisCache[hubSymbol]) {
        const cached = window.hubYAxisCache[hubSymbol];
        const cachedRange = cached.max - cached.min;
        if (dataMinPrice >= cached.min + cachedRange * 0.1 &&
            dataMaxPrice <= cached.max - cachedRange * 0.1) {
            minPrice = cached.min;
            maxPrice = cached.max;
        } else {
            window.hubYAxisCache[hubSymbol] = { min: minPrice, max: maxPrice };
        }
    } else {
        window.hubYAxisCache[hubSymbol] = { min: minPrice, max: maxPrice };
    }

    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const getX = (i) => padding.left + (i / (state.hubChartData.length - 1)) * chartWidth;
    const getY = (price) => padding.top + (1 - (price - minPrice) / (maxPrice - minPrice)) * chartHeight;

    // Draw grid
    ctx.strokeStyle = '#1a2332';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padding.top + (i / 4) * chartHeight;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();
    }

    // Draw average price line (dashed)
    const avgPrice = state.hubChartData.reduce((sum, d) => sum + d.close, 0) / state.hubChartData.length;
    const avgY = getY(avgPrice);
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padding.left, avgY);
    ctx.lineTo(width - padding.right, avgY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw studies
    if (state.hubStudies.bollinger) {
        const period = 20;
        const multiplier = 2;

        if (state.hubChartData.length >= period) {
            ctx.fillStyle = 'rgba(96, 165, 250, 0.1)';
            ctx.beginPath();

            for (let i = period - 1; i < state.hubChartData.length; i++) {
                const slice = state.hubChartData.slice(i - period + 1, i + 1);
                const avg = slice.reduce((a, b) => a + b.close, 0) / period;
                const stdDev = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b.close - avg, 2), 0) / period);
                const upper = avg + multiplier * stdDev;

                const x = getX(i);
                if (i === period - 1) {
                    ctx.moveTo(x, getY(upper));
                } else {
                    ctx.lineTo(x, getY(upper));
                }
            }

            for (let i = state.hubChartData.length - 1; i >= period - 1; i--) {
                const slice = state.hubChartData.slice(i - period + 1, i + 1);
                const avg = slice.reduce((a, b) => a + b.close, 0) / period;
                const stdDev = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b.close - avg, 2), 0) / period);
                const lower = avg - multiplier * stdDev;
                ctx.lineTo(getX(i), getY(lower));
            }

            ctx.closePath();
            ctx.fill();
        }
    }

    if (state.hubStudies.sma10) {
        drawHubSMA(ctx, 10, '#facc15', getX, getY);
    }

    if (state.hubStudies.sma20) {
        drawHubSMA(ctx, 20, '#f59e0b', getX, getY);
    }

    // Draw price line or candles
    if (state.hubChartType === 'line') {
        ctx.beginPath();
        state.hubChartData.forEach((d, i) => {
            if (i === 0) {
                ctx.moveTo(getX(i), getY(d.close));
            } else {
                ctx.lineTo(getX(i), getY(d.close));
            }
        });
        ctx.strokeStyle = '#1a73e8';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Draw subtle area fill matching main chart
        ctx.lineTo(getX(state.hubChartData.length - 1), height - padding.bottom);
        ctx.lineTo(getX(0), height - padding.bottom);
        ctx.closePath();
        ctx.fillStyle = 'rgba(26, 115, 232, 0.15)';
        ctx.fill();
    } else {
        // Draw candles
        const candleWidth = Math.max(2, (chartWidth / state.hubChartData.length) - 2);

        state.hubChartData.forEach((d, i) => {
            const x = getX(i);
            const isUp = d.close >= d.open;

            ctx.fillStyle = isUp ? '#10b981' : '#ef4444';
            ctx.strokeStyle = isUp ? '#10b981' : '#ef4444';

            // Draw wick
            ctx.beginPath();
            ctx.moveTo(x, getY(d.high));
            ctx.lineTo(x, getY(d.low));
            ctx.lineWidth = 1;
            ctx.stroke();

            // Draw body
            const bodyTop = getY(Math.max(d.open, d.close));
            const bodyBottom = getY(Math.min(d.open, d.close));
            const bodyHeight = Math.max(1, bodyBottom - bodyTop);
            ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
        });
    }

    // Draw price labels on right axis
    ctx.fillStyle = '#9ca3af';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    for (let i = 0; i <= 4; i++) {
        const price = maxPrice - (i / 4) * (maxPrice - minPrice);
        const y = padding.top + (i / 4) * chartHeight;
        ctx.fillText(`$${price.toFixed(2)}`, width - padding.right + 5, y + 3);
    }

    // Draw last price callout
    const lastPrice = state.hubChartData[state.hubChartData.length - 1].close;
    const lastY = getY(lastPrice);
    const isUp = state.hubChartData.length > 1 && state.hubChartData[state.hubChartData.length - 1].close >= state.hubChartData[state.hubChartData.length - 2].close;

    ctx.fillStyle = isUp ? '#10b981' : '#ef4444';
    ctx.fillRect(width - padding.right, lastY - 10, padding.right, 20);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px JetBrains Mono, monospace';
    ctx.fillText(`$${lastPrice.toFixed(2)}`, width - padding.right + 5, lastY + 4);

    // Draw user's entry price line if they have a position
    if (window.hubEntryPrice && window.hubEntryPrice >= minPrice && window.hubEntryPrice <= maxPrice) {
        const entryY = getY(window.hubEntryPrice);
        const isProfit = lastPrice >= window.hubEntryPrice;
        const pnlColor = isProfit ? '#10b981' : '#ef4444';

        // Draw dotted entry line
        ctx.strokeStyle = pnlColor;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(padding.left, entryY);
        ctx.lineTo(width - padding.right, entryY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw entry price label on left side
        const pnlDiff = lastPrice - window.hubEntryPrice;
        const pnlPercent = ((lastPrice / window.hubEntryPrice) - 1) * 100;
        const labelText = `Entry $${window.hubEntryPrice.toFixed(2)}`;
        const pnlText = `${pnlDiff >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%`;

        // Draw label background on left
        ctx.fillStyle = pnlColor;
        const labelWidth = 85;
        ctx.fillRect(0, entryY - 10, labelWidth, 20);

        // Draw text
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 9px JetBrains Mono, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(labelText, 4, entryY + 3);

        // Draw P/L badge on right side of entry line
        ctx.fillStyle = pnlColor;
        ctx.fillRect(width - padding.right, entryY - 10, padding.right, 20);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px JetBrains Mono, monospace';
        ctx.fillText(pnlText, width - padding.right + 8, entryY + 4);
    }

    // Draw hub RSI if enabled
    if (state.hubStudies.rsi) {
        drawHubRsi();
    }

    // Store chart metadata for crosshair interaction
    window.hubChartMeta = {
        data: state.hubChartData,
        padding: padding,
        minPrice: minPrice,
        maxPrice: maxPrice,
        chartWidth: chartWidth,
        chartHeight: chartHeight,
        width: width,
        height: height,
        getX: getX,
        getY: getY
    };
}

function drawHubSMA(ctx, period, color, getX, getY) {
    if (state.hubChartData.length < period) return;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;

    let started = false;
    for (let i = period - 1; i < state.hubChartData.length; i++) {
        const slice = state.hubChartData.slice(i - period + 1, i + 1);
        const avg = slice.reduce((a, b) => a + b.close, 0) / period;

        if (!started) {
            ctx.moveTo(getX(i), getY(avg));
            started = true;
        } else {
            ctx.lineTo(getX(i), getY(avg));
        }
    }
    ctx.stroke();
}

function drawHubRsi() {
    const canvas = document.getElementById('hubRsiChart');
    if (!canvas || state.hubChartData.length < 15) return;

    const container = canvas.parentElement;
    canvas.style.height = `${state.hubRsiHeight}px`;

    const dpr = window.devicePixelRatio || 1;
    const width = container.offsetWidth;
    const height = state.hubRsiHeight;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const padding = { top: 10, right: 60, bottom: 10, left: 20 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    // Calculate RSI values
    const rsiValues = [];
    const period = 14;

    for (let i = period; i < state.hubChartData.length; i++) {
        let gains = 0, losses = 0;
        for (let j = i - period + 1; j <= i; j++) {
            const change = state.hubChartData[j].close - state.hubChartData[j - 1].close;
            if (change > 0) gains += change;
            else losses -= change;
        }
        const avgGain = gains / period;
        const avgLoss = losses / period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        const rsi = 100 - (100 / (1 + rs));
        rsiValues.push({ index: i, rsi });
    }

    // Clear canvas
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'var(--bg-card)';
    ctx.fillRect(0, 0, width, height);

    // Draw overbought/oversold zones
    const getY = (rsi) => padding.top + (1 - rsi / 100) * chartHeight;
    const getX = (i) => padding.left + ((i - period) / (state.hubChartData.length - period - 1)) * chartWidth;

    // Overbought zone (70-100)
    ctx.fillStyle = 'rgba(239, 68, 68, 0.1)';
    ctx.fillRect(padding.left, getY(100), chartWidth, getY(70) - getY(100));

    // Oversold zone (0-30)
    ctx.fillStyle = 'rgba(16, 185, 129, 0.1)';
    ctx.fillRect(padding.left, getY(30), chartWidth, getY(0) - getY(30));

    // Draw horizontal lines
    ctx.strokeStyle = '#2a2a3e';
    ctx.lineWidth = 1;
    [30, 50, 70].forEach(level => {
        const y = getY(level);
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();

        ctx.fillStyle = '#6b7280';
        ctx.font = '9px JetBrains Mono';
        ctx.fillText(level.toString(), width - padding.right + 5, y + 3);
    });

    // Draw RSI line
    ctx.beginPath();
    ctx.strokeStyle = '#ec4899';
    ctx.lineWidth = 2;

    rsiValues.forEach((r, i) => {
        const x = getX(r.index);
        const y = getY(r.rsi);
        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    });
    ctx.stroke();

    // Update RSI value display
    if (rsiValues.length > 0) {
        const lastRsi = rsiValues[rsiValues.length - 1].rsi;
        const rsiValueEl = document.getElementById('hub-rsi-value');
        if (rsiValueEl) {
            rsiValueEl.textContent = lastRsi.toFixed(1);
            rsiValueEl.style.color = lastRsi >= 70 ? '#ef4444' : lastRsi <= 30 ? '#10b981' : '#9ca3af';
        }
    }
}

// =============================================
// HUB CONTROLS
// =============================================

function toggleHubTimeframeMenu() {
    const menu = document.getElementById('hub-timeframe-menu');
    if (menu) {
        menu.classList.toggle('show');
    }
}

function setHubTimeframe(tf) {
    state.hubTimeframe = tf;
    document.getElementById('hub-timeframe-label').textContent = tf;
    closeAllDropdowns();

    // Also update main chart timeframe to keep in sync
    setTimeframe(tf);
    state.hubChartData = [...state.chartData];
    drawHubChart();
}

function toggleHubStudiesMenu() {
    const menu = document.getElementById('hub-studies-menu');
    if (menu) {
        menu.classList.toggle('show');
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

    // Helper to get price for symbol (tea or index)
    const getPriceForSymbol = (symbol) => {
        const lookupSymbol = symbol === 'KENYAN' ? 'KENYA' : symbol;
        if (isIndexSymbol(lookupSymbol)) {
            const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
            const index = indexes.find(idx => idx.symbol === lookupSymbol);
            return index?.price || 3.50;
        } else {
            const tea = state.teas?.find(t => t.symbol === symbol);
            return tea?.current_price || 3.50;
        }
    };

    const buyPrice = getPriceForSymbol(buySymbol);
    const sellPrice = getPriceForSymbol(sellSymbol);

    // Buy preview
    const buyTotal = buyQty * buyPrice;
    const buyCommission = buyTotal * 0.001;
    document.getElementById('hub-buy-est-price').textContent = `$${buyPrice.toFixed(2)}/kg`;
    document.getElementById('hub-buy-total-cost').textContent = `$${buyTotal.toFixed(2)}`;
    document.getElementById('hub-buy-commission').textContent = `$${buyCommission.toFixed(2)}`;

    // Sell preview
    const sellTotal = sellQty * sellPrice;
    const sellCommission = sellTotal * 0.001;
    document.getElementById('hub-sell-est-price').textContent = `$${sellPrice.toFixed(2)}/kg`;
    document.getElementById('hub-sell-total-cost').textContent = `$${sellTotal.toFixed(2)}`;
    document.getElementById('hub-sell-commission').textContent = `$${sellCommission.toFixed(2)}`;

    // Handle limit price visibility
    const buyOrderType = document.getElementById('hub-buy-order-type')?.value;
    const sellOrderType = document.getElementById('hub-sell-order-type')?.value;

    document.getElementById('hub-buy-limit-price-group').style.display = buyOrderType === 'limit' ? 'block' : 'none';
    document.getElementById('hub-sell-limit-price-group').style.display = sellOrderType === 'limit' ? 'block' : 'none';

    // Update position display
    updateHubPositionInfo();

    // Update chart title to match selected symbol
    const hubTitle = document.getElementById('hub-chart-title');
    const indexSymbols = ['KENYA', 'KENYAN', 'INDIA', 'CEYLON', 'CHINA', 'JAPAN', 'AFRICA', 'ASIA'];
    const isIndex = indexSymbols.includes(buySymbol);

    const priceDisplay = document.querySelector('#trading-hub-chart-panel .price-display h3');
    const changeDisplay = document.querySelector('#trading-hub-chart-panel .price-display .change');

    if (isIndex) {
        const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
        const lookupSymbol = buySymbol === 'KENYAN' ? 'KENYA' : buySymbol;
        const index = indexes.find(idx => idx.symbol === lookupSymbol);
        if (hubTitle && index) {
            hubTitle.textContent = index.name || buySymbol;
        }
        if (priceDisplay && index) {
            priceDisplay.textContent = `$${index.price?.toFixed(2) || '0.00'}`;
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

    if (!quantity || quantity <= 0) {
        showToast('Please enter a valid quantity', 'error');
        return;
    }

    // Check if this is an index trade
    const lookupSymbol = symbol === 'KENYAN' ? 'KENYA' : symbol;
    const isIndex = isIndexSymbol(lookupSymbol);

    let price, productName, teaId = null;

    if (isIndex) {
        // INDEX TRADE
        const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
        const index = indexes.find(idx => idx.symbol === lookupSymbol);

        if (!index) {
            showToast('Index not found', 'error');
            return;
        }

        price = orderType === 'limit'
            ? parseFloat(document.getElementById(`hub-${side}-limit-price`)?.value)
            : index.price || 3.50;
        productName = index.name || symbol;

        // Use first underlying tea's ID for database reference
        const underlyingTea = state.teas?.find(t => index.teas?.includes(t.symbol));
        teaId = underlyingTea?.id || null;

    } else {
        // TEA TRADE
        const tea = state.teas?.find(t => t.symbol === symbol);
        if (!tea) {
            showToast('Product not found. Please select a valid symbol.', 'error');
            return;
        }

        price = orderType === 'limit'
            ? parseFloat(document.getElementById(`hub-${side}-limit-price`)?.value)
            : tea.current_price || 3.50;
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
                state.userProfile.cash_balance = result.new_balance;
            }
            showToast(
                `${orderType.toUpperCase()} ${side.toUpperCase()} order placed`,
                `${symbol} ${quantity} kg @ $${price.toFixed(2)} — will fill when price is reached`
            );
            loadPendingOrders();
        } else if (isIndex) {
            const result = await apiExecuteIndexTrade(lookupSymbol, side.toUpperCase(), quantity, price);
            if (!result.success) {
                throw new Error(result.error || 'Index trade failed');
            }
            state.userProfile.cash_balance = result.new_balance;
            showToast(`${side.toUpperCase()} order filled: ${symbol} ${quantity} kg @ $${price.toFixed(2)}`, 'success');
        } else {
            const result = await apiExecuteTrade(symbol, side.toUpperCase(), quantity);
            if (!result.success) {
                throw new Error(result.error || 'Trade failed');
            }
            state.userProfile.cash_balance = result.new_balance;
            showToast(`${side.toUpperCase()} order filled: ${symbol} ${quantity} kg @ $${price.toFixed(2)}`, 'success');
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
    // Clear existing
    tradeLogEntries = [];
    if (state.tradeLogInterval) clearInterval(state.tradeLogInterval);

    // Generate initial entries
    const symbols = ['TEA-KE', 'TEA-LK', 'TEA-IN', 'TEA-CN', 'TEA-JP'];
    for (let i = 0; i < 8; i++) {
        const symbol = symbols[Math.floor(Math.random() * symbols.length)];
        const tea = state.teas?.find(t => t.symbol === symbol);
        const basePrice = tea?.current_price || (3 + Math.random() * 2);

        tradeLogEntries.push({
            time: new Date(Date.now() - (i * 5000) - Math.random() * 60000),
            symbol: symbol,
            side: Math.random() > 0.5 ? 'buy' : 'sell',
            quantity: Math.round((100 + Math.random() * 900) / 50) * 50,
            price: basePrice + (Math.random() - 0.5) * 0.1
        });
    }

    renderTradeLog();

    // Simulate new trades
    state.tradeLogInterval = setInterval(() => {
        if (!state.maximizedPanel?.classList.contains('panel-maximized')) {
            clearInterval(state.tradeLogInterval);
            return;
        }

        const symbol = symbols[Math.floor(Math.random() * symbols.length)];
        const tea = state.teas?.find(t => t.symbol === symbol);
        const basePrice = tea?.current_price || (3 + Math.random() * 2);

        addTradeToLog({
            time: new Date(),
            symbol: symbol,
            side: Math.random() > 0.5 ? 'buy' : 'sell',
            quantity: Math.round((100 + Math.random() * 900) / 50) * 50,
            price: basePrice + (Math.random() - 0.5) * 0.1
        });
    }, 3000 + Math.random() * 5000);
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

        return `
            <div class="trade-log-item">
                <span class="trade-log-time">${time}</span>
                <span class="trade-log-symbol">${escapeHtml(symbolShort)}</span>
                <span class="trade-log-side ${trade.side}">${escapeHtml(trade.side.toUpperCase())}</span>
                <span class="trade-log-qty">${trade.quantity.toLocaleString()} kg</span>
                <span class="trade-log-price">$${trade.price.toFixed(2)}</span>
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
