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
        const totalValue = getActiveBalance();
        valueEl.textContent = '$' + totalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const startBal = state.tradingMode === 'REAL' ? 0 : 10000;
        const pnl = totalValue - startBal;
        const pnlPct = startBal > 0 ? (pnl / startBal * 100).toFixed(2) : '0.00';
        pnlEl.textContent = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct}%)`;
        pnlEl.className = 'portfolio-pnl ' + (pnl >= 0 ? 'up' : 'down');
        _updateT212Hero(totalValue, 0, totalValue);
        return;
    }

    let holdingsValue = 0;
    let html = '';

    state.positions.forEach(pos => {
        const tea = pos.teas || state.teas.find(t => t.id === pos.tea_id);
        if (!tea) return;

        const isShort = pos.quantity < 0;
        const absQty = Math.abs(pos.quantity);
        const currentValue = absQty * tea.current_price;
        const costBasis = absQty * pos.avg_entry_price;
        // True Bid/Ask exit price — T212 model:
        // Longs sell at Bid (mid − half-spread), shorts cover at Ask (mid + half-spread).
        const spreadPct = (Number(tea.base_spread) || 0.01) * (Number(tea.volatility_multiplier) || 1.0);
        const exitPrice = isShort
            ? tea.current_price * (1 + spreadPct / 2)
            : tea.current_price * (1 - spreadPct / 2);
        const lev = Number(pos.leverage) || 1;
        const margin = costBasis / lev;
        const notionalValue = margin * lev;
        const units = notionalValue / pos.avg_entry_price;
        let pnl = isShort
            ? (pos.avg_entry_price - exitPrice) * units
            : (exitPrice - pos.avg_entry_price) * units;
        if (pnl < -margin) pnl = -margin;
        const pnlPct = margin > 0 ? (pnl / margin * 100).toFixed(2) : '0.00';
        const returnValue = margin + pnl;
        holdingsValue += returnValue;

        const badge = isShort
            ? ' <span style="color: var(--accent-red); font-size: 10px; font-weight: 700;">SHORT</span>'
            : '';
        const levBadge = (pos.leverage && pos.leverage > 1)
            ? ` <span style="color: var(--accent-orange); font-size: 10px; font-weight: 700;">${pos.leverage}x</span>`
            : '';

        html += `
            <div class="position-item">
                <div>
                    <div class="position-tea">${escapeHtml(tea.symbol)}${badge}${levBadge}</div>
                    <div class="position-qty">${absQty.toLocaleString()} kg @ $${pos.avg_entry_price.toFixed(4)} · Invested: $${margin.toFixed(2)}</div>
                </div>
                <div class="position-value">
                    <div class="position-current">$${returnValue.toFixed(2)}</div>
                    <div class="position-pnl ${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct}%)</div>
                </div>
            </div>
        `;
    });

    const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
    Object.entries(indexPositionsData).forEach(([symbol, pos]) => {
        const index = indexes.find(idx => idx.symbol === symbol);
        if (!index || !pos || pos.quantity === 0) return;

        const isShort = pos.quantity < 0;
        const absQty = Math.abs(pos.quantity);
        const currentValue = absQty * index.price;
        const costBasis = absQty * pos.avg_entry_price;
        // True Bid/Ask exit price — T212 model:
        // INDEX spread = 2% total (1% per side).
        // Longs sell at Bid (mid × 0.99), shorts cover at Ask (mid × 1.01).
        const exitPrice = isShort
            ? index.price * 1.01
            : index.price * 0.99;
        const lev = Number(pos.leverage) || 1;
        const margin = costBasis / lev;
        const notionalValue = margin * lev;
        const units = notionalValue / pos.avg_entry_price;
        let pnl = isShort
            ? (pos.avg_entry_price - exitPrice) * units
            : (exitPrice - pos.avg_entry_price) * units;
        if (pnl < -margin) pnl = -margin;
        const pnlPct = margin > 0 ? (pnl / margin * 100).toFixed(2) : '0.00';
        const idxReturnValue = margin + pnl;
        holdingsValue += idxReturnValue;

        const dirBadge = isShort
            ? '<span style="color: var(--accent-red); font-size: 10px; font-weight: 700;">SHORT</span>'
            : '';
        const idxLevBadge = (pos.leverage && pos.leverage > 1)
            ? ` <span style="color: var(--accent-orange); font-size: 10px; font-weight: 700;">${pos.leverage}x</span>`
            : '';

        html += `
            <div class="position-item">
                <div>
                    <div class="position-tea">${escapeHtml(symbol)} <span style="color: var(--accent-purple); font-size: 10px;">IDX</span> ${dirBadge}${idxLevBadge}</div>
                    <div class="position-qty">${absQty.toLocaleString()} kg @ $${pos.avg_entry_price.toFixed(4)} · Invested: $${margin.toFixed(2)}</div>
                </div>
                <div class="position-value">
                    <div class="position-current">$${idxReturnValue.toFixed(2)}</div>
                    <div class="position-pnl ${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct}%)</div>
                </div>
            </div>
        `;
    });

    listEl.innerHTML = html;

    // Calculate margin metrics
    let totalUsedMargin = 0;
    let totalUnrealizedPnl = 0;
    state.positions.forEach(pos => {
        const lev = Number(pos.leverage) || 1;
        const cost = Math.abs(pos.quantity) * pos.avg_entry_price;
        const posMargin = Number(pos.margin_used) || (cost / lev);
        totalUsedMargin += posMargin;
        const tea = pos.teas || state.teas.find(t => t.id === pos.tea_id);
        if (tea) {
            const isShort = pos.quantity < 0;
            const spreadPct = (Number(tea.base_spread) || 0.01) * (Number(tea.volatility_multiplier) || 1.0);
            const ep = isShort
                ? tea.current_price * (1 + spreadPct / 2)
                : tea.current_price * (1 - spreadPct / 2);
            const nv = posMargin * lev;
            const units = nv / pos.avg_entry_price;
            let posPnl = isShort
                ? (pos.avg_entry_price - ep) * units
                : (ep - pos.avg_entry_price) * units;
            if (posPnl < -posMargin) posPnl = -posMargin;
            totalUnrealizedPnl += posPnl;
        }
    });
    Object.entries(indexPositionsData).forEach(([symbol, pos]) => {
        const idxLev = Number(pos.leverage) || 1;
        const idxCost = Math.abs(pos.quantity) * pos.avg_entry_price;
        const idxMargin = Number(pos.margin_used) || (idxCost / idxLev);
        totalUsedMargin += idxMargin;
        const index = indexes.find(idx => idx.symbol === symbol);
        if (index && pos && pos.quantity !== 0) {
            const isShort = pos.quantity < 0;
            // INDEX spread = 2% total (1% per side) for margin metrics consistency
            const iep = isShort ? index.price * 1.01 : index.price * 0.99;
            const inv = idxMargin * idxLev;
            const units = inv / pos.avg_entry_price;
            let idxPnl = isShort
                ? (pos.avg_entry_price - iep) * units
                : (iep - pos.avg_entry_price) * units;
            if (idxPnl < -idxMargin) idxPnl = -idxMargin;
            totalUnrealizedPnl += idxPnl;
        }
    });

    const balance = getActiveBalance();
    const equity = balance + totalUnrealizedPnl;
    const freeMargin = equity - totalUsedMargin;

    const startBal = state.tradingMode === 'REAL' ? 0 : 10000;
    const equityPct = startBal > 0 ? (equity / startBal * 100) : 100;

    valueEl.textContent = '$' + equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const totalPnl = equity - startBal;
    const totalPnlPct = startBal > 0 ? (totalPnl / startBal * 100).toFixed(2) : '0.00';
    pnlEl.textContent = `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${totalPnlPct}%)`;
    pnlEl.className = 'portfolio-pnl ' + (totalPnl >= 0 ? 'up' : 'down');

    _updateT212Hero(equity, totalUsedMargin, freeMargin);

    // Client-side equity-floor warnings (supplements server-side checks)
    if (totalUsedMargin > 0) {
        _checkClientMarginLevel(equityPct, equity, totalUsedMargin);
    }

    // Render margin summary below positions list
    let marginHtml = document.getElementById('portfolio-margin-summary');
    if (!marginHtml) {
        marginHtml = document.createElement('div');
        marginHtml.id = 'portfolio-margin-summary';
        marginHtml.style.cssText = 'padding:8px 12px;border-top:1px solid var(--border);font-size:11px;color:var(--text-muted);';
        listEl.parentNode.insertBefore(marginHtml, listEl.nextSibling);
    }
    const phColor = equity <= 1 ? 'var(--accent-red)' : equity <= 200 ? 'var(--accent-orange)' : equity <= 1000 ? '#f59e0b' : 'var(--accent-green)';
    const phDisplay = '$' + equity.toFixed(2);
    marginHtml.innerHTML = totalUsedMargin > 0
        ? `<div style="display:flex;justify-content:space-between;margin-bottom:3px;"><span>Balance</span><span>$${balance.toFixed(2)}</span></div>` +
        `<div style="display:flex;justify-content:space-between;margin-bottom:3px;"><span>Equity</span><span style="font-weight:600;">$${equity.toFixed(2)}</span></div>` +
        `<div style="display:flex;justify-content:space-between;margin-bottom:3px;"><span>Invested</span><span>$${totalUsedMargin.toFixed(2)}</span></div>` +
        `<div style="display:flex;justify-content:space-between;margin-bottom:3px;"><span>Free Funds</span><span>$${freeMargin.toFixed(2)}</span></div>` +
        `<div style="display:flex;justify-content:space-between;"><span>Account Health</span><span style="color:${phColor};font-weight:600;">${phDisplay}</span></div>`
        : '';
}

function _updateT212Hero(totalValue, invested, freeFunds) {
    const fmt = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const tv = document.getElementById('t212-total-value');
    const inv = document.getElementById('t212-invested');
    const ff = document.getElementById('t212-free-funds');
    if (tv) tv.textContent = fmt(totalValue);
    if (inv) inv.textContent = fmt(invested);
    if (ff) ff.textContent = fmt(freeFunds);
}

let _lastMarginWarningTime = 0;
const _MARGIN_WARN_COOLDOWN_MS = 60_000;

function _checkClientMarginLevel(equityPct, equity, usedMargin) {
    const now = Date.now();
    if (now - _lastMarginWarningTime < _MARGIN_WARN_COOLDOWN_MS) return;

    // REAL mode: FCA 50% margin closeout rule
    if (state.tradingMode === 'REAL') {
        const marginLevelPct = usedMargin > 0 ? (equity / usedMargin) * 100 : 100;

        if (marginLevelPct <= 50) {
            _lastMarginWarningTime = now;
            if (typeof _showMarginAlert === 'function') {
                _showMarginAlert('MARGIN CLOSEOUT (FCA 50% Rule)',
                    `Account equity dropped below 50% of margin requirements ($${equity.toFixed(2)}). All positions will be liquidated.`,
                    'stop_out');
            }
        } else if (marginLevelPct <= 80) {
            _lastMarginWarningTime = now;
            if (typeof _showMarginAlert === 'function') {
                _showMarginAlert('Margin Call Warning',
                    `Account equity has fallen to ${marginLevelPct.toFixed(1)}% of margin requirements. Consider closing positions.`,
                    'margin_call');
            }
        }
        return;
    }

    // VIRTUAL mode: Gamified fixed-dollar thresholds
    if (equity <= 1) {
        _lastMarginWarningTime = now;
        if (typeof _showMarginAlert === 'function') {
            _showMarginAlert('CRITICAL — Account Depleted',
                `Account equity at $${equity.toFixed(2)}. All positions will be liquidated.`,
                'stop_out');
        }
    } else if (equity <= 200) {
        _lastMarginWarningTime = now;
        if (typeof _showMarginAlert === 'function') {
            _showMarginAlert('Low Equity Warning',
                `Account equity at $${equity.toFixed(2)}. Close losing positions to avoid total liquidation.`,
                'margin_call');
        }
    }
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

    const pairTrades = trades.filter(t => t.is_pair_trade);
    const regularTrades = trades.filter(t => !t.is_pair_trade);

    // ── Chronological netting: process trades per asset in order ──
    // Mirrors the server-side netting logic so open/closed status is accurate.
    const assetGroups = {};
    regularTrades.forEach(t => {
        const key = t.index_symbol || t.tea_id;
        if (!assetGroups[key]) assetGroups[key] = [];
        assetGroups[key].push(t);
    });

    const closedTradeIds = new Set();
    const closingLegIds = new Set();
    const closingInfo = {};

    Object.values(assetGroups).forEach(group => {
        group.sort((a, b) => a.id - b.id);
        const openStack = [];

        group.forEach(trade => {
            const isBuy = trade.side === 'BUY';
            let remaining = trade.quantity;

            for (let i = 0; i < openStack.length && remaining > 0; i++) {
                const entry = openStack[i];
                if (entry.rem <= 0) continue;
                const entryIsBuy = entry.trade.side === 'BUY';
                if (entryIsBuy === isBuy) continue;

                const closeQty = Math.min(remaining, entry.rem);
                entry.rem -= closeQty;
                remaining -= closeQty;

                // ── Accumulate realized PnL per chunk (fixes partial-close overwrite bug) ──
                // Each matched chunk contributes: direction × (exitPrice − entryPrice) × chunkQty
                // This is summed cumulatively so multiple partial exits are all accounted for.
                if (!closingInfo[entry.trade.id]) {
                    closingInfo[entry.trade.id] = {
                        // Legacy fields kept for pair/index trade compatibility
                        sellPrice: trade.price,
                        sellTime: trade.created_at,
                        coverPrice: trade.price,
                        coverTime: trade.created_at,
                        // New cumulative fields
                        realizedPnl: 0,
                        closedQty: 0,
                    };
                }
                const info = closingInfo[entry.trade.id];
                const direction = entryIsBuy ? 1 : -1;
                info.realizedPnl += direction * (trade.price - entry.trade.price) * closeQty;
                info.closedQty += closeQty;
                // Keep sellPrice as the latest exit price (for legacy pair/index path fallback)
                info.sellPrice = trade.price;
                info.sellTime = trade.created_at;
                if (!entryIsBuy) {
                    info.coverPrice = trade.price;
                    info.coverTime = trade.created_at;
                }

                if (entry.rem <= 0) {
                    closedTradeIds.add(entry.trade.id);
                }
            }

            if (remaining <= 0) {
                closedTradeIds.add(trade.id);
                closingLegIds.add(trade.id);
            } else {
                openStack.push({ trade, rem: remaining });
            }
        });
    });


    // ── Pair trade matching (unchanged) ──
    const closedPairIds = new Set();
    const pairClosingInfo = {};
    const openingPairTrades = [];

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
        } else {
            openingPairTrades.push(pt);
        }
    });

    // ── Override open/closed using actual position state (source of truth) ──
    const posQtyMap = {};
    (state.positions || []).forEach(p => {
        posQtyMap[p.tea_id] = (posQtyMap[p.tea_id] || 0) + p.quantity;
    });
    Object.entries(state.indexPositions || {}).forEach(([sym, p]) => {
        if (p && p.quantity) posQtyMap[sym] = (posQtyMap[sym] || 0) + p.quantity;
    });

    Object.values(assetGroups).forEach(group => {
        const sorted = [...group].sort((a, b) => b.id - a.id);
        const key = sorted[0]?.index_symbol || sorted[0]?.tea_id;
        const netQty = posQtyMap[key] || 0;
        const posDir = netQty > 0 ? 'BUY' : netQty < 0 ? 'SELL' : null;
        let remaining = Math.abs(netQty);

        sorted.forEach(trade => {
            if (posDir && trade.side === posDir && remaining > 0) {
                remaining -= Math.min(remaining, trade.quantity);
                closedTradeIds.delete(trade.id);
            } else {
                closedTradeIds.add(trade.id);
            }
        });
    });

    // ── Build display list (hide closing legs — they're shown via the opening trade's CLOSED status) ──
    const visibleRegular = regularTrades.filter(t => !closingLegIds.has(t.id));

    let displayRegular = [...visibleRegular];
    let displayPairs = [...openingPairTrades];

    if (state.ordersFilter === 'open') {
        displayRegular = visibleRegular.filter(t => !closedTradeIds.has(t.id));
        displayPairs = openingPairTrades.filter(t => !closedPairIds.has(t.id));
    }
    let displayTrades = [...displayRegular, ...displayPairs].sort((a, b) => b.id - a.id);

    const openTradesCount = visibleRegular.filter(t => !closedTradeIds.has(t.id)).length +
        openingPairTrades.filter(t => !closedPairIds.has(t.id)).length;
    countEl.textContent = openTradesCount;
    countEl.style.display = openTradesCount > 0 ? '' : 'none';

    if (displayTrades.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="10" style="text-align: center; color: var(--text-muted); padding: 20px;">
                    ${state.ordersFilter === 'open' ? 'No open positions.' : 'No orders yet. Start trading!'}
                </td>
            </tr>
        `;
        const t212Empty = document.getElementById('t212-trades-list');
        if (t212Empty) t212Empty.innerHTML = '<div style="color:#8b929e;font-size:13px;text-align:center;padding:40px 20px;">No orders yet. Start trading!</div>';
        return;
    }

    // Build processed trade data for sorting
    let processedTrades = displayTrades.map(trade => {
        const time = trade.created_at
            ? new Date(trade.created_at)
            : new Date(0);
        const timeStr = trade.created_at
            ? time.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' +
            time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
            : '--:--';
        const orderId = '#' + String(trade.id).substring(0, 5).toUpperCase();
        const tea = state.teas.find(t => t.id === trade.tea_id);

        const isClosed = closedTradeIds.has(trade.id) || closedPairIds.has(trade.id);
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

                if (isClosed && closing) {
                    const exitRatio = closing.sellPrice ?? closing.coverPrice;
                    const ratioChange = (exitRatio - entryRatio) / entryRatio;
                    const direction = trade.side === 'BUY' ? 1 : -1;
                    pnl = total * ratioChange * leverage * direction;
                    pnlPct = ratioChange * 100 * leverage * direction;
                } else {
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
                }
            } else {
                teaSymbol = 'PAIR';
                total = trade.quantity;
                pnl = 0;
                pnlPct = 0;
            }
        } else if (isIndexTrade && trade.is_pair_trade) {
            const parts = trade.index_symbol.split('/');
            const baseSymbol = parts[0];
            const quoteSymbol = parts[1];
            teaSymbol = `${baseSymbol}/${quoteSymbol} ${leverage}x`;
            total = trade.quantity;
            const entryRatio = trade.price;

            if (isClosed && closing) {
                const exitRatio = closing.sellPrice ?? closing.coverPrice;
                const ratioChange = (exitRatio - entryRatio) / entryRatio;
                const direction = trade.side === 'BUY' ? 1 : -1;
                pnl = total * ratioChange * leverage * direction;
                pnlPct = ratioChange * 100 * leverage * direction;
            } else {
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
            }
        } else if (isIndexTrade) {
            teaSymbol = trade.index_symbol + ' IDX';
            // FIX #1: Use trade.price (server execution price) as the cost basis — no spread adjustment.
            const idxNotional = trade.quantity * trade.price;
            total = idxNotional / leverage;
            const isShortIdx = trade.side === 'SELL';

            if (isClosed && closing) {
                if (closing.realizedPnl !== undefined) {
                    pnl = closing.realizedPnl;
                } else {
                    const closePrice = closing.sellPrice ?? closing.coverPrice;
                    if (isShortIdx) {
                        pnl = (trade.price - closePrice) * trade.quantity;
                    } else {
                        pnl = (closePrice - trade.price) * trade.quantity;
                    }
                }
                pnlPct = total > 0 ? (pnl / total * 100) : 0;
            } else {
                const idxList = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
                const index = idxList.find(idx => idx.symbol === trade.index_symbol);

                if (index) {
                    // True Bid/Ask exit: INDEX spread = 2% total (1% per side)
                    // Longs sell at Bid (mid × 0.99), shorts cover at Ask (mid × 1.01)
                    const exitPrice = isShortIdx ? index.price * 1.01 : index.price * 0.99;
                    const notionalValue = total * leverage;
                    const units = notionalValue / trade.price;
                    pnl = isShortIdx
                        ? (trade.price - exitPrice) * units
                        : (exitPrice - trade.price) * units;
                    if (pnl < -total) pnl = -total;
                    pnlPct = total > 0 ? (pnl / total * 100) : 0;
                } else {
                    pnl = 0;
                    pnlPct = 0;
                }
            }
        } else {
            // Regular single tea trade (long or short)
            teaSymbol = tea?.symbol || 'Unknown';
            const teaNotional = trade.quantity * trade.price;
            total = teaNotional / leverage;
            const isShortTrade = trade.side === 'SELL';

            if (isClosed && closing) {
                if (closing.realizedPnl !== undefined) {
                    // Cumulative PnL from all matched chunks (correct for partial closes)
                    pnl = closing.realizedPnl;
                } else {
                    // Legacy fallback: single-exit-price formula
                    const closePrice = closing.sellPrice ?? closing.coverPrice;
                    if (isShortTrade) {
                        pnl = (trade.price - closePrice) * trade.quantity;
                    } else {
                        pnl = (closePrice - trade.price) * trade.quantity;
                    }
                }
                pnlPct = total > 0 ? (pnl / total * 100) : 0;
            } else if (tea) {
                // True Bid/Ask exit price — T212 model:
                // Longs sell at Bid (mid − half-spread), shorts cover at Ask (mid + half-spread).
                const spreadPct = (Number(tea.base_spread) || 0.01) * (Number(tea.volatility_multiplier) || 1.0);
                const exitPrice = isShortTrade
                    ? tea.current_price * (1 + spreadPct / 2)
                    : tea.current_price * (1 - spreadPct / 2);
                const notionalValue = total * leverage;
                const units = notionalValue / trade.price;
                pnl = isShortTrade
                    ? (trade.price - exitPrice) * units
                    : (exitPrice - trade.price) * units;
                if (pnl < -total) pnl = -total;
                pnlPct = total > 0 ? (pnl / total * 100) : 0;
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
            const isBuySide = trade.side === 'BUY';
            sideLabel = isBuySide ? 'BUY' : 'SHORT';
            sideClass = isBuySide ? 'buy-side' : 'sell-side';
            entryDisplay = '$' + trade.price.toFixed(4);
            qtyDisplay = trade.quantity.toLocaleString();
        }

        const returnVal = total + pnl;

        html += `
            <tr>
                <td>${timeStr}</td>
                <td style="font-family: 'JetBrains Mono', monospace;">${orderId}</td>
                <td>${escapeHtml(teaSymbol)}</td>
                <td><span class="order-side ${sideClass}">${sideLabel}</span></td>
                <td class="order-qty">${qtyDisplay}</td>
                <td class="order-price">${entryDisplay}</td>
                <td class="order-price">$${parseFloat(total.toFixed(2)).toLocaleString()}</td>
                <td class="${pnlClass}">${pnlSign}$${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)</td>
                <td class="order-price ${pnlClass}">$${returnVal.toFixed(2)}</td>
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

        tfootTotal.textContent = '$' + openTotalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        tfootPnl.className = `orders-summary-stat-value ${openPnlClass}`;
        tfootPnl.textContent = `${openPnlSign}$${openTotalPnl.toFixed(2)} (${openPnlPct.toFixed(1)}%)`;
        tfootCount.textContent = `${openCount} open`;
    } else {
        tfoot.style.display = 'none';
    }

    tbody.innerHTML = html;

    // T212 mobile trade rows
    const t212List = document.getElementById('t212-trades-list');
    if (t212List) {
        if (processedTrades.length === 0) {
            t212List.innerHTML = '<div style="color:#8b929e;font-size:13px;text-align:center;padding:40px 20px;">No orders yet. Start trading!</div>';
        } else {
            const openTrades = processedTrades.filter(p => !p.isClosed);
            const closedTrades = processedTrades.filter(p => p.isClosed);

            let t212Html = '';
            if (openTrades.length > 0) {
                t212Html += '<div class="t212-section-header">Open Positions</div>';
                openTrades.forEach(({ trade, teaSymbol, total, pnl, pnlPct, isPairTrade, isIndexTrade }) => {
                    const badgeClass = trade.side === 'BUY' ? 'text-green' : 'text-red';
                    const pnlClass = pnl >= 0 ? 't212-text-green' : 't212-text-red';
                    const pnlSign = pnl >= 0 ? '+' : '';
                    const currentValue = total + pnl;

                    let closeAction;
                    if (isPairTrade) {
                        closeAction = `confirmClosePosition('pair', '${trade.id}', '${escapeHtml(teaSymbol)}', ${pnl})`;
                    } else if (isIndexTrade) {
                        closeAction = `confirmClosePosition('index', '${trade.id}', '${escapeHtml(trade.index_symbol)}', ${pnl}, ${trade.quantity})`;
                    } else {
                        closeAction = `confirmClosePosition('tea', '${trade.id}', '${escapeHtml(teaSymbol)}', ${pnl}, ${trade.quantity}, ${trade.tea_id})`;
                    }

                    t212Html += `
                    <div class="t212-trade-row">
                        <div class="t212-close-btn" onclick="${closeAction}" title="Close position">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        </div>
                        <div class="t212-trade-left">
                            <span class="t212-symbol">${escapeHtml(teaSymbol)}</span>
                            <span class="t212-trade-desc"><span class="${badgeClass}" style="font-weight:600;">${trade.side}</span> &bull; Avg $${trade.price.toFixed(2)}</span>
                        </div>
                        <div class="t212-trade-right">
                            <span class="t212-trade-val">$${currentValue.toFixed(2)}</span>
                            <span class="t212-trade-pnl ${pnlClass}">${pnlSign}$${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)</span>
                        </div>
                    </div>`;
                });
            }
            if (closedTrades.length > 0) {
                t212Html += '<div class="t212-section-header">Closed</div>';
                closedTrades.forEach(({ trade, teaSymbol, total, pnl, pnlPct }) => {
                    const badgeClass = trade.side === 'BUY' ? 'text-green' : 'text-red';
                    const pnlClass = pnl >= 0 ? 't212-text-green' : 't212-text-red';
                    const pnlSign = pnl >= 0 ? '+' : '';
                    const currentValue = total + pnl;
                    const assetInitial = teaSymbol.substring(0, 1).toUpperCase();

                    t212Html += `
                    <div class="t212-trade-row" style="opacity:0.6;">
                        <div class="t212-trade-icon">${escapeHtml(assetInitial)}</div>
                        <div class="t212-trade-left">
                            <span class="t212-symbol">${escapeHtml(teaSymbol)}</span>
                            <span class="t212-trade-desc"><span class="${badgeClass}" style="font-weight:600;">${trade.side}</span> &bull; Avg $${trade.price.toFixed(2)}</span>
                        </div>
                        <div class="t212-trade-right">
                            <span class="t212-trade-val">$${currentValue.toFixed(2)}</span>
                            <span class="t212-trade-pnl ${pnlClass}">${pnlSign}$${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)</span>
                        </div>
                    </div>`;
                });
            }
            t212List.innerHTML = t212Html;
        }
    }
}

// =============================================
// CLOSE POSITION CONFIRMATION PROMPT
// =============================================

function confirmClosePosition(type, tradeId, symbol, pnl, quantity, teaId) {
    var existing = document.getElementById('close-position-modal');
    if (existing) existing.remove();

    var pnlColor = pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
    var pnlSign = pnl >= 0 ? '+' : '';
    var pnlText = pnlSign + '$' + Math.abs(pnl).toFixed(2);

    var modal = document.createElement('div');
    modal.id = 'close-position-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:10010;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);';
    modal.innerHTML = `
        <div style="background:#151d2b;border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:24px;width:calc(100% - 40px);max-width:340px;text-align:center;">
            <div style="width:44px;height:44px;border-radius:50%;background:rgba(239,68,68,0.12);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </div>
            <div style="font-size:16px;font-weight:600;color:#f3f4f6;margin-bottom:4px;">Close Position</div>
            <div style="font-size:13px;color:#9ca3af;margin-bottom:16px;">
                Are you sure you want to close<br>
                <span style="color:#f3f4f6;font-weight:600;">${symbol}</span>
                <span style="font-size:11px;color:#6b7280;"> (Ref: ${tradeId.toString().slice(0, 8)})</span>
            </div>
            <div style="font-size:15px;font-weight:600;color:${pnlColor};margin-bottom:20px;">
                P&L: ${pnlText}
            </div>
            <div style="display:flex;gap:10px;">
                <button onclick="document.getElementById('close-position-modal').remove()"
                    style="flex:1;padding:12px;border-radius:10px;border:1px solid rgba(255,255,255,0.1);background:transparent;color:#9ca3af;font-size:14px;font-weight:600;cursor:pointer;">
                    Cancel
                </button>
                <button id="confirm-close-btn"
                    style="flex:1;padding:12px;border-radius:10px;border:none;background:#ef4444;color:#fff;font-size:14px;font-weight:600;cursor:pointer;">
                    Close Position
                </button>
            </div>
        </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', function (e) { if (e.target === modal) modal.remove(); });

    document.getElementById('confirm-close-btn').addEventListener('click', function () {
        modal.remove();
        if (type === 'pair') {
            closePairPosition(tradeId);
        } else if (type === 'index') {
            closeIndexPosition(symbol, quantity, tradeId);
        } else {
            closePosition(teaId, quantity, symbol);
        }
    });
}

