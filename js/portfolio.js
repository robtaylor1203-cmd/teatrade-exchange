/**
 * TeaTrade Exchange — Portfolio, Orders, Trade Log & Leaderboard (portfolio.js)
 * ==============================================================================
 * Manages portfolio display, order history with filtering/sorting, the trade
 * log (closed-trade analytics), leaderboard rendering, and index-position
 * tracking (Supabase-backed).
 *
 * Globals used from config.js : state, isIndexSymbol
 * Globals used from api.js   : apiFetchPositions, apiFetchTrades,
 *     apiFetchLeaderboard, apiFetchIndexPositions, apiInsertIndexPosition,
 *     apiUpdateIndexPosition, apiDeleteIndexPosition
 * Globals used from market.js: calculateRegionalIndexes, getIndexPrice
 * Globals used from utils.js : showToast, formatDuration, formatDate, escapeHtml
 *
 * Functions called from other files (available at runtime as globals):
 *   closePairPosition, closeIndexPosition, closePosition,
 *   updateUIForLoggedInUser, openAuthModal
 */

// =============================================
// PORTFOLIO FUNCTIONS
// =============================================

async function loadPositions() {
    if (!state.currentUser) return;

    try {
        const { data, error } = await apiFetchPositions(state.currentUser.id);
        if (error) throw error;
        state.positions = data || [];
        updatePortfolioDisplay();
    } catch (error) {
        console.error('Failed to load positions:', error);
    }
}

