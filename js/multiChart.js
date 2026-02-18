/**
 * TeaTrade Exchange - Multi-Chart Dashboard Modal (multiChart.js)
 * ===============================================================
 * Side-by-side chart panels (up to 4) with live price updates.
 *
 * Globals from config.js : state, isIndexSymbol
 * Globals from market.js : getPriceHistorySync
 * Globals from utils.js  : showToast
 */

// =============================================
// MODAL OPEN / CLOSE
// =============================================

function openMultiChartModal() {
    const modal = document.getElementById('multi-chart-modal');
    if (!modal) return;

    modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    // Initialize with one empty panel if no panels exist
    if (state.multiChartPanels.length === 0) {
        addMultiChart();
    } else {
        renderMultiChartPanels();
    }
}

function closeMultiChartModal() {
    const modal = document.getElementById('multi-chart-modal');
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }
}

// =============================================
// PANEL MANAGEMENT
// =============================================

function addMultiChart(prefillSymbol = null) {
    if (state.multiChartPanels.length >= 4) {
        showToast('Maximum Charts', 'You can add up to 4 charts');
        return;
    }

    const panelId = state.multiChartNextId++;
    let tea = null;

    if (prefillSymbol) {
        tea = state.teas.find(t => t.symbol === prefillSymbol);
    }

    state.multiChartPanels.push({ id: panelId, symbol: prefillSymbol, tea: tea });
    updateMultiChartGridClass();
    renderMultiChartPanels();
}

function removeMultiChartPanel(panelId) {
    state.multiChartPanels = state.multiChartPanels.filter(p => p.id !== panelId);
    updateMultiChartGridClass();
    renderMultiChartPanels();
}

// =============================================
// GRID LAYOUT
// =============================================

function updateMultiChartGridClass() {
    const grid = document.getElementById('multi-chart-grid');
    if (!grid) return;

    grid.classList.remove('single', 'double', 'triple');

    switch (state.multiChartPanels.length) {
        case 1:
            grid.classList.add('single');
            break;
        case 2:
            grid.classList.add('double');
            break;
        case 3:
            grid.classList.add('triple');
            break;
        // 4 panels uses default 2x2 grid
    }
}

// =============================================
// RENDER PANELS
// =============================================

function renderMultiChartPanels() {
    const grid = document.getElementById('multi-chart-grid');
    if (!grid) return;

    let html = '';

    state.multiChartPanels.forEach(panel => {
        if (panel.tea && panel.symbol) {
            // Panel with a tea selected
            const change = panel.tea.price_change_24h || 0;
            const isUp = change >= 0;
            const shortSymbol = panel.symbol.split('-')[1] || panel.symbol;
            const origin = panel.symbol.split('-')[0] || '';

            html += `
                <div class="mc-chart-panel" data-panel-id="${panel.id}">
                    <div class="mc-panel-header">
                        <div class="mc-panel-symbol">
                            <span class="mc-panel-symbol-name">${origin} ${shortSymbol}</span>
                            <span class="mc-panel-price ${isUp ? 'up' : 'down'}">$${panel.tea.current_price.toFixed(2)} (${isUp ? '+' : ''}${change.toFixed(1)}%)</span>
                        </div>
                        <div class="mc-panel-actions">
                            <button class="mc-panel-btn trade" onclick="openQuickQuoteModal(state.teas.find(t => t.symbol === '${panel.symbol}'))">Trade</button>
                            <button class="mc-panel-btn close" onclick="removeMultiChartPanel(${panel.id})">×</button>
                        </div>
                    </div>
                    <div class="mc-panel-chart">
                        <canvas id="mc-chart-${panel.id}"></canvas>
                    </div>
                </div>
            `;
        } else {
            // Empty panel - show tea selector
            html += `
                <div class="mc-chart-panel empty" data-panel-id="${panel.id}" onclick="showMultiChartTeaSelector(${panel.id}, event)">
                    <div class="mc-empty-placeholder">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                        <span>Click to add chart</span>
                    </div>
                </div>
            `;
        }
    });

    grid.innerHTML = html;

    // Draw charts for panels with teas
    requestAnimationFrame(() => {
        state.multiChartPanels.forEach(panel => {
            if (panel.tea) {
                drawMultiChartPanel(panel.id, panel.tea);
            }
        });
    });
}

// =============================================
// TEA SELECTOR DROPDOWN
// =============================================