// =============================================
// PORTFOLIO TAB SWITCHING
// =============================================

function switchPortfolioTab(tab) {
    document.querySelectorAll('#portfolio-section .portfolio-tab').forEach(t => t.classList.remove('active'));
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
            setActiveBalance(result.new_balance);
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
        const { data, error } = await apiFetchLeaderboard(20);
        if (error) throw error;

        if (data && data.length > 0) {
            updateLeaderboardDisplay(data);
            if (typeof updateMobileLeaderboard === 'function') updateMobileLeaderboard(data);
        }
    } catch (error) {
        console.error('Failed to load leaderboard:', error);
    }
}

function updateLeaderboardDisplay(leaders) {
    const listEl = document.getElementById('leaderboard-list');
    let html = '';

    // Cache ranks for PRO gating
    state._leaderboardRanks = {};
    leaders.forEach((user, i) => {
        state._leaderboardRanks[user.username.toLowerCase()] = i + 1;
    });

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

        const userTier = user.tier || 'FREE';
        const hasFundedBadge = user.combine_badge === true;
        let badgeHtml = (userTier === 'PRO' ? '<span class="badge-pro">PRO</span>' : '')
            + (hasFundedBadge ? '<span class="badge-funded">FUNDED</span>' : '');

        let userBadges = user.badges;
        if (typeof userBadges === 'string') { try { userBadges = JSON.parse(userBadges); } catch { userBadges = []; } }
        if (Array.isArray(userBadges) && userBadges.length > 0 && typeof BADGE_DEFINITIONS !== 'undefined' && typeof BADGE_PRIORITY !== 'undefined') {
            const topIcons = BADGE_PRIORITY.filter(id => userBadges.includes(id)).slice(0, 3);
            if (topIcons.length > 0) {
                badgeHtml += '<span class="leaderboard-badges">' + topIcons.map(id => {
                    const d = BADGE_DEFINITIONS[id];
                    if (!d) return '';
                    return `<span class="badge-icon-inline" style="background:${d.bg};color:${d.color}"><span class="badge-tooltip">${d.name}<span class="badge-tooltip-desc">${d.desc}</span></span>${d.svg}</span>`;
                }).join('') + '</span>';
            }
        }

        html += `
            <div class="leaderboard-item leaderboard-item-clickable" onclick="openTraderProfile('${user.username}', ${returnPct}, ${totalValue}, ${rank})">
                <div class="leaderboard-rank ${rankClass}">${rank}</div>
                <div class="leaderboard-name">${escapeHtml(user.username)}${badgeHtml}</div>
                <div class="leaderboard-return ${returnClass}">${returnSign}${returnPct.toFixed(1)}%</div>
                <div class="leaderboard-follow-star ${isFollowed ? 'followed' : ''}" title="${isFollowed ? 'Following' : 'Follow'}">${followIcon}</div>
            </div>
        `;
    });

    if (html) {
        if (listEl) listEl.innerHTML = html;
        if (typeof populateSocialLeaderboard === 'function') populateSocialLeaderboard();
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
        setActiveBalance(result.new_balance || 10000);

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

async function toggleFollowTrader(username, returnPct, totalValue) {
    let list = getTraderWatchlist();
    const idx = list.findIndex(t => t.username === username);
    const isFollow = idx === -1;

    // PRO gating: free users cannot follow Top 5 leaderboard traders
    if (isFollow && state._leaderboardRanks) {
        const rank = state._leaderboardRanks[username.toLowerCase()];
        if (rank && rank <= 5 && (state.userProfile?.tier || 'FREE') !== 'PRO') {
            showToast('PRO Required', `Following Top 5 traders requires TeaTrade PRO (£14.99/mo)`, true);
            return;
        }
    }

    if (isFollow) {
        list.push({ username, returnPct, totalValue, followedAt: new Date().toISOString() });
        showToast('Following', `You are now following ${username}`);
    } else {
        list.splice(idx, 1);
        showToast('Unfollowed', `Removed ${username} from your watchlist`);
    }
    saveTraderWatchlist(list);
    if (typeof loadLeaderboard === 'function') loadLeaderboard();
    _refreshTraderProfileFollowBtn(username);

    const { data: profile } = await apiLookupUserByUsername(username);
    if (profile?.id) {
        if (isFollow) {
            await apiFollowUser(profile.id);
        } else {
            await apiUnfollowUser(profile.id);
        }
        _refreshFollowCounts(profile.id);
    }

    _refreshOwnFollowCounts();

    if (isFollow) _ensureTradeNotificationChannel();
}

function _refreshTraderProfileFollowBtn(username) {
    const btn = document.getElementById('trader-profile-follow-btn');
    if (!btn) return;
    const followed = isTraderFollowed(username);
    btn.textContent = followed ? '★ Following' : '☆ Follow Trader';
    btn.className = 'trader-profile-follow-btn' + (followed ? ' following' : '');
}

async function _refreshFollowCounts(userId) {
    const counts = await apiFetchFollowCounts(userId);
    const el = document.getElementById('trader-profile-follow-counts');
    if (!el) return;
    el.innerHTML = `
        <span class="follow-count-item"><strong>${counts.follower_count}</strong> Followers</span>
        <span class="follow-count-divider">·</span>
        <span class="follow-count-item"><strong>${counts.following_count}</strong> Following</span>`;
}

async function _refreshOwnFollowCounts() {
    if (!state.currentUser?.id) return;
    const counts = await apiFetchFollowCounts(state.currentUser.id);
    const el = document.getElementById('portfolio-header-follow-counts');
    if (el) {
        el.innerHTML = `
            <span class="follow-count-item"><strong>${counts.follower_count}</strong> Followers</span>
            <span class="follow-count-divider">·</span>
            <span class="follow-count-item"><strong>${counts.following_count}</strong> Following</span>`;
    }
    const countEl = document.getElementById('portfolio-wl-count');
    if (countEl) countEl.textContent = getTraderWatchlist().length;
}

// =============================================
// TRADE NOTIFICATIONS FOR FOLLOWED TRADERS
// =============================================

let _tradeNotifyChannel = null;
let _allFollowedIds = new Set();
let _mutedFollowedIds = new Set();
let _notifyPollTimer = null;
let _lastSeenTradeId = 0;
let _notifySeenTrades = new Set();

function reconnectTradeNotifications() {
    _stopNotifyPolling();
    if (_tradeNotifyChannel) {
        try { supabaseClient.removeChannel(_tradeNotifyChannel); } catch (_) { }
        _tradeNotifyChannel = null;
    }
    _ensureTradeNotificationChannel();
}

async function _ensureTradeNotificationChannel() {
    if (!state.currentUser?.id) return;

    const follows = await apiFetchMyFollows();
    _allFollowedIds = new Set(follows.map(f => f.following_id));
    _mutedFollowedIds = new Set(
        follows.filter(f => f.notify === false).map(f => f.following_id)
    );

    for (const f of follows) {
        if (_tradeNotifyProfileCache[f.following_id]) continue;
        try {
            const { data } = await supabaseClient
                .from('profiles')
                .select('username')
                .eq('id', f.following_id)
                .single();
            if (data?.username) _tradeNotifyProfileCache[f.following_id] = data.username;
        } catch (_) { }
    }

    console.log('[FollowNotify] all followed IDs:', [..._allFollowedIds]);
    console.log('[FollowNotify] muted IDs:', [..._mutedFollowedIds]);
    console.log('[FollowNotify] profile cache:', { ..._tradeNotifyProfileCache });

    if (_allFollowedIds.size === 0) {
        _stopNotifyPolling();
        if (_tradeNotifyChannel) {
            supabaseClient.removeChannel(_tradeNotifyChannel);
            _tradeNotifyChannel = null;
        }
        return;
    }

    if (!_tradeNotifyChannel) {
        _tradeNotifyChannel = supabaseClient
            .channel('follow-trade-notifications')
            .on('postgres_changes',
                { event: 'INSERT', schema: 'public', table: 'trades' },
                (payload) => {
                    console.log('[FollowNotify] Realtime INSERT:', payload.new?.id, payload.new?.user_id);
                    const trade = payload.new;
                    if (!trade || !_allFollowedIds.has(trade.user_id)) return;
                    if (_mutedFollowedIds.has(trade.user_id)) return;
                    const key = `${trade.id || trade.created_at}`;
                    if (_notifySeenTrades.has(key)) return;
                    _notifySeenTrades.add(key);
                    if (trade.id) _lastSeenTradeId = Math.max(_lastSeenTradeId, trade.id);
                    _showTradeNotification(trade);
                }
            )
            .subscribe((status) => {
                console.log('[FollowNotify] Realtime status:', status);
            });
    }

    await _initLastSeenTradeId();
    _startNotifyPolling();
}

function _startNotifyPolling() {
    _stopNotifyPolling();
    _notifyPollTimer = setInterval(_pollFollowedTrades, 10000);
    console.log('[FollowNotify] polling started (10s interval), lastSeenId:', _lastSeenTradeId);
}

function _stopNotifyPolling() {
    if (_notifyPollTimer) {
        clearInterval(_notifyPollTimer);
        _notifyPollTimer = null;
    }
}

async function _initLastSeenTradeId() {
    try {
        const ids = [..._allFollowedIds];
        if (ids.length === 0) return;
        const { data } = await supabaseClient
            .from('trades')
            .select('id')
            .in('user_id', ids)
            .order('id', { ascending: false })
            .limit(1);
        if (data?.[0]?.id) _lastSeenTradeId = data[0].id;
    } catch (_) { }
}

async function _pollFollowedTrades() {
    if (!state.currentUser?.id || _allFollowedIds.size === 0) return;

    try {
        const ids = [..._allFollowedIds];
        const { data: trades, error } = await supabaseClient
            .from('trades')
            .select('id, user_id, side, quantity, price, tea_id, index_symbol, created_at')
            .in('user_id', ids)
            .gt('id', _lastSeenTradeId)
            .order('id', { ascending: true })
            .limit(10);

        if (error) { console.warn('[FollowNotify] poll query error:', error.message); return; }
        if (!trades || trades.length === 0) return;

        console.log('[FollowNotify] poll found', trades.length, 'new trades');
        for (const trade of trades) {
            _lastSeenTradeId = Math.max(_lastSeenTradeId, trade.id);
            const key = `${trade.id}`;
            if (_notifySeenTrades.has(key)) continue;
            _notifySeenTrades.add(key);
            if (_mutedFollowedIds.has(trade.user_id)) continue;
            _showTradeNotification(trade);
        }
    } catch (e) {
        console.warn('[FollowNotify] poll error:', e.message);
    }
}

async function _showTradeNotification(trade) {
    const stack = document.getElementById('follow-notify-stack');
    if (!stack) return;

    const teaMap = {};
    (state.teas || []).forEach(t => { teaMap[t.id] = t.symbol; });
    const sym = trade.index_symbol || teaMap[trade.tea_id] || '???';
    const side = (trade.side || 'BUY').toUpperCase();
    const isBuy = side === 'BUY';
    const qty = Number(trade.quantity).toLocaleString();
    const price = Number(trade.price).toFixed(2);
    const total = (trade.quantity * trade.price).toFixed(2);

    let username = _tradeNotifyProfileCache[trade.user_id];
    if (!username) {
        try {
            const { data } = await supabaseClient
                .from('profiles')
                .select('username')
                .eq('id', trade.user_id)
                .single();
            if (data?.username) {
                username = data.username;
                _tradeNotifyProfileCache[trade.user_id] = username;
            }
        } catch (_) { }
    }
    if (!username) username = trade.user_id?.slice(0, 8) || 'Trader';
    const initials = username.slice(0, 2).toUpperCase();

    const isIndex = !!trade.index_symbol;
    const selectVal = isIndex ? `INDEX_${sym}` : (trade.tea_id || '');

    const cardId = `fn-card-${Date.now()}`;
    const card = document.createElement('div');
    card.className = `follow-notify-card ${isBuy ? 'fn-border-buy' : 'fn-border-sell'}`;
    card.id = cardId;
    card.innerHTML = `
        <div class="fn-header">
            <div class="fn-avatar">${escapeHtml(initials)}</div>
            <div class="fn-trader-name">${escapeHtml(username)}</div>
            <button class="fn-close" onclick="_dismissFollowNotify('${cardId}')" title="Dismiss">✕</button>
        </div>
        <div class="fn-body">
            <span class="fn-side ${isBuy ? 'buy' : 'sell'}">${side}</span>
            <div class="fn-details">
                <span class="fn-sym">${escapeHtml(sym)}</span> · ${qty} kg<br>
                @ $${price} · Total $${Number(total).toLocaleString()}
            </div>
        </div>
        <div class="fn-footer">
            <button class="fn-copy-btn" onclick="_copyFollowTrade('${selectVal}', '${side}', ${trade.quantity}, '${cardId}')">Copy Trade</button>
            <button class="fn-dismiss-btn" onclick="_dismissFollowNotify('${cardId}')">Dismiss</button>
        </div>`;

    stack.appendChild(card);

    const MAX_CARDS = 4;
    while (stack.children.length > MAX_CARDS) {
        stack.removeChild(stack.firstChild);
    }

    // Auto-copy: if PRO and this trader is in auto-copy list, execute immediately
    if ((state.userProfile?.tier === 'PRO') && _isAutoCopyEnabled(trade.user_id)) {
        _executeAutoCopy(sym, side, trade.quantity, isIndex, trade.price, cardId);
    }

    setTimeout(() => _dismissFollowNotify(cardId), 15000);
}

function _dismissFollowNotify(cardId) {
    const card = document.getElementById(cardId);
    if (!card) return;
    card.classList.add('removing');
    setTimeout(() => card.remove(), 300);
}

function _copyFollowTrade(selectVal, side, quantity, cardId) {
    const select = document.getElementById('trade-tea-select');
    if (select) {
        select.value = selectVal;
        select.dispatchEvent(new Event('change'));
    }

    if (typeof setTradeType === 'function') setTradeType(side);

    const qtyEl = document.getElementById('trade-qty');
    if (qtyEl) {
        qtyEl.value = quantity;
        qtyEl.dispatchEvent(new Event('input'));
    }

    if (typeof updateTradeSummary === 'function') updateTradeSummary();

    _dismissFollowNotify(cardId);
    showToast('Trade Copied', `${side} ${Number(quantity).toLocaleString()} kg ready — review and execute`);
}

// =============================================
// AUTO-COPY (PRO feature)
// =============================================

const AUTOCOPY_KEY = 'tt_autocopy_users';

function _getAutoCopyList() {
    try { return JSON.parse(localStorage.getItem(AUTOCOPY_KEY) || '[]'); }
    catch { return []; }
}

function _isAutoCopyEnabled(userId) {
    return _getAutoCopyList().includes(userId);
}

function toggleAutoCopy(userId) {
    if ((state.userProfile?.tier || 'FREE') !== 'PRO') {
        showToast('PRO Required', 'Auto-copy requires TeaTrade PRO (£14.99/mo)', true);
        return;
    }
    let list = _getAutoCopyList();
    const idx = list.indexOf(userId);
    if (idx === -1) {
        list.push(userId);
        showToast('Auto-Copy On', 'Trades from this trader will be mirrored automatically');
    } else {
        list.splice(idx, 1);
        showToast('Auto-Copy Off', 'Auto-copy disabled for this trader');
    }
    localStorage.setItem(AUTOCOPY_KEY, JSON.stringify(list));
}

async function _executeAutoCopy(sym, side, quantity, isIndex, price, cardId) {
    try {
        let result;
        if (isIndex) {
            result = await apiExecuteIndexTrade(sym, side, quantity, price, 1);
        } else {
            result = await apiExecuteTrade(sym, side, quantity, 1);
        }
        if (result?.success) {
            showToast('Auto-Copied', `${side} ${Number(quantity).toLocaleString()} kg of ${sym}`);
            setActiveBalance(result.new_balance);
        }
        _dismissFollowNotify(cardId);
    } catch (e) {
        console.warn('Auto-copy failed:', e.message);
    }
}

const _tradeNotifyProfileCache = {};

async function _buildNotifyProfileCache() {
    // Cache is now built inside _ensureTradeNotificationChannel;
    // this function is kept as a no-op for backward compatibility.
}

async function toggleFollowNotify(targetUserId, currentState) {
    const newState = !currentState;
    await apiToggleFollowNotify(targetUserId, newState);

    if (newState) {
        _mutedFollowedIds.delete(targetUserId);
    } else {
        _mutedFollowedIds.add(targetUserId);
    }

    return newState;
}

// =============================================
// TRADER PROFILE MODAL
// =============================================

async function openTraderProfile(username, returnPct, totalValue, rank) {
    const modal = document.getElementById('trader-profile-modal');
    if (!modal) return;

    const hasPrecomputed = returnPct != null && totalValue != null;
    const followed = isTraderFollowed(username);
    const initials = username.slice(0, 2).toUpperCase();

    const _rankStr = (r) => {
        if (r == null) return '';
        return r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`;
    };

    const _buildCard = (rp, tv, r, profileMeta) => {
        const isLoading = rp == null || tv == null;
        const retClass = isLoading ? '' : (rp >= 0 ? 'up' : 'down');
        const retSign = isLoading ? '' : (rp >= 0 ? '+' : '');
        const startVal = isLoading ? 0 : (tv / (1 + rp / 100) || 0);
        const gainLoss = isLoading ? 0 : (tv - startVal);
        const gainSign = gainLoss >= 0 ? '+' : '';

        const rankLabel = r != null ? `${_rankStr(r)} Rank ${r}` : '';
        const joinDate = profileMeta?.created_at
            ? new Date(profileMeta.created_at).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
            : '';
        const subtitleParts = [rankLabel, joinDate ? `Joined ${joinDate}` : ''].filter(Boolean);
        const subtitle = subtitleParts.join(' · ') || 'Trader';

        const tradeCount = profileMeta?._tradeCount;
        const mainAsset = profileMeta?._mainAsset;

        let avatarHtml = `<div class="trader-profile-avatar">${initials}</div>`;
        const _badges = profileMeta?._badges;
        if (Array.isArray(_badges) && _badges.length > 0 && typeof BADGE_DEFINITIONS !== 'undefined') {
            const showcase = profileMeta?._showcase || BADGE_PRIORITY.find(id => _badges.includes(id)) || _badges[0];
            const def = BADGE_DEFINITIONS[showcase];
            if (def) {
                avatarHtml = `<div class="trader-profile-avatar badge-avatar"><div class="avatar-badge-bg" style="background:${def.bg};color:${def.color}">${def.svg}</div></div>`;
            }
        }

        return `
            <div class="trader-profile-overlay" onclick="closeTraderProfile()"></div>
            <div class="trader-profile-card">
                <button class="trader-profile-close" onclick="closeTraderProfile()">✕</button>
                <div class="trader-profile-header">
                    ${avatarHtml}
                    <div class="trader-profile-info">
                        <div class="trader-profile-name">${escapeHtml(profileMeta?.display_name || username)}</div>
                        <div class="trader-profile-rank">${subtitle}</div>
                        <div id="trader-profile-follow-counts" class="trader-profile-follow-counts">
                            <span class="follow-count-item"><strong>—</strong> Followers</span>
                            <span class="follow-count-divider">·</span>
                            <span class="follow-count-item"><strong>—</strong> Following</span>
                        </div>
                    </div>
                </div>
                <div class="trader-profile-stats" id="trader-profile-stats-grid">
                    <div class="trader-stat-box">
                        <div class="trader-stat-label">Return</div>
                        <div class="trader-stat-value ${retClass}">${isLoading ? '—' : `${retSign}${rp.toFixed(1)}%`}</div>
                    </div>
                    <div class="trader-stat-box">
                        <div class="trader-stat-label">Portfolio Value</div>
                        <div class="trader-stat-value">${isLoading ? '—' : '$' + tv.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
                    </div>
                    <div class="trader-stat-box">
                        <div class="trader-stat-label">P&amp;L</div>
                        <div class="trader-stat-value ${isLoading ? '' : (gainLoss >= 0 ? 'up' : 'down')}">${isLoading ? '—' : `${gainSign}$${Math.abs(gainLoss).toLocaleString('en-US', { maximumFractionDigits: 0 })}`}</div>
                    </div>
                    <div class="trader-stat-box">
                        <div class="trader-stat-label">Trades</div>
                        <div class="trader-stat-value">${tradeCount != null ? tradeCount.toLocaleString() : '—'}</div>
                    </div>
                    ${mainAsset ? `<div class="trader-stat-box trader-stat-wide">
                        <div class="trader-stat-label">Most Traded</div>
                        <div class="trader-stat-value">${escapeHtml(mainAsset)}</div>
                    </div>` : ''}
                </div>
                <div class="trader-profile-badges-section">
                    <div class="trader-activity-label">Badges</div>
                    <div id="trader-profile-badges-row" class="trader-profile-badges">
                        <span class="trader-badge-pill" style="color:var(--text-muted);">Loading...</span>
                    </div>
                </div>
                <div class="trader-profile-activity">
                    <div class="trader-activity-label">Recent Activity</div>
                    <div id="trader-profile-trade-feed" class="portfolio-trade-feed">
                        <div class="portfolio-notification-placeholder">Loading trades...</div>
                    </div>
                </div>
                <button id="trader-profile-follow-btn"
                    class="trader-profile-follow-btn${followed ? ' following' : ''}"
                    onclick="toggleFollowTrader('${escapeHtml(username)}', ${rp || 0}, ${tv || 0})">
                    ${followed ? '★ Following' : '☆ Follow Trader'}
                </button>
            </div>`;
    };

    modal.innerHTML = _buildCard(
        hasPrecomputed ? returnPct : null,
        hasPrecomputed ? totalValue : null,
        rank,
        null
    );
    _loadTraderProfileTrades(username);
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    const [liveProfile, profileData, tradeSummary] = await Promise.all([
        apiFetchTraderProfile(username),
        apiLookupUserByUsername(username),
        _fetchTraderSummary(username)
    ]);

    if (liveProfile) {
        returnPct = liveProfile.return_pct ?? returnPct;
        totalValue = liveProfile.total_value ?? totalValue;
        rank = liveProfile.rank ?? rank;
    }

    let _profileBadges = profileData?.data?.badges;
    if (typeof _profileBadges === 'string') { try { _profileBadges = JSON.parse(_profileBadges); } catch { _profileBadges = []; } }
    if (!Array.isArray(_profileBadges)) _profileBadges = [];

    const meta = {
        display_name: profileData?.data?.username || username,
        created_at: profileData?.data?.created_at || null,
        _tradeCount: tradeSummary?.count ?? null,
        _mainAsset: tradeSummary?.topAsset ?? null,
        _badges: _profileBadges,
        _showcase: profileData?.data?.showcase_badge || null,
    };

    modal.innerHTML = _buildCard(returnPct, totalValue, rank, meta);
    _loadTraderProfileTrades(username);

    if (profileData?.data?.id) _refreshFollowCounts(profileData.data.id);

    const traderBadges = profileData?.data?.badges;
    const badgesArr = Array.isArray(traderBadges) ? traderBadges
        : (typeof traderBadges === 'string' ? (function () { try { return JSON.parse(traderBadges); } catch { return []; } })() : []);
    const badgesRow = document.getElementById('trader-profile-badges-row');
    if (badgesRow) {
        if (badgesArr.length === 0) {
            badgesRow.innerHTML = '<span class="trader-badge-pill">No badges yet</span>';
        } else {
            badgesRow.innerHTML = badgesArr.map(id => {
                const def = BADGE_DEFINITIONS[id];
                if (!def) return '';
                return `<span class="profile-badge-circle" style="background:${def.bg};color:${def.color}"><span class="badge-tooltip">${def.name}<span class="badge-tooltip-desc">${def.desc}</span></span>${def.svg}</span>`;
            }).join('');
        }
    }
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

async function openPortfolioModal() {
    const modal = document.getElementById('portfolio-modal');
    if (!modal) return;

    const countEl = document.getElementById('portfolio-wl-count');
    if (countEl) countEl.textContent = getTraderWatchlist().length;

    switchPortfolioModalTab('financial');
    renderPortfolioModal();
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    if (state.currentUser?.id) {
        _syncMissingFollowsToDb().then(() => _refreshOwnFollowCounts());
        _refreshOwnFollowCounts();
    }
}

async function _syncMissingFollowsToDb() {
    if (!state.currentUser) return;
    const localList = getTraderWatchlist();
    if (localList.length === 0) return;

    const dbFollows = await apiFetchMyFollows();
    const dbFollowedIds = new Set(dbFollows.map(f => f.following_id));

    for (const entry of localList) {
        const { data: profile } = await apiLookupUserByUsername(entry.username);
        if (profile?.id && profile.id !== state.currentUser.id && !dbFollowedIds.has(profile.id)) {
            await apiFollowUser(profile.id);
        }
    }
}

function closePortfolioModal() {
    const modal = document.getElementById('portfolio-modal');
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }
}

function switchPortfolioModalTab(tab) {
    document.querySelectorAll('.portfolio-modal .portfolio-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.getElementById('portfolio-tab-financial').style.display = tab === 'financial' ? 'block' : 'none';
    document.getElementById('portfolio-tab-history').style.display = tab === 'history' ? 'block' : 'none';
    document.getElementById('portfolio-tab-social').style.display = tab === 'social' ? 'flex' : 'none';
    const badgesTab = document.getElementById('portfolio-tab-badges');
    if (badgesTab) badgesTab.style.display = tab === 'badges' ? 'block' : 'none';
    const storeTab = document.getElementById('portfolio-tab-store');
    if (storeTab) storeTab.style.display = tab === 'store' ? 'block' : 'none';
    const payoutsTab = document.getElementById('portfolio-tab-payouts');
    if (payoutsTab) payoutsTab.style.display = tab === 'payouts' ? 'block' : 'none';
    if (tab === 'financial') renderFinancialTab();
    if (tab === 'history') renderHistoryTab();
    if (tab === 'social') renderPortfolioModal();
    if (tab === 'badges') renderBadgesTab();
    if (tab === 'store') renderStoreTab();
    if (tab === 'payouts') renderPayoutsTab();
}

function renderFinancialTab() {
    const panel = document.getElementById('portfolio-financial-panel');
    if (!panel) return;

    const balance = getActiveBalance();
    const positions = state.positions || [];
    const indexPositionsData = state.indexPositions || {};
    const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];

    let holdingsValue = 0;
    let totalPnl = 0;
    let positionsHtml = '';

    let totalUsedMargin = 0;

    positions.forEach(pos => {
        const tea = pos.teas || state.teas.find(t => t.id === pos.tea_id);
        if (!tea) return;
        const isShort = pos.quantity < 0;
        const absQty = Math.abs(pos.quantity);
        const cost = absQty * pos.avg_entry_price;
        const spread = (Number(tea.base_spread) || 0.01) * (Number(tea.volatility_multiplier) || 1.0);
        const exitPx = isShort ? tea.current_price * (1 + spread / 2) : tea.current_price * (1 - spread / 2);
        const pnl = isShort
            ? (pos.avg_entry_price - exitPx) * absQty
            : (exitPx - pos.avg_entry_price) * absQty;
        const lev = Number(pos.leverage) || 1;
        const marginUsed = Number(pos.margin_used) || (cost / lev);
        const pnlPct = marginUsed > 0 ? (pnl / marginUsed * 100).toFixed(1) : '0.0';
        const returnVal = marginUsed + pnl;
        holdingsValue += returnVal;
        totalPnl += pnl;
        totalUsedMargin += marginUsed;
        const shortBadge = isShort ? ' <span style="color:var(--accent-red);font-size:10px;font-weight:700">SHORT</span>' : '';
        const levBadge = (pos.leverage && pos.leverage > 1) ? ` <span style="color:var(--accent-orange);font-size:10px;font-weight:700">${pos.leverage}x</span>` : '';
        positionsHtml += `
            <div class="pf-pos-row">
                <div class="pf-pos-symbol">${escapeHtml(tea.symbol)}${shortBadge}${levBadge}</div>
                <div class="pf-pos-qty">${absQty.toLocaleString()} kg</div>
                <div class="pf-pos-avg">$${pos.avg_entry_price.toFixed(4)}</div>
                <div class="pf-pos-cur">$${tea.current_price.toFixed(4)}</div>
                <div class="pf-pos-val">$${returnVal.toFixed(2)}</div>
                <div class="pf-pos-pnl ${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct}%)</div>
            </div>`;
    });

    Object.entries(indexPositionsData).forEach(([symbol, pos]) => {
        const idx = indexes.find(i => i.symbol === symbol);
        if (!idx || !pos || pos.quantity === 0) return;
        const isShort = pos.quantity < 0;
        const absQty = Math.abs(pos.quantity);
        const cost = absQty * pos.avg_entry_price;
        const idxSpread = 0.01;
        const exitPx = isShort ? idx.price * (1 + idxSpread / 2) : idx.price * (1 - idxSpread / 2);
        const pnl = isShort
            ? (pos.avg_entry_price - exitPx) * absQty
            : (exitPx - pos.avg_entry_price) * absQty;
        const idxLev = Number(pos.leverage) || 1;
        const idxMarginUsed = Number(pos.margin_used) || (cost / idxLev);
        const pnlPct = idxMarginUsed > 0 ? (pnl / idxMarginUsed * 100).toFixed(1) : '0.0';
        const idxReturnVal = idxMarginUsed + pnl;
        holdingsValue += idxReturnVal;
        totalPnl += pnl;
        totalUsedMargin += idxMarginUsed;
        const shortBadge = isShort ? ' <span style="color:var(--accent-red);font-size:10px;font-weight:700">SHORT</span>' : '';
        const levBadge = (pos.leverage && pos.leverage > 1) ? ` <span style="color:var(--accent-orange);font-size:10px;font-weight:700">${pos.leverage}x</span>` : '';
        positionsHtml += `
            <div class="pf-pos-row">
                <div class="pf-pos-symbol">${escapeHtml(symbol)} <span class="pf-idx-badge">IDX</span>${shortBadge}${levBadge}</div>
                <div class="pf-pos-qty">${absQty.toLocaleString()} kg</div>
                <div class="pf-pos-avg">$${pos.avg_entry_price.toFixed(4)}</div>
                <div class="pf-pos-cur">$${idx.price.toFixed(4)}</div>
                <div class="pf-pos-val">$${idxReturnVal.toFixed(2)}</div>
                <div class="pf-pos-pnl ${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct}%)</div>
            </div>`;
    });

    const equity = balance + totalPnl;
    const freeMargin = equity - totalUsedMargin;
    const startBal = state.tradingMode === 'REAL' ? 0 : 10000;
    const overallReturn = equity - startBal;
    const overallPct = startBal > 0 ? (overallReturn / startBal * 100).toFixed(2) : '0.00';
    const posCount = positions.length + Object.values(indexPositionsData).filter(p => p && p.quantity !== 0).length;

    // Account health: equity as % of starting balance (for bar visualisation only)
    const equityPct = startBal > 0 ? (equity / startBal * 100) : (posCount > 0 ? 0 : 100);
    const phColor = equity <= 1 ? 'var(--accent-red)' : equity <= 200 ? 'var(--accent-orange)' : equity <= 1000 ? '#f59e0b' : 'var(--accent-green)';

    let barStatus, barStatusColor;
    if (equity <= 0) {
        barStatus = 'LIQUIDATION'; barStatusColor = 'var(--accent-red)';
    } else if (posCount > 0 && equity <= 1) {
        barStatus = 'CLOSE OUT'; barStatusColor = 'var(--accent-red)';
    } else if (posCount > 0 && equity <= 200) {
        barStatus = 'LOW EQUITY'; barStatusColor = 'var(--accent-orange)';
    } else if (posCount > 0 && equity <= 1000) {
        barStatus = 'CAUTION'; barStatusColor = '#f59e0b';
    } else {
        barStatus = 'HEALTHY'; barStatusColor = 'var(--accent-green)';
    }

    const healthPct = Math.max(0, Math.min(equityPct, 100));
    let barUsedPct, barFreePct;
    if (posCount === 0 || totalUsedMargin <= 0) {
        barUsedPct = 0;
        barFreePct = 100;
    } else if (equity <= 0) {
        barUsedPct = 100;
        barFreePct = 0;
    } else {
        barFreePct = Math.min(healthPct, 100);
        barUsedPct = 100 - barFreePct;
    }

    const showMarkers = totalUsedMargin > 0 && posCount > 0;
    const marginCallLine = showMarkers ? 2 : 0;    // 2% from left ($200)
    const stopOutLine = showMarkers ? 0.01 : 0;    // near 0% from left ($1)

    const phDisplay = '$' + equity.toFixed(2);

    panel.innerHTML = `
        <div class="pf-summary-grid">
            <div class="pf-summary-card pf-summary-main">
                <div class="pf-summary-label">Equity</div>
                <div class="pf-summary-value-big">$${equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                <div class="pf-summary-return ${overallReturn >= 0 ? 'up' : 'down'}">${overallReturn >= 0 ? '+' : ''}$${overallReturn.toFixed(2)} (${overallPct}%)</div>
            </div>
        </div>

        <div class="pf-margin-bar-container">
            <div class="pf-margin-bar-header">
                <span class="pf-margin-bar-title">Account Health</span>
                <span class="pf-margin-bar-status" style="color:${barStatusColor}">${barStatus}</span>
                <span class="pf-margin-bar-level" style="color:${phColor}">Equity: ${phDisplay}</span>
            </div>
            <div class="pf-margin-bar-track ${equity <= 0 ? 'pf-bar-danger' : ''}">
                <div class="pf-margin-bar-used" style="width:${barUsedPct.toFixed(1)}%"></div>
                <div class="pf-margin-bar-free" style="width:${barFreePct.toFixed(1)}%;left:${barUsedPct.toFixed(1)}%"></div>
                ${showMarkers ? `
                <div class="pf-margin-bar-marker pf-margin-marker-call" style="left:${marginCallLine}%">
                    <div class="pf-margin-marker-line"></div>
                    <div class="pf-margin-marker-label">WARNING ($200)</div>
                </div>
                <div class="pf-margin-bar-marker pf-margin-marker-stop" style="left:${stopOutLine}%">
                    <div class="pf-margin-marker-line"></div>
                    <div class="pf-margin-marker-label">CLOSE OUT ($0)</div>
                </div>` : ''}
            </div>
            <div class="pf-margin-bar-legend">
                <div class="pf-margin-legend-item">
                    <span class="pf-margin-legend-dot" style="background:var(--accent-blue)"></span>
                    <span>Invested: $${totalUsedMargin.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div class="pf-margin-legend-item">
                    <span class="pf-margin-legend-dot" style="background:var(--accent-green)"></span>
                    <span>Equity: $${Math.max(equity, 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div class="pf-margin-legend-item">
                    <span class="pf-margin-legend-dot" style="background:${totalPnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}"></span>
                    <span>P&amp;L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</span>
                </div>
            </div>
        </div>

        <div class="pf-summary-grid pf-summary-detail-grid">
            <div class="pf-summary-card">
                <div class="pf-summary-label">Cash Balance</div>
                <div class="pf-summary-value">$${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            </div>
            <div class="pf-summary-card">
                <div class="pf-summary-label">Invested</div>
                <div class="pf-summary-value">$${totalUsedMargin.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            </div>
            <div class="pf-summary-card">
                <div class="pf-summary-label">Free Funds</div>
                <div class="pf-summary-value">$${freeMargin.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            </div>
            <div class="pf-summary-card">
                <div class="pf-summary-label">Open Positions</div>
                <div class="pf-summary-value">${posCount}</div>
            </div>
        </div>
        <div class="pf-section">
            <div class="pf-section-title">Open Positions</div>
            ${posCount === 0
            ? '<div class="pf-empty">No open positions. Start trading to build your portfolio.</div>'
            : `<div class="pf-positions-table">
                    <div class="pf-pos-header">
                        <div>Symbol</div><div>Qty</div><div>Avg Entry</div><div>Current</div><div>Return</div><div>P&amp;L</div>
                    </div>
                    ${positionsHtml}
                   </div>`}
        </div>
        <div class="pf-section">
            <div class="pf-section-title">Recent Trades</div>
            <div id="portfolio-own-trade-feed" class="portfolio-trade-feed">
                <div class="portfolio-notification-placeholder">Loading...</div>
            </div>
        </div>
    `;

    _loadOwnTrades();
}

async function _loadOwnTrades() {
    const feedEl = document.getElementById('portfolio-own-trade-feed');
    if (!feedEl || !state.currentUser) return;

    try {
        const { data: trades, error } = await supabaseClient
            .from('trades')
            .select('side, quantity, price, tea_id, index_symbol, created_at')
            .eq('user_id', state.currentUser.id)
            .order('created_at', { ascending: false })
            .limit(20);

        if (error || !trades?.length) {
            feedEl.innerHTML = '<div class="portfolio-notification-placeholder">No trades yet</div>';
            return;
        }

        const teaMap = {};
        (state.teas || []).forEach(t => { teaMap[t.id] = t.symbol; });

        feedEl.innerHTML = trades.map(t => {
            const sym = t.index_symbol || teaMap[t.tea_id] || '???';
            const isBuy = t.side === 'BUY';
            const ago = _timeAgo(new Date(t.created_at));
            const total = (t.quantity * t.price).toFixed(2);
            return `<div class="portfolio-trade-item">
                <span class="portfolio-trade-side ${isBuy ? 'buy' : 'sell'}">${t.side}</span>
                <span class="portfolio-trade-sym">${sym}</span>
                <span class="portfolio-trade-qty">${Number(t.quantity).toLocaleString()} kg</span>
                <span class="portfolio-trade-price">@ $${Number(t.price).toFixed(2)}</span>
                <span class="portfolio-trade-total">$${Number(total).toLocaleString()}</span>
                <span class="portfolio-trade-time">${ago}</span>
            </div>`;
        }).join('');
    } catch (e) {
        feedEl.innerHTML = '<div class="portfolio-notification-placeholder">Error loading trades</div>';
    }
}

// =============================================
// HISTORY TAB
// =============================================

let _historyPage = 0;
const _HISTORY_PAGE_SIZE = 50;

async function renderHistoryTab() {
    const panel = document.getElementById('portfolio-history-panel');
    if (!panel) return;

    _historyPage = 0;
    panel.innerHTML = `
        <div class="pf-history-stats" id="pf-history-stats">
            <div class="pf-history-stat-loading">Loading stats...</div>
        </div>
        <div class="pf-section">
            <div class="pf-section-title">Trade History</div>
            <div class="pf-history-filters" id="pf-history-filters">
                <button class="pf-hist-filter active" data-filter="all" onclick="_filterHistory('all')">All</button>
                <button class="pf-hist-filter" data-filter="BUY" onclick="_filterHistory('BUY')">Buys</button>
                <button class="pf-hist-filter" data-filter="SELL" onclick="_filterHistory('SELL')">Sells</button>
            </div>
            <div id="pf-history-table-wrap">
                <div class="portfolio-notification-placeholder">Loading...</div>
            </div>
        </div>
    `;

    await _loadFullHistory('all');
}

let _allHistoryTrades = [];

async function _loadFullHistory(filter) {
    const wrap = document.getElementById('pf-history-table-wrap');
    const statsEl = document.getElementById('pf-history-stats');
    if (!wrap || !state.currentUser) return;

    try {
        let query = supabaseClient
            .from('trades')
            .select('id, side, quantity, price, total_value, tea_id, index_symbol, trading_mode, created_at')
            .eq('user_id', state.currentUser.id)
            .order('created_at', { ascending: false })
            .limit(500);

        const { data: trades, error } = await query;

        if (error || !trades?.length) {
            wrap.innerHTML = '<div class="pf-empty">No trade history yet.</div>';
            if (statsEl) statsEl.innerHTML = '';
            return;
        }

        _allHistoryTrades = trades;

        const teaMap = {};
        (state.teas || []).forEach(t => { teaMap[t.id] = t; });

        let totalBuys = 0, totalSells = 0, totalVolume = 0, totalValue = 0;
        let winCount = 0, lossCount = 0;
        const symbolVolume = {};

        trades.forEach(t => {
            const val = Number(t.total_value) || (Number(t.quantity) * Number(t.price));
            totalValue += val;
            totalVolume += Number(t.quantity) || 0;
            if (t.side === 'BUY') totalBuys++; else totalSells++;

            const sym = t.index_symbol || teaMap[t.tea_id]?.symbol || '???';
            symbolVolume[sym] = (symbolVolume[sym] || 0) + (Number(t.quantity) || 0);
        });

        const topSymbols = Object.entries(symbolVolume)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);

        if (statsEl) {
            statsEl.innerHTML = `
                <div class="pf-history-stat-grid">
                    <div class="pf-hist-stat">
                        <div class="pf-hist-stat-val">${trades.length}</div>
                        <div class="pf-hist-stat-label">Total Trades</div>
                    </div>
                    <div class="pf-hist-stat">
                        <div class="pf-hist-stat-val" style="color:var(--accent-green)">${totalBuys}</div>
                        <div class="pf-hist-stat-label">Buys</div>
                    </div>
                    <div class="pf-hist-stat">
                        <div class="pf-hist-stat-val" style="color:var(--accent-red)">${totalSells}</div>
                        <div class="pf-hist-stat-label">Sells</div>
                    </div>
                    <div class="pf-hist-stat">
                        <div class="pf-hist-stat-val">${totalVolume >= 1000 ? (totalVolume / 1000).toFixed(1) + 'K' : totalVolume.toLocaleString()}</div>
                        <div class="pf-hist-stat-label">Volume (kg)</div>
                    </div>
                    <div class="pf-hist-stat">
                        <div class="pf-hist-stat-val">$${totalValue >= 10000 ? (totalValue / 1000).toFixed(1) + 'K' : totalValue.toFixed(2)}</div>
                        <div class="pf-hist-stat-label">Total Value</div>
                    </div>
                    <div class="pf-hist-stat">
                        <div class="pf-hist-stat-val">${topSymbols.length > 0 ? topSymbols[0][0] : '\u2014'}</div>
                        <div class="pf-hist-stat-label">Most Traded</div>
                    </div>
                </div>
            `;
        }

        _renderHistoryRows(filter, teaMap);

    } catch (e) {
        wrap.innerHTML = '<div class="pf-empty">Error loading trade history.</div>';
    }
}

function _renderHistoryRows(filter, teaMap) {
    const wrap = document.getElementById('pf-history-table-wrap');
    if (!wrap) return;

    if (!teaMap) {
        teaMap = {};
        (state.teas || []).forEach(t => { teaMap[t.id] = t; });
    }

    const filtered = filter === 'all'
        ? _allHistoryTrades
        : _allHistoryTrades.filter(t => t.side === filter);

    if (filtered.length === 0) {
        wrap.innerHTML = `<div class="pf-empty">No ${filter === 'all' ? '' : filter.toLowerCase() + ' '}trades found.</div>`;
        return;
    }

    const rows = filtered.map(t => {
        const sym = t.index_symbol || teaMap[t.tea_id]?.symbol || '???';
        const isIdx = !!t.index_symbol;
        const isBuy = t.side === 'BUY';
        const qty = Number(t.quantity) || 0;
        const price = Number(t.price) || 0;
        const total = Number(t.total_value) || (qty * price);
        const dt = new Date(t.created_at);
        const dateStr = dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
        const timeStr = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const idxBadge = isIdx ? ' <span class="pf-idx-badge">IDX</span>' : '';
        const modeLabel = t.trading_mode === 'REAL' ? '<span class="pf-mode-real">REAL</span>' : '<span class="pf-mode-virtual">VIRTUAL</span>';

        return `<div class="pf-hist-row">
            <div class="pf-hist-cell pf-hist-side ${isBuy ? 'buy' : 'sell'}">${t.side}</div>
            <div class="pf-hist-cell pf-hist-sym">${escapeHtml(sym)}${idxBadge}</div>
            <div class="pf-hist-cell pf-hist-qty">${qty.toLocaleString()} kg</div>
            <div class="pf-hist-cell pf-hist-price">$${price.toFixed(2)}</div>
            <div class="pf-hist-cell pf-hist-total">$${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            <div class="pf-hist-cell pf-hist-mode">${modeLabel}</div>
            <div class="pf-hist-cell pf-hist-date">${dateStr}</div>
            <div class="pf-hist-cell pf-hist-time">${timeStr}</div>
        </div>`;
    }).join('');

    wrap.innerHTML = `
        <div class="pf-hist-table">
            <div class="pf-hist-header">
                <div>Side</div><div>Symbol</div><div>Quantity</div><div>Price</div><div>Total</div><div>Mode</div><div>Date</div><div>Time</div>
            </div>
            ${rows}
        </div>
        <div class="pf-hist-count">${filtered.length} trade${filtered.length !== 1 ? 's' : ''} shown</div>
    `;
}

function _filterHistory(filter) {
    document.querySelectorAll('.pf-hist-filter').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    _renderHistoryRows(filter);
}

async function renderPortfolioModal() {
    const watchlist = getTraderWatchlist();
    const wlPanel = document.getElementById('portfolio-watchlist-panel');
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
        const retSign = t.returnPct >= 0 ? '+' : '';
        return `
            <div class="portfolio-wl-item" onclick="selectPortfolioTrader('${escapeHtml(t.username)}')" data-username="${escapeHtml(t.username)}">
                <div class="portfolio-wl-avatar">${t.username.slice(0, 2).toUpperCase()}</div>
                <div class="portfolio-wl-info">
                    <div class="portfolio-wl-name">${escapeHtml(t.username)}</div>
                    <div class="portfolio-wl-return ${retClass}" id="wl-return-${escapeHtml(t.username)}">${retSign}${t.returnPct.toFixed(1)}%</div>
                </div>
                <button class="portfolio-wl-unfollow" onclick="event.stopPropagation(); toggleFollowTrader('${escapeHtml(t.username)}', ${t.returnPct}, ${t.totalValue}); renderPortfolioModal();" title="Unfollow">✕</button>
            </div>`;
    }).join('');

    selectPortfolioTrader(watchlist[0].username);

    _refreshWatchlistLiveStats(watchlist);
}

async function _refreshWatchlistLiveStats(watchlist) {
    for (const t of watchlist) {
        const live = await apiFetchTraderProfile(t.username);
        if (!live) continue;
        t.returnPct = live.return_pct || 0;
        t.totalValue = live.total_value || 0;
        saveTraderWatchlist(getTraderWatchlist().map(w =>
            w.username === t.username ? { ...w, returnPct: t.returnPct, totalValue: t.totalValue } : w
        ));
        const retEl = document.getElementById(`wl-return-${t.username}`);
        if (retEl) {
            const retClass = t.returnPct >= 0 ? 'up' : 'down';
            const retSign = t.returnPct >= 0 ? '+' : '';
            retEl.textContent = `${retSign}${t.returnPct.toFixed(1)}%`;
            retEl.className = `portfolio-wl-return ${retClass}`;
        }
    }
}

async function selectPortfolioTrader(username) {
    const statsPanel = document.getElementById('portfolio-stats-panel');
    if (!statsPanel) return;

    document.querySelectorAll('.portfolio-wl-item').forEach(el => el.classList.remove('selected'));
    document.querySelectorAll('.portfolio-wl-item').forEach(el => {
        if (el.querySelector('.portfolio-wl-name')?.textContent === username) {
            el.classList.add('selected');
        }
    });

    const wlEntry = getTraderWatchlist().find(t => t.username === username);
    let returnPct = wlEntry?.returnPct || 0;
    let totalValue = wlEntry?.totalValue || 0;
    const initials = username.slice(0, 2).toUpperCase();
    const followedAt = wlEntry?.followedAt || new Date().toISOString();

    const _renderStats = (rp, tv, notifyOn, targetUserId) => {
        const retClass = rp >= 0 ? 'up' : 'down';
        const retSign = rp >= 0 ? '+' : '';
        const startVal = tv / (1 + rp / 100) || 0;
        const gainLoss = tv - startVal;
        const gainSign = gainLoss >= 0 ? '+' : '';

        const bellSvg = notifyOn
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

        statsPanel.innerHTML = `
            <div class="portfolio-trader-detail">
                <div class="portfolio-trader-header">
                    <div class="portfolio-trader-avatar">${initials}</div>
                    <div style="flex:1;min-width:0;">
                        <div class="portfolio-trader-name">${escapeHtml(username)}</div>
                        <div class="portfolio-trader-since">Following since ${new Date(followedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
                    </div>
                    <button class="notify-toggle-btn ${notifyOn ? 'active' : ''}"
                        id="notify-toggle-btn"
                        title="${notifyOn ? 'Notifications on — click to mute' : 'Notifications off — click to enable'}"
                        onclick="_handleNotifyToggle('${targetUserId || ''}', ${notifyOn})">
                        ${bellSvg}
                    </button>
                </div>
                <div class="portfolio-trader-stats-grid" id="portfolio-trader-live-stats">
                    <div class="portfolio-stat">
                        <div class="portfolio-stat-label">Return</div>
                        <div class="portfolio-stat-value ${retClass}">${retSign}${rp.toFixed(1)}%</div>
                    </div>
                    <div class="portfolio-stat">
                        <div class="portfolio-stat-label">Portfolio Value</div>
                        <div class="portfolio-stat-value">$${tv.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
                    </div>
                    <div class="portfolio-stat">
                        <div class="portfolio-stat-label">P&amp;L</div>
                        <div class="portfolio-stat-value ${gainLoss >= 0 ? 'up' : 'down'}">${gainSign}$${Math.abs(gainLoss).toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
                    </div>
                    <div class="portfolio-stat">
                        <div class="portfolio-stat-label">Starting Capital</div>
                        <div class="portfolio-stat-value">$${startVal.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
                    </div>
                </div>
                <div class="portfolio-activity-section">
                    <div class="portfolio-activity-title">Recent Trades</div>
                    <div id="portfolio-trade-feed" class="portfolio-trade-feed">
                        <div class="portfolio-notification-placeholder">Loading trades...</div>
                    </div>
                </div>
                <button class="trader-profile-follow-btn following" onclick="toggleFollowTrader('${escapeHtml(username)}', ${rp}, ${tv}); renderPortfolioModal();">
                    ★ Unfollow Trader
                </button>
            </div>
        `;
        _loadFollowedTraderTrades(username);
    };

    _renderStats(returnPct, totalValue, false, '');

    const [liveProfile, profileData] = await Promise.all([
        apiFetchTraderProfile(username),
        apiLookupUserByUsername(username)
    ]);

    if (liveProfile) {
        returnPct = liveProfile.return_pct || 0;
        totalValue = liveProfile.total_value || 0;
    }

    let notifyOn = true;
    const targetUserId = profileData?.data?.id || '';
    if (targetUserId && state.currentUser?.id) {
        const follows = await apiFetchMyFollows();
        const followEntry = follows.find(f => f.following_id === targetUserId);
        if (followEntry) notifyOn = followEntry.notify !== false;
    }

    _renderStats(returnPct, totalValue, notifyOn, targetUserId);
}

async function _handleNotifyToggle(targetUserId, currentState) {
    if (!targetUserId) return;
    const newState = await toggleFollowNotify(targetUserId, currentState);
    const btn = document.getElementById('notify-toggle-btn');
    if (btn) {
        btn.className = `notify-toggle-btn ${newState ? 'active' : ''}`;
        btn.title = newState ? 'Notifications on — click to mute' : 'Notifications off — click to enable';
        btn.setAttribute('onclick', `_handleNotifyToggle('${targetUserId}', ${newState})`);
        const bellOn = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
        const bellOff = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
        btn.innerHTML = newState ? bellOn : bellOff;
    }
    showToast(
        newState ? 'Notifications On' : 'Notifications Off',
        newState ? 'You will be notified of their trades' : 'Trade notifications muted'
    );
}

async function _renderTradesIntoFeed(feedElId, username, maxRows = 10) {
    const feedEl = document.getElementById(feedElId);
    if (!feedEl) return;

    try {
        const { data: profile } = await apiLookupUserByUsername(username);
        if (!profile?.id) {
            feedEl.innerHTML = '<div class="portfolio-notification-placeholder">Could not find trader profile</div>';
            return;
        }

        const { data: trades, error } = await supabaseClient
            .from('trades')
            .select('side, quantity, price, tea_id, index_symbol, created_at')
            .eq('user_id', profile.id)
            .order('created_at', { ascending: false })
            .limit(maxRows);

        if (error || !trades?.length) {
            feedEl.innerHTML = '<div class="portfolio-notification-placeholder">No recent activity</div>';
            return;
        }

        const teaMap = {};
        (state.teas || []).forEach(t => { teaMap[t.id] = t.symbol; });

        feedEl.innerHTML = trades.map(t => {
            const sym = t.index_symbol || teaMap[t.tea_id] || '???';
            const isBuy = t.side === 'BUY';
            const ago = _timeAgo(new Date(t.created_at));
            const total = (t.quantity * t.price).toFixed(2);
            return `<div class="portfolio-trade-item">
                <span class="portfolio-trade-side ${isBuy ? 'buy' : 'sell'}">${t.side}</span>
                <span class="portfolio-trade-sym">${sym}</span>
                <span class="portfolio-trade-qty">${Number(t.quantity).toLocaleString()} kg</span>
                <span class="portfolio-trade-price">@ $${Number(t.price).toFixed(2)}</span>
                <span class="portfolio-trade-total">$${Number(total).toLocaleString()}</span>
                <span class="portfolio-trade-time">${ago}</span>
            </div>`;
        }).join('');
    } catch (e) {
        feedEl.innerHTML = '<div class="portfolio-notification-placeholder">Error loading trades</div>';
    }
}

function _loadFollowedTraderTrades(username) {
    _renderTradesIntoFeed('portfolio-trade-feed', username, 5);
}

function _loadTraderProfileTrades(username) {
    _renderTradesIntoFeed('trader-profile-trade-feed', username, 10);
}

async function _fetchTraderSummary(username) {
    try {
        const { data: profile } = await supabaseClient
            .from('profiles').select('id').ilike('username', username).maybeSingle();
        if (!profile?.id) return null;

        const { data: trades, count } = await supabaseClient
            .from('trades')
            .select('tea_id, index_symbol', { count: 'exact', head: false })
            .eq('user_id', profile.id)
            .limit(500);

        const teaMap = {};
        (state.teas || []).forEach(t => { teaMap[t.id] = t.symbol; });

        const freq = {};
        (trades || []).forEach(t => {
            const sym = t.index_symbol || teaMap[t.tea_id] || null;
            if (sym) freq[sym] = (freq[sym] || 0) + 1;
        });

        const topAsset = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        return { count: count ?? (trades || []).length, topAsset };
    } catch (_) {
        return null;
    }
}

function _timeAgo(date) {
    const s = Math.floor((Date.now() - date.getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

// =============================================
// BADGES TAB (Trophy Cabinet)
// =============================================

function _getUserBadges() {
    const raw = state.userProfile?.badges;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return []; } }
    return [];
}

function _getTopBadges(badgesArr, limit = 2) {
    if (!badgesArr || !badgesArr.length) return [];
    return BADGE_PRIORITY.filter(id => badgesArr.includes(id)).slice(0, limit);
}

function renderBadgesTab() {
    const panel = document.getElementById('badges-panel');
    if (!panel) return;

    const earned = _getUserBadges();
    const earnedCount = Object.keys(BADGE_DEFINITIONS).filter(id => earned.includes(id)).length;
    const totalCount = Object.keys(BADGE_DEFINITIONS).length;
    const currentShowcase = state.userProfile?.showcase_badge || null;

    const categories = {};
    for (const [id, def] of Object.entries(BADGE_DEFINITIONS)) {
        if (!categories[def.cat]) categories[def.cat] = [];
        categories[def.cat].push({ id, ...def, unlocked: earned.includes(id) });
    }

    let html = `<div class="badges-cabinet">
        <div class="badges-header">
            <div class="badges-header-title">Trophy Cabinet</div>
            <div class="badges-header-count">${earnedCount} / ${totalCount} unlocked</div>
        </div>`;

    if (earnedCount > 0) {
        const showcaseDef = currentShowcase && BADGE_DEFINITIONS[currentShowcase];
        const showcaseLabel = showcaseDef ? showcaseDef.name : 'Auto (Top Badge)';
        html += `<div class="badges-showcase-bar">
            <span class="showcase-label">Profile Avatar:</span>
            <span class="showcase-current">${showcaseDef ? `<span class="badge-icon-inline" style="background:${showcaseDef.bg};color:${showcaseDef.color}">${showcaseDef.svg}</span>` : ''} ${showcaseLabel}</span>
            <span class="showcase-hint">Click an unlocked badge to showcase it</span>
        </div>`;
    }

    for (const [cat, badges] of Object.entries(categories)) {
        const catLabel = cat === 'Respect' ? 'Respect Badges (Performance)'
            : cat === 'Whale' ? 'Whale Badges (Volume)'
                : cat === 'Lore' ? 'Lore Badges (Redemption)'
                    : 'Status Badges (Monetization)';

        html += `<div class="badges-category">
            <div class="badges-category-label">${catLabel}</div>
            <div class="badges-grid">`;

        for (const b of badges) {
            const isShowcase = currentShowcase === b.id;
            html += `
                <div class="badge-card ${b.unlocked ? 'unlocked' : 'locked'}${isShowcase ? ' showcase' : ''}" style="${b.unlocked ? `--badge-color:${b.color};--badge-glow:${b.bg};background:${b.bg}` : ''}" ${b.unlocked ? `onclick="setShowcaseBadge('${b.id}')"` : ''}>
                    ${isShowcase ? '<div class="badge-showcase-tag">SHOWCASE</div>' : ''}
                    <div class="badge-card-icon" style="background:${b.bg};color:${b.color}">${b.svg}</div>
                    <div class="badge-card-name">${b.name}</div>
                    <div class="badge-card-desc">${b.unlocked ? b.desc : b.unlock}</div>
                </div>`;
        }

        html += `</div></div>`;
    }

    html += `</div>`;
    panel.innerHTML = html;
}

async function setShowcaseBadge(badgeId) {
    if (!state.userId) return;
    const current = state.userProfile?.showcase_badge;
    const newVal = (current === badgeId) ? null : badgeId;
    try {
        await supabaseClient.from('profiles').update({ showcase_badge: newVal }).eq('id', state.userId);
        if (state.userProfile) state.userProfile.showcase_badge = newVal;
        renderBadgesTab();
        const def = newVal ? BADGE_DEFINITIONS[newVal] : null;
        showToast(def ? `${def.name} set as your profile badge` : 'Showcase badge cleared', 'success');
    } catch (e) {
        showToast('Could not update showcase badge', 'error');
    }
}

function renderBadgeCabinet(badgesArr, containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;

    if (!badgesArr || badgesArr.length === 0) {
        el.innerHTML = '<div class="badges-empty">No badges earned yet</div>';
        return;
    }

    el.innerHTML = badgesArr.map(id => {
        const def = BADGE_DEFINITIONS[id];
        if (!def) return '';
        return `<span class="badge-icon-inline" style="background:${def.bg};color:${def.color}" title="${def.name}: ${def.desc}"><span class="badge-tooltip">${def.name}<span class="badge-tooltip-desc">${def.desc}</span></span>${def.svg}</span>`;
    }).join('');
}

// =============================================
// STORE TAB (Monetization)
// =============================================

function renderStoreTab() {
    const panel = document.getElementById('store-panel');
    if (!panel) return;

    const tier = state.userProfile?.tier || 'FREE';
    const isPro = tier === 'PRO';
    const acctStatus = state.userProfile?.account_status || 'ACTIVE';
    const inEval = acctStatus === 'EVALUATION';
    const isFunded = acctStatus === 'FUNDED';

    panel.innerHTML = `
        <div class="funded-account-card store-card">
            <span class="store-card-icon">${isFunded ? '&#127942;' : '&#9876;&#65039;'}</span>
            <div class="store-card-title">${isFunded ? 'Funded Simulated Account' : inEval ? 'Evaluation In Progress' : 'Trading Evaluation Challenge'}</div>
            <div class="store-card-desc">
                ${isFunded
            ? 'You passed the evaluation! Trade with simulated capital and claim 80% performance rewards every 14 days.'
            : inEval
                ? 'Your evaluation is active. Meet the 8% profit target with 5+ trading days and consistent performance to earn a funded simulated account.'
                : 'Purchase an evaluation challenge. Prove your trading skill with simulated capital. Pass the evaluation to earn a funded simulated account with 80/20 performance reward splits.'}
            </div>
            <div class="store-card-details">
                <div class="store-detail-row"><span>Max Daily Loss</span><span>5% of starting equity</span></div>
                <div class="store-detail-row"><span>Max Total Loss</span><span>10% of initial balance</span></div>
                <div class="store-detail-row"><span>Profit Target (Eval)</span><span>8%</span></div>
                <div class="store-detail-row"><span>Min Trading Days</span><span>5 days</span></div>
                <div class="store-detail-row"><span>Consistency Rule</span><span>No single day &gt; 50% of profit</span></div>
                <div class="store-detail-row"><span>Max Leverage</span><span>1:30</span></div>
                <div class="store-detail-row"><span>Performance Reward</span><span>80% trader / 20% platform</span></div>
                <div class="store-detail-row"><span>Reward Cycle</span><span>Every 14 days</span></div>
            </div>
            <button class="store-card-btn" onclick="purchaseEvaluation()" ${(inEval || isFunded) ? 'disabled' : ''}>
                ${isFunded ? 'Account Active' : inEval ? 'Evaluation In Progress' : 'Purchase Evaluation Challenge'}
            </button>
            <p class="store-card-legal">All trading is conducted with simulated capital. Challenge fees are non-refundable software subscription fees.</p>
        </div>

        ${isFunded ? `
        <div class="payout-card store-card">
            <span class="store-card-icon">&#128176;</span>
            <div class="store-card-title">Claim Performance Reward</div>
            <div class="store-card-desc">
                Request your 80% performance reward. You must have a flat book (no open positions), be profitable, have 5+ trading days, and meet the consistency rule.
            </div>
            <button class="store-card-btn" onclick="requestPayout()">Claim Performance Reward</button>
            <p class="store-card-legal">Performance rewards are independent contractor payments for generating successful simulated trading data, not withdrawals of financial market profits.</p>
        </div>
        ` : ''}

        <div id="funded-dashboard-panel"></div>

        <div class="pro-upgrade-card store-card">
            <span class="store-card-icon">&#11088;</span>
            <div class="store-card-title">${isPro ? 'TeaTrade PRO (Active)' : 'TeaTrade PRO'}</div>
            <div class="store-card-desc">
                ${isPro
            ? 'You have PRO access. Copy the Top 5 traders, auto-copy mode, premium indicators, and gold chat badge.'
            : 'Follow and auto-copy the Top 5 leaderboard traders. Premium chart indicators and a gold username in chat.'}
            </div>
            <button class="store-card-btn" onclick="purchaseProSubscription()" ${isPro ? 'disabled' : ''}>
                ${isPro ? 'Already PRO' : 'Upgrade to PRO &mdash; &pound;14.99/mo'}
            </button>
        </div>

        <div class="simulated-env-notice">
            <strong>&#9888;&#65039; Simulated Trading Environment</strong><br>
            All trading on TeaTrade Exchange is conducted with simulated capital. No real money is traded or at risk.
        </div>
    `;

    // Load funded account dashboard if applicable
    if (inEval || isFunded) {
        loadFundedDashboard();
    }
}

// =============================================
// FUNDED ACCOUNT DASHBOARD
// =============================================

async function loadFundedDashboard() {
    const panel = document.getElementById('funded-dashboard-panel');
    if (!panel) return;

    try {
        const { data, error } = await apiFetchFundedAccountStatus();
        if (error || !data?.has_account) {
            panel.innerHTML = '';
            return;
        }

        const d = data;
        const isFunded = d.account_status === 'funded';
        const isEval = d.account_status === 'evaluation';
        const isLiquidated = d.account_status === 'liquidated';

        const dailyPct = Math.max(0, d.daily_loss_pct || 0);
        const totalPct = Math.max(0, d.total_loss_pct || 0);
        const profitPct = d.profit_pct || 0;
        const consistencyPct = d.consistency_pct || 0;

        const fmt = (v) => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        panel.innerHTML = `
            <div class="funded-dashboard store-card">
                <div class="funded-dash-header">
                    <span class="funded-dash-status ${d.account_status}">${isEval ? 'EVALUATION' : isFunded ? 'FUNDED' : 'LIQUIDATED'}</span>
                    <span class="funded-dash-label">Simulated Account</span>
                </div>
                <div class="funded-dash-grid">
                    <div class="funded-dash-stat">
                        <div class="funded-dash-stat-value">${fmt(d.floating_equity)}</div>
                        <div class="funded-dash-stat-label">Floating Equity</div>
                    </div>
                    <div class="funded-dash-stat">
                        <div class="funded-dash-stat-value">${fmt(d.initial_balance)}</div>
                        <div class="funded-dash-stat-label">Initial Balance</div>
                    </div>
                    <div class="funded-dash-stat">
                        <div class="funded-dash-stat-value ${profitPct >= 0 ? 'positive' : 'negative'}">${profitPct >= 0 ? '+' : ''}${profitPct}%</div>
                        <div class="funded-dash-stat-label">Profit</div>
                    </div>
                    <div class="funded-dash-stat">
                        <div class="funded-dash-stat-value">${d.active_trading_days} / 4</div>
                        <div class="funded-dash-stat-label">Trading Days</div>
                    </div>
                </div>
                <div class="funded-dash-rules">
                    <div class="funded-rule ${dailyPct >= 5 ? 'breached' : dailyPct >= 3.5 ? 'warning' : 'safe'}">
                        <span>Daily Loss</span>
                        <span>${dailyPct.toFixed(2)}% / 5.00%</span>
                        <div class="funded-rule-bar"><div class="funded-rule-fill" style="width:${Math.min(100, (dailyPct / 5) * 100)}%"></div></div>
                    </div>
                    <div class="funded-rule ${totalPct >= 10 ? 'breached' : totalPct >= 7 ? 'warning' : 'safe'}">
                        <span>Total Loss</span>
                        <span>${totalPct.toFixed(2)}% / 10.00%</span>
                        <div class="funded-rule-bar"><div class="funded-rule-fill" style="width:${Math.min(100, (totalPct / 10) * 100)}%"></div></div>
                    </div>
                    <div class="funded-rule ${consistencyPct > 50 ? 'breached' : consistencyPct > 35 ? 'warning' : 'safe'}">
                        <span>Consistency</span>
                        <span>Best day: ${consistencyPct.toFixed(1)}% of profit (max 50%)</span>
                    </div>
                </div>
                ${isFunded ? `
                <div class="funded-dash-payout-info">
                    <div>Next reward eligible: <strong>${d.next_payout_eligible ? new Date(d.next_payout_eligible).toLocaleDateString('en-GB') : 'N/A'}</strong></div>
                    <div>Open positions: <strong>${d.open_positions}</strong></div>
                    <div>Can claim reward: <strong>${d.can_request_payout ? 'Yes ✓' : 'Not yet'}</strong></div>
                </div>
                ` : ''}
                ${isEval ? `
                <div class="funded-dash-eval-info">
                    <div>Profit target: <strong>8% (${fmt(d.initial_balance * 1.08)})</strong></div>
                    <div>Current: <strong>${fmt(d.floating_equity)} (${profitPct}%)</strong></div>
                </div>
                ` : ''}
            </div>
        `;

        // Check for liquidation and show modal
        if (isLiquidated && d.liquidation_details) {
            showLiquidationModal(d.liquidation_details);
        }
    } catch (err) {
        console.error('Funded dashboard error:', err);
        panel.innerHTML = '';
    }
}

// =============================================
// PAYOUT REQUEST
// =============================================

async function requestPayout() {
    if (!state.currentUser) {
        showToast('Error', 'Please log in first.', true);
        return;
    }

    if (!confirm('Claim Performance Reward?\n\nThis will:\n• Calculate your 80% performance reward\n• Reset your balance to the initial amount\n• Reset your trading day count\n\nAll positions must be closed.')) {
        return;
    }

    try {
        const { data, error } = await apiRequestRewardPayout();
        if (error) {
            showToast('Reward Claim Failed', error.message, true);
            return;
        }

        showToast('Performance Reward Claimed!',
            `Reward: $${Number(data.payout_amount).toFixed(2)} (80% of $${Number(data.gross_profit).toFixed(2)} profit). Balance reset to $${Number(data.new_balance).toFixed(2)}.`);

        await loadUserProfile();
        renderStoreTab();
    } catch (err) {
        showToast('Error', 'Failed to claim performance reward. Please try again.', true);
    }
}

// =============================================
// PAYOUTS TAB (KYC + Stripe Connect + History)
// =============================================

async function renderPayoutsTab() {
    const panel = document.getElementById('payouts-panel');
    if (!panel) return;

    panel.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);">Loading payout information...</div>';

    if (!state.currentUser) {
        panel.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);">Please log in to view payouts.</div>';
        return;
    }

    try {
        const { data, error } = await supabaseClient.rpc('get_kyc_payout_status', {
            p_user_id: state.currentUser.id,
        });

        if (error) throw error;

        const kycStatus = data?.kyc_status || 'none';
        const hasConnect = data?.has_connect_account || false;
        const acctStatus = data?.account_status || 'ACTIVE';
        const isFunded = acctStatus === 'FUNDED';
        const totalPaidPence = data?.total_paid_pence || 0;
        const payouts = data?.payout_requests || [];

        const kycBadge = _getKycBadge(kycStatus);
        const fmtGBP = (pence) => '£' + (pence / 100).toFixed(2);

        let html = `
            <div class="payouts-header">
                <div class="payouts-header-title">
                    <span class="store-card-icon" style="font-size:28px;">&#128179;</span>
                    <div>
                        <div style="font-size:18px;font-weight:700;color:var(--text-primary);">Performance Rewards & Payouts</div>
                        <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">Complete verification to receive your trading performance rewards</div>
                    </div>
                </div>
            </div>

            <!-- KYC Status Card -->
            <div class="store-card" style="margin-top:16px;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
                    <div style="display:flex;align-items:center;gap:12px;">
                        <span style="font-size:24px;">&#128100;</span>
                        <div>
                            <div style="font-weight:700;color:var(--text-primary);">Identity Verification (KYC)</div>
                            <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">Required before any payout can be processed</div>
                        </div>
                    </div>
                    ${kycBadge}
                </div>
                <div class="store-card-details">
                    <div class="store-detail-row"><span>ID Verification</span><span>${kycStatus === 'verified' ? '✓ Passed' : kycStatus === 'pending' ? '⏳ In Review' : kycStatus === 'requires_info' ? '⚠️ Info Needed' : '○ Not Started'}</span></div>
                    <div class="store-detail-row"><span>Bank Details</span><span>${kycStatus === 'verified' ? '✓ Connected' : '○ Added via Stripe'}</span></div>
                    <div class="store-detail-row"><span>Tax Information</span><span>${kycStatus === 'verified' ? '✓ Submitted' : '○ Collected by Stripe'}</span></div>
                </div>
                ${kycStatus === 'none' ? `
                    <button class="store-card-btn" onclick="startKycOnboarding()" ${!isFunded ? 'disabled title="Complete your evaluation to unlock verification"' : ''}>
                        ${isFunded ? 'Start Verification →' : 'Complete Evaluation First'}
                    </button>
                    <p class="store-card-legal">Stripe handles identity verification securely. We never see your ID documents or bank details.</p>
                ` : kycStatus === 'requires_info' ? `
                    <button class="store-card-btn" onclick="startKycOnboarding()">Complete Verification →</button>
                    <p class="store-card-legal">Additional information is required. Click above to continue on Stripe's secure platform.</p>
                ` : kycStatus === 'pending' ? `
                    <div style="text-align:center;padding:12px;background:rgba(234,179,8,0.1);border:1px solid rgba(234,179,8,0.3);border-radius:8px;margin-top:12px;">
                        <span style="color:#eab308;font-weight:600;">⏳ Verification in review</span>
                        <div style="font-size:11px;color:var(--text-secondary);margin-top:4px;">This typically takes a few minutes. Refresh to check status.</div>
                    </div>
                ` : kycStatus === 'rejected' ? `
                    <div style="text-align:center;padding:12px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;margin-top:12px;">
                        <span style="color:#ef4444;font-weight:600;">✗ Verification failed</span>
                        <div style="font-size:11px;color:var(--text-secondary);margin-top:4px;">Please contact support at contact@teatrade.co.uk for assistance.</div>
                    </div>
                ` : `
                    <div style="text-align:center;padding:12px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);border-radius:8px;margin-top:12px;">
                        <span style="color:#10b981;font-weight:600;">✓ Verified — ready to receive payouts</span>
                    </div>
                `}
            </div>

            <!-- Payout Summary Card -->
            <div class="store-card" style="margin-top:16px;">
                <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
                    <span style="font-size:24px;">&#128176;</span>
                    <div>
                        <div style="font-weight:700;color:var(--text-primary);">Claim Performance Reward</div>
                        <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">80% trader / 20% platform split</div>
                    </div>
                </div>
                <div class="store-card-details">
                    <div class="store-detail-row"><span>Total Paid Out</span><span style="font-weight:700;color:var(--accent-green);">${fmtGBP(totalPaidPence)}</span></div>
                    <div class="store-detail-row"><span>Reward Split</span><span>80% to you</span></div>
                    <div class="store-detail-row"><span>Payout Method</span><span>Direct to your bank via Stripe</span></div>
                    <div class="store-detail-row"><span>Processing Time</span><span>1-3 business days</span></div>
                </div>
                <button class="store-card-btn" onclick="requestPayoutWithKyc()" ${!(isFunded && kycStatus === 'verified') ? 'disabled' : ''}>
                    ${!isFunded ? 'Account Not Funded' : kycStatus !== 'verified' ? 'Complete Verification First' : 'Claim Performance Reward'}
                </button>
                <p class="store-card-legal">Performance rewards are independent contractor payments for generating successful simulated trading data. Not withdrawals of financial market profits.</p>
            </div>
        `;

        // Payout History
        if (payouts.length > 0) {
            html += `
                <div class="store-card" style="margin-top:16px;">
                    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
                        <span style="font-size:24px;">&#128203;</span>
                        <div style="font-weight:700;color:var(--text-primary);">Payout History</div>
                    </div>
                    <table style="width:100%;border-collapse:collapse;font-size:12px;">
                        <thead>
                            <tr style="border-bottom:1px solid var(--border);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;">
                                <th style="padding:8px 4px;text-align:left;">Date</th>
                                <th style="padding:8px 4px;text-align:right;">Amount</th>
                                <th style="padding:8px 4px;text-align:center;">Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${payouts.map(p => `
                                <tr style="border-bottom:1px solid var(--border);">
                                    <td style="padding:8px 4px;color:var(--text-secondary);">${new Date(p.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                                    <td style="padding:8px 4px;text-align:right;font-family:'JetBrains Mono',monospace;font-weight:600;color:var(--text-primary);">${fmtGBP(p.amount_pence)}</td>
                                    <td style="padding:8px 4px;text-align:center;">${_getPayoutStatusBadge(p.status)}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }

        html += `
            <div class="simulated-env-notice" style="margin-top:16px;">
                <strong>&#9888;&#65039; How Payouts Work</strong><br>
                1. Pass the evaluation challenge to earn a funded simulated account<br>
                2. Complete identity verification (KYC) via Stripe<br>
                3. Trade profitably for 14+ days meeting all rules<br>
                4. Claim your 80% performance reward — paid directly to your bank
            </div>
        `;

        panel.innerHTML = html;

    } catch (err) {
        console.error('Payouts tab error:', err);
        panel.innerHTML = '<div style="text-align:center;padding:40px;color:var(--accent-red);">Failed to load payout information. Please try again.</div>';
    }
}

function _getKycBadge(status) {
    const badges = {
        none: '<span style="display:inline-block;padding:4px 10px;border-radius:12px;font-size:11px;font-weight:600;background:rgba(100,116,139,0.15);color:#94a3b8;">Not Started</span>',
        pending: '<span style="display:inline-block;padding:4px 10px;border-radius:12px;font-size:11px;font-weight:600;background:rgba(234,179,8,0.15);color:#eab308;">In Review</span>',
        requires_info: '<span style="display:inline-block;padding:4px 10px;border-radius:12px;font-size:11px;font-weight:600;background:rgba(249,115,22,0.15);color:#f97316;">Info Needed</span>',
        verified: '<span style="display:inline-block;padding:4px 10px;border-radius:12px;font-size:11px;font-weight:600;background:rgba(16,185,129,0.15);color:#10b981;">Verified ✓</span>',
        rejected: '<span style="display:inline-block;padding:4px 10px;border-radius:12px;font-size:11px;font-weight:600;background:rgba(239,68,68,0.15);color:#ef4444;">Rejected</span>',
    };
    return badges[status] || badges.none;
}

function _getPayoutStatusBadge(status) {
    const badges = {
        pending: '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(234,179,8,0.15);color:#eab308;">Pending</span>',
        approved: '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(59,130,246,0.15);color:#3b82f6;">Approved</span>',
        processing: '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(59,130,246,0.15);color:#3b82f6;">Processing</span>',
        completed: '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(16,185,129,0.15);color:#10b981;">Paid ✓</span>',
        rejected: '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(239,68,68,0.15);color:#ef4444;">Rejected</span>',
        failed: '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(239,68,68,0.15);color:#ef4444;">Failed</span>',
    };
    return badges[status] || badges.pending;
}

// ── KYC Onboarding (redirects to Stripe hosted page) ──

async function startKycOnboarding() {
    if (!state.currentUser) {
        showToast('Error', 'Please log in first.', true);
        return;
    }

    showToast('Setting up verification...', 'Redirecting to Stripe for secure identity verification.');

    try {
        const result = await _invokeEdgeFunction('create-connect-account', {});

        if (result?.url) {
            window.location.href = result.url;
        } else {
            const errMsg = result?.error || 'Failed to create verification session';
            showToast('Verification Error', errMsg, true);
        }
    } catch (err) {
        console.error('KYC onboarding error:', err);
        showToast('Error', 'Failed to start verification. Please try again.', true);
    }
}

// ── Payout with KYC check ──

async function requestPayoutWithKyc() {
    if (!state.currentUser) {
        showToast('Error', 'Please log in first.', true);
        return;
    }

    if (!confirm('Claim Performance Reward?\n\nThis will:\n• Calculate your 80% performance reward\n• Transfer funds to your verified bank account\n• Reset your balance to the initial amount\n• Reset your trading day count\n\nAll positions must be closed.')) {
        return;
    }

    try {
        showToast('Processing...', 'Calculating and transferring your performance reward.');

        const result = await _invokeEdgeFunction('request-payout', {});

        if (result?.success) {
            showToast('Reward Paid! 🎉',
                `£${result.payout_amount} transferred to your bank account (${result.trader_share} of £${result.gross_profit} profit).`);
            await loadUserProfile();
            renderPayoutsTab();
        } else {
            const errMsg = result?.error || 'Payout request failed';
            showToast('Payout Failed', errMsg, true);
        }
    } catch (err) {
        console.error('Payout request error:', err);
        showToast('Error', 'Failed to process payout. Please try again.', true);
    }
}

// ── Handle Connect return/refresh from Stripe onboarding ──

function handleConnectReturn() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('connect_return') === '1') {
        showToast('Verification Submitted', 'Your identity verification has been submitted. We\'ll update your status shortly.');
        window.history.replaceState({}, '', window.location.pathname);
        // Open payouts tab to show updated status
        setTimeout(() => {
            if (typeof openPortfolioModal === 'function') {
                openPortfolioModal();
                switchPortfolioModalTab('payouts');
            }
        }, 500);
    }
    if (params.get('connect_refresh') === '1') {
        showToast('Verification Incomplete', 'Please complete the verification process to enable payouts.', true);
        window.history.replaceState({}, '', window.location.pathname);
        setTimeout(() => {
            if (typeof openPortfolioModal === 'function') {
                openPortfolioModal();
                switchPortfolioModalTab('payouts');
            }
        }, 500);
    }
}

// =============================================
// PURCHASE EVALUATION
// =============================================

async function purchaseEvaluation(tier) {
    if (!state.currentUser) {
        window.location.href = 'login.html' + (tier ? '?tier=' + tier : '');
        return;
    }
    // Map tier to Stripe product key and balance
    const tiers = {
        '10K': { product: 'EVAL_10K', balance: 10000 },
        '25K': { product: 'EVAL_25K', balance: 25000 },
        '50K': { product: 'EVAL_50K', balance: 50000 },
    };
    const selected = tiers[tier] || tiers['10K'];
    // Redirect to Stripe checkout for evaluation entry
    try {
        const result = await _invokeEdgeFunction('stripe-checkout', {
            product: selected.product,
            initial_balance: selected.balance,
        });
        if (result?.url) {
            window.location.href = result.url;
        } else {
            const errMsg = result?.error || 'No checkout URL returned';
            console.error('Checkout error:', errMsg, result);
            showToast('Error', 'Failed to start checkout: ' + errMsg, true);
        }
    } catch (err) {
        console.error('Checkout exception:', err);
        showToast('Error', 'Failed to start checkout. Please try again.', true);
    }
}

// =============================================
// LIQUIDATION MODAL
// =============================================

function showLiquidationModal(details) {
    // Remove any existing modal
    const existing = document.getElementById('liquidation-modal');
    if (existing) existing.remove();

    let reason = 'Unknown';
    let detailsHtml = '';

    if (details) {
        if (details.midnight_equity !== undefined) {
            reason = 'Maximum Daily Loss Breach (5%)';
            detailsHtml = `
                <div class="liq-detail"><span>Midnight Equity:</span><span>$${Number(details.midnight_equity).toFixed(2)}</span></div>
                <div class="liq-detail"><span>Floating Equity at Breach:</span><span>$${Number(details.floating_equity).toFixed(2)}</span></div>
                <div class="liq-detail"><span>Daily Loss Floor (95%):</span><span>$${Number(details.daily_floor).toFixed(2)}</span></div>
                <div class="liq-detail"><span>Loss Percentage:</span><span>${details.loss_pct}%</span></div>
                <div class="liq-detail"><span>Timestamp:</span><span>${new Date(details.timestamp).toLocaleString('en-GB')}</span></div>
            `;
        } else if (details.initial_balance !== undefined) {
            reason = 'Maximum Total Loss Breach (10%)';
            detailsHtml = `
                <div class="liq-detail"><span>Initial Balance:</span><span>$${Number(details.initial_balance).toFixed(2)}</span></div>
                <div class="liq-detail"><span>Floating Equity at Breach:</span><span>$${Number(details.floating_equity).toFixed(2)}</span></div>
                <div class="liq-detail"><span>Total Loss Floor (90%):</span><span>$${Number(details.total_floor).toFixed(2)}</span></div>
                <div class="liq-detail"><span>Loss Percentage:</span><span>${details.loss_pct}%</span></div>
                <div class="liq-detail"><span>Timestamp:</span><span>${new Date(details.timestamp).toLocaleString('en-GB')}</span></div>
            `;
        }
    }

    const modal = document.createElement('div');
    modal.id = 'liquidation-modal';
    modal.className = 'liquidation-modal-overlay';
    modal.innerHTML = `
        <div class="liquidation-modal">
            <div class="liquidation-modal-header">
                <span class="liquidation-icon">&#9888;&#65039;</span>
                <h2>Account Liquidated</h2>
            </div>
            <div class="liquidation-modal-body">
                <p class="liquidation-reason"><strong>Reason:</strong> ${reason}</p>
                <div class="liquidation-details">${detailsHtml}</div>
                <p class="liquidation-explanation">
                    Your evaluation/funded simulated account was liquidated because a risk limit was breached.
                    All open positions were force-closed at market prices. This is an automated system action
                    to protect against excessive drawdown.
                </p>
                <div class="liquidation-audit-link">
                    <button class="store-card-btn" onclick="showFullAuditLog()">View Full Audit Log</button>
                </div>
                <p class="liquidation-next-steps">
                    You may purchase a new evaluation challenge to try again. Your previous trading history
                    and audit logs are permanently retained for transparency.
                </p>
                <div class="simulated-env-notice" style="margin-top:12px;">
                    <strong>Simulated Trading Environment</strong> — No real money was lost.
                </div>
            </div>
            <button class="liquidation-close-btn" onclick="closeLiquidationModal()">Acknowledge &amp; Continue</button>
        </div>
    `;
    document.body.appendChild(modal);
}

function closeLiquidationModal() {
    const modal = document.getElementById('liquidation-modal');
    if (modal) modal.remove();
}

async function showFullAuditLog() {
    try {
        const { data, error } = await apiFetchLiquidationAudit();
        if (error) { showToast('Error', 'Failed to load audit log', true); return; }

        const logs = Array.isArray(data) ? data : [];
        let html = '<div class="audit-log-list">';
        for (const log of logs) {
            html += `
                <div class="audit-log-entry">
                    <div class="audit-log-time">${new Date(log.timestamp).toLocaleString('en-GB')}</div>
                    <div class="audit-log-type">${log.event_type.replace(/_/g, ' ').toUpperCase()}</div>
                    <div class="audit-log-details"><pre>${JSON.stringify(log.details, null, 2)}</pre></div>
                </div>
            `;
        }
        html += '</div>';

        const modal = document.getElementById('liquidation-modal');
        if (modal) {
            const body = modal.querySelector('.liquidation-modal-body');
            if (body) body.innerHTML = html;
        }
    } catch (err) {
        showToast('Error', 'Failed to load audit log', true);
    }
}

// =============================================
// COMBINE BANNER UPDATE
// =============================================

async function updateCombineBanner() {
    const banner = document.getElementById('combine-banner');
    if (!banner) return;

    const acctStatus = state.userProfile?.account_status;

    // Handle funded/evaluation account banner
    if (acctStatus === 'EVALUATION' || acctStatus === 'FUNDED') {
        try {
            const { data } = await apiFetchFundedAccountStatus();
            if (!data?.has_account || data.account_status === 'liquidated') {
                banner.classList.remove('active');
                if (data?.account_status === 'liquidated' && data.liquidation_details) {
                    showLiquidationModal(data.liquidation_details);
                }
                return;
            }

            const fmt = (v) => '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
            const labelEl = banner.querySelector('.combine-banner-label');
            const eqEl = document.getElementById('combine-equity');
            const tgEl = document.getElementById('combine-target');
            const ddEl = document.getElementById('combine-dd-floor');
            const dayEl = document.getElementById('combine-days');

            if (labelEl) labelEl.textContent = data.account_status === 'funded' ? 'FUNDED ACCOUNT' : 'EVALUATION ACTIVE';
            if (eqEl) eqEl.textContent = fmt(data.floating_equity);
            if (tgEl) {
                tgEl.textContent = data.account_status === 'evaluation'
                    ? fmt(data.initial_balance * 1.08)
                    : fmt(data.profit || 0);
                const tgLabel = tgEl.nextElementSibling;
                if (tgLabel) tgLabel.textContent = data.account_status === 'evaluation' ? 'Target (8%)' : 'Profit';
            }
            if (ddEl) ddEl.textContent = fmt(data.daily_floor);
            if (dayEl) {
                dayEl.textContent = data.active_trading_days + '/4';
                const dayLabel = dayEl.nextElementSibling;
                if (dayLabel) dayLabel.textContent = 'Trade Days';
            }

            banner.classList.add('active');
        } catch (_) {
            banner.classList.remove('active');
        }
        return;
    }

    // Legacy combine challenge banner
    if (acctStatus !== 'COMBINE') {
        banner.classList.remove('active');
        return;
    }

    try {
        const { data } = await apiFetchCombineRules();
        if (!data?.active) {
            banner.classList.remove('active');
            if (data?.result === 'PASSED') {
                showToast('COMBINE PASSED!', 'Congratulations! You earned the Funded Trader badge!');
            } else if (data?.result === 'FAILED') {
                showToast('Combine Failed', 'Your challenge ended due to ' + (data.reason === 'daily_drawdown' ? 'daily drawdown breach' : 'expiry') + '. Account reset to $10,000.', true);
            } else if (data?.result === 'EXPIRED') {
                showToast('Combine Expired', 'Your 30-day challenge period ended. Account reset to $10,000.', true);
            }
            if (data?.result) {
                await loadUserProfile();
                updatePortfolioDisplay();
                updateUIForLoggedInUser();
            }
            return;
        }

        const fmt = (v) => '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });

        const eqEl = document.getElementById('combine-equity');
        const tgEl = document.getElementById('combine-target');
        const ddEl = document.getElementById('combine-dd-floor');
        const dayEl = document.getElementById('combine-days');

        if (eqEl) eqEl.textContent = fmt(data.equity);
        if (tgEl) tgEl.textContent = fmt(data.target);
        if (ddEl) ddEl.textContent = fmt(data.dd_floor);
        if (dayEl) dayEl.textContent = Math.max(0, Math.floor(data.days_remaining));

        banner.classList.add('active');
    } catch (_) {
        banner.classList.remove('active');
    }
}

// =============================================
// BADGE NOTIFICATION + SHARE SYSTEM
// =============================================

const _BADGE_NOTIFY_KEY = 'teatrade_known_badges';

function _getKnownBadges() {
    try { return JSON.parse(localStorage.getItem(_BADGE_NOTIFY_KEY) || '[]'); } catch { return []; }
}

function _setKnownBadges(badges) {
    try { localStorage.setItem(_BADGE_NOTIFY_KEY, JSON.stringify(badges)); } catch { }
}

async function checkAndNotifyNewBadges() {
    if (!state.currentUser) return;
    try {
        const { data, error } = await supabaseClient.rpc('evaluate_badges', { p_user_id: state.currentUser.id });
        if (error) { console.warn('Badge eval error:', error); return; }

        const serverBadges = data?.badges;
        if (!Array.isArray(serverBadges)) return;

        const known = _getKnownBadges();
        const newBadges = serverBadges.filter(id => !known.includes(id));

        if (newBadges.length > 0) {
            state.userProfile = { ...state.userProfile, badges: serverBadges };
            _setKnownBadges(serverBadges);
            _queueBadgeNotifications(newBadges);
        } else {
            _setKnownBadges(serverBadges);
        }
    } catch (e) { console.warn('Badge check failed:', e); }
}

function syncKnownBadgesFromProfile() {
    const current = _getUserBadges();
    if (current.length > 0) _setKnownBadges(current);
}

let _badgeNotifyQueue = [];
let _badgeNotifyActive = false;

function _queueBadgeNotifications(badgeIds) {
    _badgeNotifyQueue.push(...badgeIds);
    if (!_badgeNotifyActive) _showNextBadgeNotification();
}

function _showNextBadgeNotification() {
    if (_badgeNotifyQueue.length === 0) { _badgeNotifyActive = false; return; }
    _badgeNotifyActive = true;
    const badgeId = _badgeNotifyQueue.shift();
    _showBadgeCelebration(badgeId);
}

function _showBadgeCelebration(badgeId) {
    const def = BADGE_DEFINITIONS[badgeId];
    if (!def) { _showNextBadgeNotification(); return; }

    let modal = document.getElementById('badge-celebration-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'badge-celebration-modal';
        document.body.appendChild(modal);
    }

    const siteUrl = 'https://exchange.teatrade.co.uk';
    const shareText = `I just earned the "${def.name}" badge on TeaTrade Exchange! ${def.desc}. Trade tea like a pro:`;
    const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(siteUrl)}`;
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareText + ' ' + siteUrl)}`;
    const fbUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(siteUrl)}&quote=${encodeURIComponent(shareText)}`;

    modal.innerHTML = `
        <div class="badge-celeb-backdrop" onclick="closeBadgeCelebration()"></div>
        <div class="badge-celeb-card">
            <button class="badge-celeb-close" onclick="closeBadgeCelebration()">&times;</button>
            <div class="badge-celeb-particles"></div>
            <div class="badge-celeb-icon" style="background:${def.bg};color:${def.color}">
                ${def.svg}
            </div>
            <div class="badge-celeb-title">Badge Unlocked!</div>
            <div class="badge-celeb-name" style="color:${def.color}">${def.name}</div>
            <div class="badge-celeb-desc">${def.desc}</div>
            <div class="badge-celeb-share-row">
                <a href="${twitterUrl}" target="_blank" rel="noopener" class="badge-share-btn badge-share-x" title="Share on X" onclick="_creditShareBonus()">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                </a>
                <a href="${whatsappUrl}" target="_blank" rel="noopener" class="badge-share-btn badge-share-wa" title="Share on WhatsApp" onclick="_creditShareBonus()">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                </a>
                <a href="${fbUrl}" target="_blank" rel="noopener" class="badge-share-btn badge-share-fb" title="Share on Facebook" onclick="_creditShareBonus()">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
                </a>
                <button class="badge-share-btn badge-share-copy" title="Copy to clipboard" onclick="copyBadgeShareText('${def.name.replace(/'/g, "\\'")}', '${def.desc.replace(/'/g, "\\'")}'); _creditShareBonus();">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
            </div>
        </div>`;

    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('active'));
}

function closeBadgeCelebration() {
    const modal = document.getElementById('badge-celebration-modal');
    if (modal) {
        modal.classList.remove('active');
        setTimeout(() => {
            modal.style.display = 'none';
            _showNextBadgeNotification();
        }, 250);
    }
}

function copyBadgeShareText(name, desc) {
    const text = `I just earned the "${name}" badge on TeaTrade Exchange! ${desc}. Trade tea like a pro: https://exchange.teatrade.co.uk`;
    navigator.clipboard.writeText(text).then(() => {
        showToast('Copied!', 'Share text copied to clipboard');
    }).catch(() => {
        showToast('Copy failed', 'Please copy manually', true);
    });
}

// =============================================
// SHARE PROMPT (after every N trades)
// =============================================

const _SHARE_TRADE_KEY = 'teatrade_trade_count';
const _SHARE_FIRST_TRIGGER = 5;
const _SHARE_REPEAT_INTERVAL = 20;

function _getSessionTradeCount() {
    return parseInt(localStorage.getItem(_SHARE_TRADE_KEY) || '0', 10);
}

function _incrementTradeCount() {
    const count = _getSessionTradeCount() + 1;
    localStorage.setItem(_SHARE_TRADE_KEY, String(count));
    return count;
}

function checkSharePrompt() {
    if ((state.userProfile?.tier || 'FREE') === 'PRO') return;
    const count = _incrementTradeCount();
    if (count === _SHARE_FIRST_TRIGGER ||
        (count > _SHARE_FIRST_TRIGGER && (count - _SHARE_FIRST_TRIGGER) % _SHARE_REPEAT_INTERVAL === 0)) {
        setTimeout(() => _showSharePrompt(), 2000);
    }
}

function _getTradeStats() {
    const profile = state.userProfile;
    if (!profile) return null;
    const bal = Number(profile.virtual_balance) || 10000;
    const returnPct = ((bal - 10000) / 10000 * 100).toFixed(1);
    const trades = state.userTrades?.length || 0;
    const wins = (state.userTrades || []).filter(t => t.closing_pnl > 0).length;
    const winRate = trades > 0 ? ((wins / trades) * 100).toFixed(0) : '0';
    return { balance: bal, returnPct, trades, wins, winRate, username: profile.username || 'Trader' };
}

function _showSharePrompt() {
    if (document.getElementById('badge-celebration-modal')?.style.display === 'flex') return;

    let modal = document.getElementById('share-prompt-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'share-prompt-modal';
        document.body.appendChild(modal);
    }

    const stats = _getTradeStats();
    const siteUrl = 'https://exchange.teatrade.co.uk';
    const defaultText = 'I\'m trading tea futures on TeaTrade Exchange — a virtual commodities platform with real auction data. Check it out:';

    const statsBlock = stats ? `
        <div class="share-prompt-stats" id="share-prompt-stats" style="display:none;">
            <div class="share-stat"><span class="share-stat-val">${stats.trades}</span><span class="share-stat-label">Trades</span></div>
            <div class="share-stat"><span class="share-stat-val ${Number(stats.returnPct) >= 0 ? 'up' : 'down'}">${Number(stats.returnPct) >= 0 ? '+' : ''}${stats.returnPct}%</span><span class="share-stat-label">Return</span></div>
            <div class="share-stat"><span class="share-stat-val">${stats.winRate}%</span><span class="share-stat-label">Win Rate</span></div>
        </div>
        <label class="share-toggle-row" for="share-stats-toggle">
            <input type="checkbox" id="share-stats-toggle" onchange="toggleShareStats(this.checked)">
            <span>Include my trading stats</span>
        </label>
    ` : '';

    modal.innerHTML = `
        <div class="share-prompt-backdrop" onclick="closeSharePrompt()"></div>
        <div class="share-prompt-card">
            <button class="badge-celeb-close" onclick="closeSharePrompt()">&times;</button>
            <div class="share-prompt-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
            </div>
            <div class="share-prompt-title">Enjoying TeaTrade?</div>
            <div class="share-prompt-sub">Share with friends and help grow the community</div>
            ${statsBlock}
            <div class="share-prompt-share-row">
                <a href="https://twitter.com/intent/tweet?text=${encodeURIComponent(defaultText)}&url=${encodeURIComponent(siteUrl)}" target="_blank" rel="noopener" class="badge-share-btn badge-share-x" title="Share on X" onclick="_creditShareBonus(); closeSharePrompt();">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                </a>
                <a href="https://wa.me/?text=${encodeURIComponent(defaultText + ' ' + siteUrl)}" target="_blank" rel="noopener" class="badge-share-btn badge-share-wa" title="Share on WhatsApp" onclick="_creditShareBonus(); closeSharePrompt();">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                </a>
                <a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(siteUrl)}" target="_blank" rel="noopener" class="badge-share-btn badge-share-fb" title="Share on Facebook" onclick="_creditShareBonus(); closeSharePrompt();">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
                </a>
                <button class="badge-share-btn badge-share-copy" title="Copy link" onclick="copyShareLink(); _creditShareBonus();">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
            </div>
            <button class="share-prompt-dismiss" onclick="closeSharePrompt()">Maybe later</button>
            <div class="share-prompt-pro-note" onclick="closeSharePrompt(); if(typeof renderStoreTab==='function'){document.getElementById('portfolio-modal').style.display='flex'; switchPortfolioTab('store');}">*Upgrade to <strong>Pro</strong> to remove these prompts</div>
        </div>`;

    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('active'));
}

function toggleShareStats(show) {
    const el = document.getElementById('share-prompt-stats');
    if (el) el.style.display = show ? 'flex' : 'none';

    const stats = _getTradeStats();
    if (!stats) return;
    const siteUrl = 'https://exchange.teatrade.co.uk';
    const text = show
        ? `I've placed ${stats.trades} trades on TeaTrade Exchange with a ${stats.returnPct}% return and ${stats.winRate}% win rate! Trade tea like a pro:`
        : 'I\'m trading tea futures on TeaTrade Exchange — a virtual commodities platform with real auction data. Check it out:';

    const modal = document.getElementById('share-prompt-modal');
    if (!modal) return;
    const xLink = modal.querySelector('.badge-share-x');
    const waLink = modal.querySelector('.badge-share-wa');
    if (xLink) xLink.href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(siteUrl)}`;
    if (waLink) waLink.href = `https://wa.me/?text=${encodeURIComponent(text + ' ' + siteUrl)}`;
}

function closeSharePrompt() {
    const modal = document.getElementById('share-prompt-modal');
    if (modal) {
        modal.classList.remove('active');
        setTimeout(() => { modal.style.display = 'none'; }, 250);
    }
}

function copyShareLink() {
    const statsToggle = document.getElementById('share-stats-toggle');
    const stats = _getTradeStats();
    const siteUrl = 'https://exchange.teatrade.co.uk';
    let text;
    if (statsToggle?.checked && stats) {
        text = `I've placed ${stats.trades} trades on TeaTrade Exchange with a ${stats.returnPct}% return and ${stats.winRate}% win rate! Trade tea like a pro: ${siteUrl}`;
    } else {
        text = `I'm trading tea futures on TeaTrade Exchange — a virtual commodities platform with real auction data. Check it out: ${siteUrl}`;
    }
    navigator.clipboard.writeText(text).then(() => {
        showToast('Copied!', 'Share text copied to clipboard');
    }).catch(() => {
        showToast('Copy failed', 'Please copy manually', true);
    });
    closeSharePrompt();
}

async function _creditShareBonus() {
    // Share bonus removed — placeholder kept so onclick handlers don't error
}