function updatePortfolioDisplay() {
    const listEl = document.getElementById('positions-list');
    const valueEl = document.getElementById('portfolio-value');
    const pnlEl = document.getElementById('portfolio-pnl');

    const indexPositionsData = state.indexPositions || {};
    const hasIndexPositions = Object.keys(indexPositionsData).length > 0;

    if (state.positions.length === 0 && !hasIndexPositions) {
        listEl.innerHTML = `
            <div style="color: var(--text-muted); font-size: 12px; padding: 20px 0; text-align: center;">
                No positions yet. Start trading!
            </div>
        `;
        const totalValue = state.userProfile?.cash_balance || 10000;
        valueEl.textContent = '$' + totalValue.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
        const pnl = totalValue - 10000;
        const pnlPct = (pnl / 10000 * 100).toFixed(2);
        pnlEl.textContent = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct}%)`;
        pnlEl.className = 'portfolio-pnl ' + (pnl >= 0 ? 'up' : 'down');
        return;
    }

    let holdingsValue = 0;
    let html = '';

    // Display tea positions
    state.positions.forEach(pos => {
        const tea = pos.teas || state.teas.find(t => t.id === pos.tea_id);
        if (!tea) return;

        const currentValue = pos.quantity * tea.current_price;
        const costBasis = pos.quantity * pos.avg_entry_price;
        const pnl = currentValue - costBasis;
        const pnlPct = (pnl / costBasis * 100).toFixed(1);
        holdingsValue += currentValue;

        html += `
            <div class="position-item">
                <div>
                    <div class="position-tea">${escapeHtml(tea.symbol)}</div>
                    <div class="position-qty">${pos.quantity.toLocaleString()} kg @ $${pos.avg_entry_price.toFixed(2)}</div>
                </div>
                <div class="position-value">
                    <div class="position-current">$${currentValue.toFixed(2)}</div>
                    <div class="position-pnl ${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct}%)</div>
                </div>
            </div>
        `;
    });

    // Display index positions
    const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
    Object.entries(indexPositionsData).forEach(([symbol, pos]) => {
        const index = indexes.find(idx => idx.symbol === symbol);
        if (!index || !pos || pos.quantity <= 0) return;

        const currentValue = pos.quantity * index.price;
        const costBasis = pos.quantity * pos.avg_entry_price;
        const pnl = currentValue - costBasis;
        const pnlPct = costBasis > 0 ? (pnl / costBasis * 100).toFixed(1) : 0;
        holdingsValue += currentValue;

        html += `
            <div class="position-item">
                <div>
                    <div class="position-tea">${escapeHtml(symbol)} <span style="color: var(--accent-purple); font-size: 10px;">IDX</span></div>
                    <div class="position-qty">${pos.quantity.toLocaleString()} kg @ $${pos.avg_entry_price.toFixed(2)}</div>
                </div>
                <div class="position-value">
                    <div class="position-current">$${currentValue.toFixed(2)}</div>
                    <div class="position-pnl ${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct}%)</div>
                </div>
            </div>
        `;
    });

    listEl.innerHTML = html;

    const totalValue = (state.userProfile?.cash_balance || 0) + holdingsValue;
    valueEl.textContent = '$' + totalValue.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});

    const totalPnl = totalValue - 10000;
    const totalPnlPct = (totalPnl / 10000 * 100).toFixed(2);
    pnlEl.textContent = `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${totalPnlPct}%)`;
    pnlEl.className = 'portfolio-pnl ' + (totalPnl >= 0 ? 'up' : 'down');
}

// =============================================
// ORDER HISTORY FUNCTIONS
// =============================================

function setOrdersFilter(filter) {
    state.ordersFilter = filter;
    document.getElementById('filter-all').classList.toggle('active', filter === 'all');
    document.getElementById('filter-open').classList.toggle('active', filter === 'open');
    displayUserTrades(state.currentTradesData);
}

function sortOrdersTable(column) {
    if (state.ordersSortColumn === column) {
        state.ordersSortDirection = state.ordersSortDirection === 'desc' ? 'asc' : 'desc';
    } else {
        state.ordersSortColumn = column;
        state.ordersSortDirection = 'desc';
    }

    document.querySelectorAll('#orders-table th.sortable').forEach(th => {
        th.classList.remove('asc', 'desc');
        if (th.dataset.sort === column) {
            th.classList.add(state.ordersSortDirection);
        }
    });

    displayUserTrades(state.currentTradesData);
}

async function loadUserTrades() {
    if (!state.currentUser) {
        displayUserTrades([]);
        return;
    }

    try {
        const { data, error } = await apiFetchTrades(state.currentUser.id);
        if (error) throw error;
        state.currentTradesData = data || [];
        displayUserTrades(state.currentTradesData);
    } catch (error) {
        console.error('Failed to load trades:', error);
    }
}

function displayUserTrades(trades) {
    const tbody = document.getElementById('orders-tbody');
    const countEl = document.getElementById('order-count');

    if (!tbody) return;

    // Separate BUY and SELL trades
    const pairTrades = trades.filter(t => t.is_pair_trade);
    const regularTrades = trades.filter(t => !t.is_pair_trade);

    const buyTrades = regularTrades.filter(t => t.side === 'BUY');
    const sellTrades = regularTrades.filter(t => t.side === 'SELL');

    // Match SELL trades to BUY trades (closing trades) — regular trades only
    const closedBuyIds = new Set();
    const closingInfo = {};

    sellTrades.forEach(sell => {
        const matchingBuy = buyTrades.find(buy =>
            buy.tea_id === sell.tea_id &&
            buy.quantity === sell.quantity &&
            !closedBuyIds.has(buy.id) &&
            buy.id < sell.id
        );
        if (matchingBuy) {
            closedBuyIds.add(matchingBuy.id);
            closingInfo[matchingBuy.id] = {
                sellPrice: sell.price,
                sellTime: sell.created_at
            };
        }
    });

    // For pair trades, match closing trades
    const closedPairIds = new Set();
    const pairClosingInfo = {};
    const openingPairTrades = [];
    const closingPairTrades = [];

    const sortedPairTrades = [...pairTrades].sort((a, b) => a.id - b.id);
    sortedPairTrades.forEach(pt => {
        const matchingOpen = openingPairTrades.find(op =>
            !closedPairIds.has(op.id) &&
            op.index_symbol === pt.index_symbol &&
            op.pair_id === pt.pair_id &&
            op.side !== pt.side &&
            op.id < pt.id
        );
        if (matchingOpen) {
            closedPairIds.add(matchingOpen.id);
            pairClosingInfo[matchingOpen.id] = { sellPrice: pt.price, sellTime: pt.created_at };
            closingPairTrades.push(pt);
        } else {
            openingPairTrades.push(pt);
        }
    });

    // Filter based on current filter setting
    let displayRegular = buyTrades;
    let displayPairs = openingPairTrades;
    if (state.ordersFilter === 'open') {
        displayRegular = buyTrades.filter(t => !closedBuyIds.has(t.id));
        displayPairs = openingPairTrades.filter(t => !closedPairIds.has(t.id));
    }
    let displayTrades = [...displayRegular, ...displayPairs].sort((a, b) => b.id - a.id);
    countEl.textContent = displayTrades.length;

    if (displayTrades.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="10" style="text-align: center; color: var(--text-muted); padding: 20px;">
                    ${state.ordersFilter === 'open' ? 'No open positions.' : 'No orders yet. Start trading!'}
                </td>
            </tr>
        `;
        return;
    }

    // Build processed trade data for sorting
    let processedTrades = displayTrades.map(trade => {
        const time = trade.created_at
            ? new Date(trade.created_at)
            : new Date(0);
        const timeStr = trade.created_at
            ? time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
            : '--:--';
        const orderId = '#' + String(trade.id).substring(0, 5).toUpperCase();
        const tea = state.teas.find(t => t.id === trade.tea_id);

        const isClosed = closedBuyIds.has(trade.id) || closedPairIds.has(trade.id);
        const closing = closingInfo[trade.id] || pairClosingInfo[trade.id];

        const isPairTrade = trade.is_pair_trade || false;
        const leverage = trade.leverage || 1;
        const isIndexTrade = !!trade.index_symbol;

        let teaSymbol, total, pnl, pnlPct;

        if (isPairTrade && trade.pair_id) {
            const pair = state.teaPairs.find(p => p.id === trade.pair_id);
            if (pair) {
                const baseShort = pair.base_symbol.split('-')[1] || pair.base_symbol;
                const quoteShort = pair.quote_symbol.split('-')[1] || pair.quote_symbol;
                teaSymbol = `${baseShort}/${quoteShort} ${leverage}x`;

                total = trade.quantity;
                const entryRatio = trade.price;

                const teaMap = {};
                state.teas.forEach(t => teaMap[t.symbol] = t);
                const baseTea = teaMap[pair.base_symbol];
                const quoteTea = teaMap[pair.quote_symbol];

                if (baseTea && quoteTea && quoteTea.current_price > 0) {
                    const currentRatio = baseTea.current_price / quoteTea.current_price;
                    const ratioChange = (currentRatio - entryRatio) / entryRatio;
                    const direction = trade.side === 'BUY' ? 1 : -1;
                    pnl = total * ratioChange * leverage * direction;
                    pnlPct = ratioChange * 100 * leverage * direction;
                } else {
                    pnl = 0;
                    pnlPct = 0;
                }
            } else {
                teaSymbol = 'PAIR';
                total = trade.quantity;
                pnl = 0;
                pnlPct = 0;
            }
        } else if (isIndexTrade && trade.is_pair_trade) {
            // Index PAIR trade — index_symbol stored as "BASE/QUOTE"
            const parts = trade.index_symbol.split('/');
            const baseSymbol = parts[0];
            const quoteSymbol = parts[1];
            teaSymbol = `${baseSymbol}/${quoteSymbol} ${leverage}x`;
            total = trade.quantity;
            const entryRatio = trade.price;

            const baseIdx = typeof getIndexPrice === 'function' ? getIndexPrice(baseSymbol) : null;
            const quoteIdx = typeof getIndexPrice === 'function' ? getIndexPrice(quoteSymbol) : null;

            if (baseIdx && quoteIdx && quoteIdx.price > 0) {
                const currentRatio = baseIdx.price / quoteIdx.price;
                const ratioChange = (currentRatio - entryRatio) / entryRatio;
                const direction = trade.side === 'BUY' ? 1 : -1;
                pnl = total * ratioChange * leverage * direction;
                pnlPct = ratioChange * 100 * leverage * direction;
            } else {
                pnl = 0;
                pnlPct = 0;
            }
        } else if (isIndexTrade) {
            const idxList = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
            const index = idxList.find(idx => idx.symbol === trade.index_symbol);
            teaSymbol = trade.index_symbol + ' IDX';
            total = trade.quantity * trade.price;

            if (index) {
                pnl = (index.price - trade.price) * trade.quantity;
                pnlPct = ((index.price - trade.price) / trade.price * 100);
            } else {
                pnl = 0;
                pnlPct = 0;
            }
        } else {
            // Regular single tea trade
            teaSymbol = tea?.symbol || 'Unknown';
            total = trade.quantity * trade.price;

            if (isClosed && closing) {
                pnl = (closing.sellPrice - trade.price) * trade.quantity;
                pnlPct = ((closing.sellPrice - trade.price) / trade.price * 100);
            } else if (tea) {
                pnl = (tea.current_price - trade.price) * trade.quantity;
                pnlPct = ((tea.current_price - trade.price) / trade.price * 100);
            } else {
                pnl = 0;
                pnlPct = 0;
            }
        }

        const status = isClosed ? 'CLOSED' : 'OPEN';

        return {
            trade,
            time,
            timeStr,
            orderId,
            tea,
            teaSymbol,
            total,
            isClosed,
            closing,
            pnl,
            pnlPct,
            status,
            isPairTrade,
            isIndexTrade,
            leverage
        };
    });

    // Sort based on current sort settings
    processedTrades.sort((a, b) => {
        let comparison = 0;
        switch (state.ordersSortColumn) {
            case 'time':
                comparison = a.time.getTime() - b.time.getTime();
                break;
            case 'tea':
                comparison = a.teaSymbol.localeCompare(b.teaSymbol);
                break;
            case 'qty':
                comparison = a.trade.quantity - b.trade.quantity;
                break;
            case 'entry':
                comparison = a.trade.price - b.trade.price;
                break;
            case 'total':
                comparison = a.total - b.total;
                break;
            case 'pnl':
                comparison = a.pnl - b.pnl;
                break;
            case 'status':
                comparison = a.status.localeCompare(b.status);
                break;
            default:
                comparison = a.time.getTime() - b.time.getTime();
        }
        return state.ordersSortDirection === 'desc' ? -comparison : comparison;
    });

    let html = '';
    let openCount = 0;
    let openTotalValue = 0;
    let openTotalPnl = 0;

    processedTrades.forEach(({ trade, timeStr, orderId, tea, teaSymbol, total, isClosed, pnl, pnlPct, status, isPairTrade, isIndexTrade, leverage }) => {
        const pnlClass = pnl >= 0 ? 'up' : 'down';
        const pnlSign = pnl >= 0 ? '+' : '';
        const statusClass = isClosed ? 'closed' : 'filled';

        let actionBtn;
        if (isClosed) {
            actionBtn = `<span style="color: var(--text-muted);">\u2014</span>`;
        } else if (isPairTrade) {
            actionBtn = `<button class="close-position-btn" onclick="closePairPosition('${trade.id}')">Close</button>`;
        } else if (isIndexTrade) {
            actionBtn = `<button class="close-position-btn" onclick="closeIndexPosition('${escapeHtml(trade.index_symbol)}', ${trade.quantity}, ${trade.id})">Close</button>`;
        } else {
            actionBtn = `<button class="close-position-btn" onclick="closePosition(${trade.tea_id}, ${trade.quantity}, '${escapeHtml(teaSymbol)}')">Close</button>`;
        }

        if (!isClosed) {
            openCount++;
            openTotalValue += total;
            openTotalPnl += pnl;
        }

        let sideLabel, sideClass, entryDisplay, qtyDisplay;
        if (isPairTrade) {
            const isLong = trade.side === 'BUY';
            sideLabel = isLong ? 'LONG' : 'SHORT';
            sideClass = isLong ? 'buy-side' : 'sell-side';
            entryDisplay = trade.price.toFixed(4);
            qtyDisplay = '$' + trade.quantity.toLocaleString();
        } else {
            sideLabel = 'BUY';
            sideClass = 'buy-side';
            entryDisplay = '$' + trade.price.toFixed(2);
            qtyDisplay = trade.quantity.toLocaleString();
        }

        html += `
            <tr>
                <td>${timeStr}</td>
                <td style="font-family: 'JetBrains Mono', monospace;">${orderId}</td>
                <td>${escapeHtml(teaSymbol)}</td>
                <td><span class="order-side ${sideClass}">${sideLabel}</span></td>
                <td class="order-qty">${qtyDisplay}</td>
                <td class="order-price">${entryDisplay}</td>
                <td class="order-price">$${parseFloat(total.toFixed(2)).toLocaleString()}</td>
                <td class="${pnlClass}">${pnlSign}$${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)</td>
                <td><span class="order-status ${statusClass}">${status}</span></td>
                <td>${actionBtn}</td>
            </tr>
        `;
    });

    // Update totals in tfoot
    const tfoot = document.getElementById('orders-tfoot');
    const tfootTotal = document.getElementById('tfoot-total');
    const tfootPnl = document.getElementById('tfoot-pnl');
    const tfootCount = document.getElementById('tfoot-count');

    if (openCount > 0) {
        tfoot.style.display = '';
        const openPnlClass = openTotalPnl >= 0 ? 'up' : 'down';
        const openPnlSign = openTotalPnl >= 0 ? '+' : '';
        const openPnlPct = openTotalValue > 0 ? (openTotalPnl / openTotalValue * 100) : 0;

        tfootTotal.textContent = '$' + openTotalValue.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
        tfootPnl.className = `orders-summary-stat-value ${openPnlClass}`;
        tfootPnl.textContent = `${openPnlSign}$${openTotalPnl.toFixed(2)} (${openPnlPct.toFixed(1)}%)`;
        tfootCount.textContent = `${openCount} open`;
    } else {
        tfoot.style.display = 'none';
    }

    tbody.innerHTML = html;
}