function showMultiChartTeaSelector(panelId, event) {
    event.stopPropagation();

    // Remove any existing selector
    const existingSelector = document.querySelector('.mc-tea-selector');
    if (existingSelector) existingSelector.remove();

    // Create tea selector dropdown
    const selector = document.createElement('div');
    selector.className = 'mc-tea-selector';

    let options = '<div class="mc-tea-selector-header">Select a Tea</div><div class="mc-tea-selector-list">';

    state.teas.slice(0, 15).forEach(tea => {
        const shortSymbol = tea.symbol.split('-')[1] || tea.symbol;
        const origin = tea.symbol.split('-')[0] || '';
        const isUp = (tea.price_change_24h || 0) >= 0;

        options += `
            <div class="mc-tea-option" onclick="selectMultiChartTea(${panelId}, '${tea.symbol}')">
                <span class="mc-tea-option-symbol">${origin} ${shortSymbol}</span>
                <span class="mc-tea-option-price ${isUp ? 'up' : 'down'}">$${tea.current_price.toFixed(2)}</span>
            </div>
        `;
    });

    options += '</div>';
    selector.innerHTML = options;

    // Add to grid
    document.getElementById('multi-chart-grid').appendChild(selector);

    // Close on outside click
    setTimeout(() => {
        document.addEventListener('click', function closeSelector(e) {
            if (!selector.contains(e.target)) {
                selector.remove();
                document.removeEventListener('click', closeSelector);
            }
        });
    }, 10);
}

function selectMultiChartTea(panelId, symbol) {
    const panel = state.multiChartPanels.find(p => p.id === panelId);
    if (!panel) return;

    const tea = state.teas.find(t => t.symbol === symbol);
    panel.symbol = symbol;
    panel.tea = tea;

    // Remove selector
    const selector = document.querySelector('.mc-tea-selector');
    if (selector) selector.remove();

    renderMultiChartPanels();
}

// =============================================
// DRAW MINI CHART
// =============================================

function drawMultiChartPanel(panelId, tea) {
    const canvas = document.getElementById(`mc-chart-${panelId}`);
    if (!canvas || !tea) return;

    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const w = rect.width;
    const h = rect.height;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.scale(dpr, dpr);

    const price = tea.current_price || 3.5;
    const change = tea.price_change_24h || 0;
    const isUp = change >= 0;

    // Get historical data from unified cache (database-backed)
    let fullHistory = getPriceHistorySync(tea.symbol, 'tea');
    if (!fullHistory || fullHistory.length === 0) return;

    const historySlice = fullHistory.slice(-48);

    const padding = { top: 15, right: 50, bottom: 20, left: 40 };
    const chartWidth = w - padding.left - padding.right;
    const chartHeight = h - padding.top - padding.bottom;

    const lows = historySlice.map(d => Number(d.low) || 0).filter(p => p > 0);
    const highs = historySlice.map(d => Number(d.high) || 0).filter(p => p > 0);
    if (lows.length === 0 || highs.length === 0) return;
    const minPrice = Math.min(...lows) * 0.998;
    const maxPrice = Math.max(...highs) * 1.002;

    // Clear
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(0, 0, w, h);

    // Draw simple grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
        const y = padding.top + (chartHeight / 3) * i;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(w - padding.right, y);
        ctx.stroke();
    }

    // Draw line chart with gradient
    const gradient = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom);
    gradient.addColorStop(0, isUp ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)');
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

    // Current price label
    const currentY = padding.top + ((maxPrice - price) / (maxPrice - minPrice)) * chartHeight;
    ctx.fillStyle = isUp ? '#10b981' : '#ef4444';
    ctx.fillRect(w - padding.right + 2, currentY - 7, 45, 14);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 9px JetBrains Mono';
    ctx.textAlign = 'left';
    ctx.fillText(`$${price.toFixed(2)}`, w - padding.right + 5, currentY + 3);
}

// =============================================
// LIVE PRICE UPDATES (called by market.js sim)
// =============================================

function updateMultiChartPrices() {
    state.multiChartPanels.forEach(panel => {
        if (!panel || !panel.tea) return;

        // Find updated tea
        const tea = state.teas.find(t => t.id === panel.tea.id);
        if (tea) {
            panel.tea = tea;

            // Redraw panel
            drawMultiChartPanel(panel.id, tea);
        }
    });
}

// =============================================
// KEYBOARD SHORTCUT
// =============================================

document.addEventListener('keydown', (e) => {
    if (e.key === 'm' && e.ctrlKey) {
        e.preventDefault();
        openMultiChartModal();
    }
});