// =============================================
// PORTFOLIO TAB SWITCHING
// =============================================

function switchPortfolioTab(tab) {
    document.querySelectorAll('.portfolio-tab').forEach(t => t.classList.remove('active'));
    if (event && event.target) event.target.classList.add('active');

    ['portfolio-positions', 'portfolio-orders', 'portfolio-history'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });

    if (tab === 'positions') {
        const el = document.getElementById('portfolio-positions');
        if (el) { el.style.display = 'block'; el.classList.add('active'); }
    } else if (tab === 'orders') {
        const el = document.getElementById('portfolio-orders');
        if (el) { el.style.display = 'block'; el.classList.add('active'); }
        loadPendingOrders();
    } else if (tab === 'history') {
        const el = document.getElementById('portfolio-history');
        if (el) { el.style.display = 'block'; el.classList.add('active'); }
        updateTradeLogDisplay();
    }
}

// =============================================
// PENDING ORDERS (Phase 4-16: Limit/Stop Orders)
// =============================================

async function loadPendingOrders() {
    const container = document.getElementById('pending-orders-list');
    if (!container || !state.currentUser) return;

    try {
        const { data, error } = await apiFetchPendingOrders();
        if (error) throw error;

        const orders = data || [];
        const pending = orders.filter(o => o.status === 'PENDING');
        const recent = orders.filter(o => o.status !== 'PENDING').slice(0, 10);

        if (pending.length === 0 && recent.length === 0) {
            container.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; padding: 20px 0; text-align: center;">No pending orders. Place a limit or stop order from the Trading Hub.</div>';
            return;
        }

        let html = '';

        if (pending.length > 0) {
            html += '<div class="pending-orders-section-title">Active Orders</div>';
            pending.forEach(o => {
                const isBuy = o.side === 'BUY';
                const shortSym = o.symbol.includes('-') ? o.symbol.split('-')[1] : o.symbol;
                html += `<div class="pending-order-row">
                    <div class="pending-order-info">
                        <span class="pending-order-side ${isBuy ? 'buy' : 'sell'}">${o.order_type} ${o.side}</span>
                        <span class="pending-order-symbol">${shortSym}</span>
                        <span class="pending-order-details">${o.quantity} kg @ $${Number(o.target_price).toFixed(2)}</span>
                    </div>
                    <div class="pending-order-actions">
                        ${o.margin_reserved > 0 ? '<span class="pending-order-margin">$' + Number(o.margin_reserved).toFixed(2) + ' reserved</span>' : ''}
                        <button class="pending-order-cancel" onclick="cancelPendingOrder('${o.id}')">Cancel</button>
                    </div>
                </div>`;
            });
        }

        if (recent.length > 0) {
            html += '<div class="pending-orders-section-title" style="margin-top:12px;">Recent Orders</div>';
            recent.forEach(o => {
                const statusClass = o.status === 'FILLED' ? 'filled' : o.status === 'CANCELLED' ? 'cancelled' : 'expired';
                const shortSym = o.symbol.includes('-') ? o.symbol.split('-')[1] : o.symbol;
                const fillInfo = o.status === 'FILLED' && o.fill_price ? ` @ $${Number(o.fill_price).toFixed(2)}` : '';
                html += `<div class="pending-order-row ${statusClass}">
                    <div class="pending-order-info">
                        <span class="pending-order-side">${o.order_type} ${o.side}</span>
                        <span class="pending-order-symbol">${shortSym}</span>
                        <span class="pending-order-details">${o.quantity} kg${fillInfo}</span>
                    </div>
                    <span class="pending-order-status ${statusClass}">${o.status}</span>
                </div>`;
            });
        }

        container.innerHTML = html;
    } catch (err) {
        console.error('Load pending orders error:', err);
        container.innerHTML = '<div style="color: var(--accent-red); font-size: 12px; padding: 20px 0; text-align: center;">Failed to load orders</div>';
    }
}

async function cancelPendingOrder(orderId) {
    if (!confirm('Cancel this order?')) return;
    try {
        const result = await apiCancelOrder(orderId);
        if (!result.success) throw new Error(result.error || 'Cancel failed');

        if (result.new_balance !== undefined && state.userProfile) {
            state.userProfile.cash_balance = result.new_balance;
            updatePortfolioDisplay();
        }
        showToast('Order Cancelled', result.refunded > 0 ? `$${Number(result.refunded).toFixed(2)} returned to balance` : 'Order removed');
        loadPendingOrders();
    } catch (err) {
        showToast('Cancel Failed', err.message, true);
    }
}

// =============================================
// TRADE LOG (CLOSED-TRADE ANALYTICS)
// =============================================

function recordClosedTrade(position, exitPrice) {
    const entryPrice = position.avg_price;
    const pnl = position.type === 'long'
        ? (exitPrice - entryPrice) * position.quantity
        : (entryPrice - exitPrice) * position.quantity;
    const pnlPercent = ((exitPrice - entryPrice) / entryPrice * 100) * (position.type === 'long' ? 1 : -1);

    const now = new Date();
    const entryDate = new Date(position.created_at || now);
    const duration = now - entryDate;

    const trade = {
        id: Date.now(),
        symbol: position.teas?.symbol || position.symbol,
        type: position.type,
        quantity: position.quantity,
        entryPrice: entryPrice,
        exitPrice: exitPrice,
        pnl: pnl,
        pnlPercent: pnlPercent,
        duration: duration,
        fees: Math.abs(pnl * 0.002),
        closedAt: now
    };

    state.tradeHistory.push(trade);
    localStorage.setItem('tradeHistory', JSON.stringify(state.tradeHistory));
    updateTradeLogDisplay();
}

function updateTradeLogDisplay() {
    const tbody = document.getElementById('trade-log-body');
    const statPnl = document.getElementById('stat-total-pnl');
    const statWinRate = document.getElementById('stat-win-rate');
    const statTrades = document.getElementById('stat-trades');
    const statAvgHold = document.getElementById('stat-avg-hold');

    if (!tbody) return;

    // Build closed trades from currentTradesData (Supabase)
    const closedTrades = [];

    if (state.currentTradesData && state.currentTradesData.length > 0) {
        const buyTrades = state.currentTradesData.filter(t => t.side === 'BUY');
        const sellTrades = state.currentTradesData.filter(t => t.side === 'SELL');
        const closedBuyIds = new Set();

        sellTrades.forEach(sell => {
            const matchingBuy = buyTrades.find(buy =>
                buy.tea_id === sell.tea_id &&
                !closedBuyIds.has(buy.id) &&
                buy.id < sell.id
            );
            if (matchingBuy) {
                closedBuyIds.add(matchingBuy.id);

                const tea = state.teas.find(t => t.id === matchingBuy.tea_id);
                const symbol = tea?.symbol || 'Unknown';

                const entryPrice = matchingBuy.price;
                const exitPrice = sell.price;
                const quantity = Math.min(matchingBuy.quantity, sell.quantity);
                const pnl = (exitPrice - entryPrice) * quantity;
                const pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;

                const entryDate = new Date(matchingBuy.created_at);
                const exitDate = new Date(sell.created_at);
                const duration = exitDate - entryDate;

                closedTrades.push({
                    id: sell.id,
                    symbol: symbol,
                    type: 'long',
                    quantity: quantity,
                    entryPrice: entryPrice,
                    exitPrice: exitPrice,
                    pnl: pnl,
                    pnlPercent: pnlPercent,
                    duration: duration,
                    fees: Math.abs(pnl * 0.002),
                    closedAt: exitDate
                });
            }
        });
    }

    if (closedTrades.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">No closed trades yet</td></tr>`;
        if (statPnl) statPnl.textContent = '+$0.00';
        if (statWinRate) statWinRate.textContent = '0%';
        if (statTrades) statTrades.textContent = '0';
        if (statAvgHold) statAvgHold.textContent = '\u2014';
        return;
    }

    // Calculate stats
    const totalPnl = closedTrades.reduce((sum, t) => sum + t.pnl, 0);
    const wins = closedTrades.filter(t => t.pnl > 0).length;
    const winRate = (wins / closedTrades.length * 100).toFixed(0);
    const avgHold = closedTrades.reduce((sum, t) => sum + t.duration, 0) / closedTrades.length;

    statPnl.textContent = `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`;
    statPnl.className = `trade-stat-value ${totalPnl >= 0 ? 'up' : 'down'}`;
    statWinRate.textContent = `${winRate}%`;
    statTrades.textContent = closedTrades.length;
    statAvgHold.textContent = formatDuration(avgHold);

    // Sort by most recent and render table
    closedTrades.sort((a, b) => b.closedAt - a.closedAt);
    tbody.innerHTML = closedTrades.slice(0, 20).map(t => `
        <tr>
            <td style="font-weight: 500;">${escapeHtml(t.symbol)}</td>
            <td><span class="trade-type-badge ${t.type}">${escapeHtml(t.type)}</span></td>
            <td style="font-family: 'JetBrains Mono', monospace;">$${t.entryPrice.toFixed(2)}</td>
            <td style="font-family: 'JetBrains Mono', monospace;">$${t.exitPrice.toFixed(2)}</td>
            <td class="${t.pnl >= 0 ? 'up' : 'down'}" style="font-family: 'JetBrains Mono', monospace;">
                ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}<br>
                <span style="font-size: 8px; opacity: 0.7;">${t.pnlPercent >= 0 ? '+' : ''}${t.pnlPercent.toFixed(1)}%</span>
            </td>
            <td style="color: var(--text-muted); font-size: 9px;">${formatDuration(t.duration)}</td>
        </tr>
    `).join('');
}

// =============================================
// LEADERBOARD FUNCTIONS
// =============================================

async function loadLeaderboard() {
    try {
        const { data, error } = await apiFetchLeaderboard(10);
        if (error) throw error;

        if (data && data.length > 0) {
            updateLeaderboardDisplay(data);
        }
    } catch (error) {
        console.error('Failed to load leaderboard:', error);
    }
}

function updateLeaderboardDisplay(leaders) {
    const listEl = document.getElementById('leaderboard-list');
    let html = '';

    leaders.forEach((user, index) => {
        const rank = index + 1;
        let rankClass = '';
        if (rank === 1) rankClass = 'gold';
        else if (rank === 2) rankClass = 'silver';
        else if (rank === 3) rankClass = 'bronze';

        const returnPct = user.return_pct || 0;
        const returnClass = returnPct >= 0 ? 'up' : 'down';
        const returnSign = returnPct >= 0 ? '+' : '';
        const totalValue = user.total_value || 0;
        const isFollowed = isTraderFollowed(user.username);
        const followIcon = isFollowed ? '★' : '☆';

        html += `
            <div class="leaderboard-item leaderboard-item-clickable" onclick="openTraderProfile('${user.username}', ${returnPct}, ${totalValue}, ${rank})">
                <div class="leaderboard-rank ${rankClass}">${rank}</div>
                <div class="leaderboard-name">${escapeHtml(user.username)}</div>
                <div class="leaderboard-return ${returnClass}">${returnSign}${returnPct.toFixed(1)}%</div>
                <div class="leaderboard-follow-star ${isFollowed ? 'followed' : ''}" title="${isFollowed ? 'Following' : 'Follow'}">${followIcon}</div>
            </div>
        `;
    });

    if (html) {
        listEl.innerHTML = html;
    }
}

// =============================================
// INDEX POSITION TRACKING (Supabase-backed)
// =============================================

async function loadIndexPositions() {
    if (!state.currentUser) return;
    try {
        const { data, error } = await apiFetchIndexPositions(state.currentUser.id);
        if (error) throw error;

        state.indexPositions = {};
        if (data) {
            data.forEach(pos => {
                state.indexPositions[pos.index_symbol] = {
                    id: pos.id,
                    quantity: parseFloat(pos.quantity),
                    avg_entry_price: parseFloat(pos.avg_entry_price)
                };
            });
        }
    } catch (e) {
        console.error('Failed to load index positions:', e);
        state.indexPositions = {};
    }
}

function getIndexPosition(indexSymbol) {
    return state.indexPositions[indexSymbol] || null;
}

// =============================================
// VIRTUAL ACCOUNT RESET
// =============================================

/**
 * Opens a confirmation modal warning the user, then wipes all positions,
 * index positions, trades, and trade history, and resets cash_balance to $10,000.
 */
function resetVirtualAccount() {
    if (!state.currentUser) {
        openAuthModal();
        return;
    }
    document.getElementById('reset-confirm-modal').style.display = 'flex';
}

function closeResetModal() {
    document.getElementById('reset-confirm-modal').style.display = 'none';
}

async function confirmResetAccount() {
    const btn = document.getElementById('reset-confirm-btn');
    btn.disabled = true;
    btn.textContent = 'Resetting...';

    try {
        // Server-side atomic reset (C1/C2/C3 FIX)
        const result = await apiResetAccount();
        if (!result.success) {
            throw new Error(result.error || 'Reset failed');
        }

        // Reset local state
        state.positions = [];
        state.indexPositions = {};
        state.currentTradesData = [];
        state.tradeHistory = [];
        state.userProfile.cash_balance = result.new_balance || 10000;

        // Clear localStorage trade history
        localStorage.removeItem('tradeHistory');

        // Refresh all UI
        updatePortfolioDisplay();
        displayUserTrades([]);
        updateTradeLogDisplay();
        updateUIForLoggedInUser();

        closeResetModal();
        showToast('Account Reset', 'Your virtual account has been reset to $10,000 with a clean slate.');
    } catch (error) {
        console.error('Account reset failed:', error);
        showToast('Reset Failed', 'Something went wrong. Please try again.', true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Yes, Reset Everything';
    }
}

// =============================================
// INDEX POSITION TRACKING (Supabase-backed)
// =============================================

// C4 FIX: updateIndexPosition() is now a no-op.
// All index position management is handled server-side by execute_index_trade().
// This stub exists only for backward compatibility with any callers not yet migrated.
async function updateIndexPosition(indexSymbol, quantity, price, side) {
    console.warn('updateIndexPosition() called but is deprecated. All index trades should use apiExecuteIndexTrade().');
    // Refresh from server to pick up any changes
    if (typeof loadIndexPositions === 'function') {
        await loadIndexPositions();
    }
}

// =============================================
// TRADER WATCHLIST
// =============================================

const WATCHLIST_KEY = 'tt_trader_watchlist';

function getTraderWatchlist() {
    try { return JSON.parse(localStorage.getItem(WATCHLIST_KEY) || '[]'); }
    catch { return []; }
}

function saveTraderWatchlist(list) {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
}

function isTraderFollowed(username) {
    return getTraderWatchlist().some(t => t.username === username);
}

function toggleFollowTrader(username, returnPct, totalValue) {
    let list = getTraderWatchlist();
    const idx = list.findIndex(t => t.username === username);
    if (idx === -1) {
        list.push({ username, returnPct, totalValue, followedAt: new Date().toISOString() });
        showToast('Following', `You are now following ${username}`);
    } else {
        list.splice(idx, 1);
        showToast('Unfollowed', `Removed ${username} from your watchlist`);
    }
    saveTraderWatchlist(list);
    // Refresh leaderboard stars & modal button
    if (typeof loadLeaderboard === 'function') loadLeaderboard();
    _refreshTraderProfileFollowBtn(username);
}

function _refreshTraderProfileFollowBtn(username) {
    const btn = document.getElementById('trader-profile-follow-btn');
    if (!btn) return;
    const followed = isTraderFollowed(username);
    btn.textContent = followed ? '★ Following' : '☆ Follow Trader';
    btn.className = 'trader-profile-follow-btn' + (followed ? ' following' : '');
}

// =============================================
// TRADER PROFILE MODAL
// =============================================

function openTraderProfile(username, returnPct, totalValue, rank) {
    const modal = document.getElementById('trader-profile-modal');
    if (!modal) return;

    const followed  = isTraderFollowed(username);
    const retClass  = returnPct >= 0 ? 'up' : 'down';
    const retSign   = returnPct >= 0 ? '+' : '';
    const rankEmoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
    const initials  = username.slice(0, 2).toUpperCase();
    const startVal  = totalValue / (1 + returnPct / 100);
    const gainLoss  = totalValue - startVal;
    const gainSign  = gainLoss >= 0 ? '+' : '';

    modal.innerHTML = `
        <div class="trader-profile-overlay" onclick="closeTraderProfile()"></div>
        <div class="trader-profile-card">
            <button class="trader-profile-close" onclick="closeTraderProfile()">✕</button>
            <div class="trader-profile-header">
                <div class="trader-profile-avatar">${initials}</div>
                <div class="trader-profile-info">
                    <div class="trader-profile-name">${escapeHtml(username)}</div>
                    <div class="trader-profile-rank">${rankEmoji} Rank ${rank} · Feb 2026</div>
                </div>
            </div>
            <div class="trader-profile-stats">
                <div class="trader-stat-box">
                    <div class="trader-stat-label">Return</div>
                    <div class="trader-stat-value ${retClass}">${retSign}${returnPct.toFixed(1)}%</div>
                </div>
                <div class="trader-stat-box">
                    <div class="trader-stat-label">Portfolio Value</div>
                    <div class="trader-stat-value">$${totalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
                </div>
                <div class="trader-stat-box">
                    <div class="trader-stat-label">P&amp;L</div>
                    <div class="trader-stat-value ${gainLoss >= 0 ? 'up' : 'down'}">${gainSign}$${Math.abs(gainLoss).toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
                </div>
                <div class="trader-stat-box">
                    <div class="trader-stat-label">Starting Capital</div>
                    <div class="trader-stat-value">$${startVal.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
                </div>
            </div>
            <div class="trader-profile-activity">
                <div class="trader-activity-label">Recent Activity</div>
                <div class="trader-activity-placeholder">Trade history coming soon</div>
            </div>
            <button id="trader-profile-follow-btn"
                class="trader-profile-follow-btn${followed ? ' following' : ''}"
                onclick="toggleFollowTrader('${username}', ${returnPct}, ${totalValue})">
                ${followed ? '★ Following' : '☆ Follow Trader'}
            </button>
        </div>
    `;
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeTraderProfile() {
    const modal = document.getElementById('trader-profile-modal');
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }
}

// =============================================
// MY PORTFOLIO MODAL
// =============================================

function openPortfolioModal() {
    const modal = document.getElementById('portfolio-modal');
    if (!modal) return;

    // Populate header balance from state
    const balEl = document.getElementById('portfolio-header-balance');
    if (balEl && state.userProfile?.cash_balance != null) {
        balEl.textContent = `$${Number(state.userProfile.cash_balance).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    }

    // Watchlist count badge
    const countEl = document.getElementById('portfolio-wl-count');
    if (countEl) countEl.textContent = getTraderWatchlist().length;

    renderPortfolioModal();
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closePortfolioModal() {
    const modal = document.getElementById('portfolio-modal');
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }
}

function renderPortfolioModal() {
    const watchlist = getTraderWatchlist();
    const wlPanel   = document.getElementById('portfolio-watchlist-panel');
    const statsPanel = document.getElementById('portfolio-stats-panel');
    if (!wlPanel || !statsPanel) return;

    if (watchlist.length === 0) {
        wlPanel.innerHTML = `
            <div class="portfolio-watchlist-empty">
                <div class="portfolio-wl-icon">☆</div>
                <div>No traders followed yet.</div>
                <div class="portfolio-wl-hint">Click ☆ on any leaderboard entry to follow a trader.</div>
            </div>`;
        statsPanel.innerHTML = `<div class="portfolio-stats-placeholder">Select a trader to see their stats.</div>`;
        return;
    }

    wlPanel.innerHTML = watchlist.map(t => {
        const retClass = t.returnPct >= 0 ? 'up' : 'down';
        const retSign  = t.returnPct >= 0 ? '+' : '';
        return `
            <div class="portfolio-wl-item" onclick="selectPortfolioTrader('${t.username}', ${t.returnPct}, ${t.totalValue})">
                <div class="portfolio-wl-avatar">${t.username.slice(0, 2).toUpperCase()}</div>
                <div class="portfolio-wl-info">
                    <div class="portfolio-wl-name">${escapeHtml(t.username)}</div>
                    <div class="portfolio-wl-return ${retClass}">${retSign}${t.returnPct.toFixed(1)}%</div>
                </div>
                <button class="portfolio-wl-unfollow" onclick="event.stopPropagation(); toggleFollowTrader('${t.username}', ${t.returnPct}, ${t.totalValue}); renderPortfolioModal();" title="Unfollow">✕</button>
            </div>`;
    }).join('');

    // Auto-select first trader
    const first = watchlist[0];
    selectPortfolioTrader(first.username, first.returnPct, first.totalValue);
}

function selectPortfolioTrader(username, returnPct, totalValue) {
    const statsPanel = document.getElementById('portfolio-stats-panel');
    if (!statsPanel) return;

    // Highlight selected
    document.querySelectorAll('.portfolio-wl-item').forEach(el => el.classList.remove('selected'));
    const items = document.querySelectorAll('.portfolio-wl-item');
    items.forEach(el => {
        if (el.querySelector('.portfolio-wl-name')?.textContent === username) {
            el.classList.add('selected');
        }
    });

    const retClass  = returnPct >= 0 ? 'up' : 'down';
    const retSign   = returnPct >= 0 ? '+' : '';
    const initials  = username.slice(0, 2).toUpperCase();
    const startVal  = totalValue / (1 + returnPct / 100);
    const gainLoss  = totalValue - startVal;
    const gainSign  = gainLoss >= 0 ? '+' : '';

    statsPanel.innerHTML = `
        <div class="portfolio-trader-detail">
            <div class="portfolio-trader-header">
                <div class="portfolio-trader-avatar">${initials}</div>
                <div>
                    <div class="portfolio-trader-name">${escapeHtml(username)}</div>
                    <div class="portfolio-trader-since">Following since ${new Date(getTraderWatchlist().find(t=>t.username===username)?.followedAt||Date.now()).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</div>
                </div>
            </div>
            <div class="portfolio-trader-stats-grid">
                <div class="portfolio-stat">
                    <div class="portfolio-stat-label">Return</div>
                    <div class="portfolio-stat-value ${retClass}">${retSign}${returnPct.toFixed(1)}%</div>
                </div>
                <div class="portfolio-stat">
                    <div class="portfolio-stat-label">Portfolio Value</div>
                    <div class="portfolio-stat-value">$${totalValue.toLocaleString('en-US',{maximumFractionDigits:0})}</div>
                </div>
                <div class="portfolio-stat">
                    <div class="portfolio-stat-label">P&amp;L</div>
                    <div class="portfolio-stat-value ${gainLoss>=0?'up':'down'}">${gainSign}$${Math.abs(gainLoss).toLocaleString('en-US',{maximumFractionDigits:0})}</div>
                </div>
                <div class="portfolio-stat">
                    <div class="portfolio-stat-label">Starting Capital</div>
                    <div class="portfolio-stat-value">$${startVal.toLocaleString('en-US',{maximumFractionDigits:0})}</div>
                </div>
            </div>
            <div class="portfolio-activity-section">
                <div class="portfolio-activity-title">Trade Notifications</div>
                <div class="portfolio-activity-info">You'll be notified here when ${escapeHtml(username)} opens or closes a position.</div>
                <div class="portfolio-notification-placeholder">No recent activity</div>
            </div>
            <button class="trader-profile-follow-btn following" onclick="toggleFollowTrader('${username}', ${returnPct}, ${totalValue}); renderPortfolioModal();">
                ★ Unfollow Trader
            </button>
        </div>
    `;
}
