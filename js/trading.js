/**
 * TeaTrade Exchange - Trade Execution (trading.js)
 * =================================================
 * All trade execution logic: form helpers, BUY/SELL for teas and indexes,
 * stop-loss / take-profit automation, and position close functions.
 *
 * Globals used from config.js : state, supabaseClient, isIndexSymbol
 * Globals used from api.js   : apiExecuteTrade, apiExecuteIndexTrade,
 *   apiClosePairTrade, apiFetchTradeById
 * Globals used from utils.js : showToast
 * Globals used from market.js: calculateRegionalIndexes
 *
 * Functions called from other modules (available at runtime as globals):
 *   loadPositions, loadUserTrades, updateUIForLoggedInUser,
 *   updatePortfolioDisplay, displayUserTrades, recordClosedTrade,
 *   openAuthModal, getIndexPosition, updateIndexPosition,
 *   loadIndexPositions, getIndexPrice
 */

// =============================================
// TRADE FORM HELPERS
// =============================================

/**
 * Toggle the trade-form side (BUY / SELL) and update button styling.
 * @param {'BUY'|'SELL'} type
 */
function setTradeType(type) {
    state.tradeType = type;
    document.getElementById('btn-trade-buy').classList.toggle('active', type === 'BUY');
    document.getElementById('btn-trade-sell').classList.toggle('active', type === 'SELL');

    const btn = document.getElementById('trade-execute-btn');
    btn.classList.remove('buy', 'sell');
    btn.classList.add(type.toLowerCase());

    updateTradeSummary();
}

/**
 * Increment / decrement a stop-loss or take-profit input by `delta`.
 */
function adjustSlTp(inputId, delta) {
    const input = document.getElementById(inputId);
    const currentVal = parseFloat(input.value) || 0;
    const newVal = Math.max(0, currentVal + delta);
    input.value = newVal.toFixed(2);
}

/**
 * Recalculate the estimated total shown below the trade form.
 * FIX: Fetches the price directly from state.teas / calculateRegionalIndexes
 * instead of the potentially-stale dataset.price on the <option> element.
 */
function updateTradeSummary() {
    const select = document.getElementById('trade-tea-select');
    const qtyInput = document.getElementById('trade-qty');
    const priceInput = document.getElementById('trade-price');
    const valueEl = document.getElementById('trade-value');

    const selectValue = select.value;
    let price = 0;

    if (selectValue) {
        if (selectValue.startsWith('INDEX_')) {
            // Index trade — use the live calculated index price
            const indexSymbol = selectValue.replace('INDEX_', '');
            const indexes = typeof calculateRegionalIndexes === 'function'
                ? calculateRegionalIndexes() : [];
            const idx = indexes.find(i => i.symbol === indexSymbol);
            price = idx?.price || 0;
        } else {
            // Tea trade — look up the live current_price from state.teas
            const teaId = parseInt(selectValue);
            const tea = state.teas?.find(t => t.id === teaId);
            price = tea?.current_price || 0;
        }
    }

    // Fallback to dataset.price if state isn't loaded yet
    if (!price) {
        const selectedOption = select.options[select.selectedIndex];
        price = selectedOption?.dataset?.price ? parseFloat(selectedOption.dataset.price) : 0;
    }

    const qty = parseFloat(qtyInput.value) || 0;
    const leverage = parseFloat(document.getElementById('trade-leverage')?.value) || 10;
    const SPREAD_PCT = 0.01;

    const isBuy = state.tradeType === 'BUY';
    const execPrice = price > 0 ? (isBuy ? price * (1 + SPREAD_PCT / 2) : price * (1 - SPREAD_PCT / 2)) : 0;
    priceInput.value = execPrice > 0 ? execPrice.toFixed(3) : '';

    const priceLabel = document.getElementById('trade-price-label');
    if (priceLabel) priceLabel.textContent = isBuy ? 'Ask Price ($/kg)' : 'Bid Price ($/kg)';
    const notional = execPrice * qty;
    const margin = notional / leverage;
    const spreadCost = Math.abs(execPrice - price) * qty;

    valueEl.textContent = '$' + notional.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const marginEl = document.getElementById('trade-margin');
    if (marginEl) marginEl.textContent = '$' + margin.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const spreadEl = document.getElementById('trade-spread-cost');
    if (spreadEl) spreadEl.textContent = '$' + spreadCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    updateTradeButton();
}

/**
 * Update the execute-trade button label and disabled state based on
 * current form values, user balance, and holdings.
 */
function updateTradeButton() {
    const btn = document.getElementById('trade-execute-btn');
    const select = document.getElementById('trade-tea-select');
    const qty = parseFloat(document.getElementById('trade-qty').value) || 0;
    const price = parseFloat(document.getElementById('trade-price').value) || 0;
    const leverage = parseFloat(document.getElementById('trade-leverage')?.value) || 10;
    const SPREAD_PCT = 0.01;
    const isBuy = state.tradeType === 'BUY';
    const execPrice = isBuy ? price * (1 + SPREAD_PCT / 2) : price * (1 - SPREAD_PCT / 2);
    const margin = (execPrice * qty) / leverage;

    if (!state.currentUser) {
        btn.textContent = 'Sign in to Trade';
        btn.disabled = false;
        btn.classList.add('signin-prompt');
        return;
    }

    btn.classList.remove('signin-prompt');

    if (!select.value) {
        btn.textContent = 'Select a Tea';
        btn.disabled = true;
        return;
    }

    if (qty <= 0) {
        btn.textContent = 'Enter Quantity';
        btn.disabled = true;
        return;
    }

    const balance = getActiveBalance();

    if (!isNaN(balance) && margin > balance) {
        btn.textContent = 'Insufficient Margin';
        btn.disabled = true;
        return;
    }

    const side = state.tradeType === 'BUY' ? 'BUY' : 'SELL';
    btn.textContent = `${side} ${qty.toLocaleString()} kg — margin $${margin.toFixed(2)} (${leverage}x)`;
    btn.disabled = false;
}

// =============================================
// CORE TRADE EXECUTION
// =============================================

/**
 * Execute a BUY or SELL trade from the main trade form.
 * Tea trades are routed through the server-side execute-trade Edge Function
 * for atomic, tamper-proof execution. Index trades use legacy client-side flow.
 */
async function executeTrade() {
    if (!state.currentUser) {
        openAuthModal();
        return;
    }

    // C7 FIX: Email verification gate
    if (typeof isEmailVerified === 'function' && !isEmailVerified()) {
        return;
    }

    const btn = document.getElementById('trade-execute-btn');
    const select = document.getElementById('trade-tea-select');
    const selectValue = select.value;
    const qty = parseFloat(document.getElementById('trade-qty').value);
    const price = parseFloat(document.getElementById('trade-price').value);
    const leverage = parseFloat(document.getElementById('trade-leverage')?.value) || 10;
    const total = price * qty;

    // SL / TP values
    const slInput = document.getElementById('trade-sl');
    const tpInput = document.getElementById('trade-tp');
    const stopLoss = slInput.value ? parseFloat(slInput.value) : null;
    const takeProfit = tpInput.value ? parseFloat(tpInput.value) : null;

    // Detect index vs tea trade
    const isIndexTrade = selectValue.startsWith('INDEX_');
    let tea = null;
    let teaId = null;
    let indexSymbol = null;
    let productName = '';

    // FIX: For index trades, capture the live index object now so we can
    // use its price at execution time — avoiding the >10% deviation error
    // that occurred when the form price was stale vs the server's reality.
    let _liveIndex = null;

    if (isIndexTrade) {
        indexSymbol = selectValue.replace('INDEX_', '');
        const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
        const index = indexes.find(idx => idx.symbol === indexSymbol);
        if (!index) {
            showToast('Index not found', 'error', true);
            return;
        }
        _liveIndex = index;
        productName = index.name || indexSymbol + ' Index';
        tea = state.teas?.find(t => index.teas?.includes(t.symbol));
        teaId = tea?.id || null;
    } else {
        teaId = parseInt(selectValue);
        tea = state.teas.find(t => t.id === teaId);
        if (!tea) return;
        productName = tea.name || tea.symbol;
    }

    btn.disabled = true;
    btn.textContent = 'Executing...';

    try {
        if (isIndexTrade) {
            // ── INDEX TRADE (C4 FIX: server-side atomic execution) ──
            // Use the live price from calculateRegionalIndexes (not the form
            // field) to ensure it matches the server's current reality.
            const executionPrice = (_liveIndex?.price && _liveIndex.price > 0)
                ? _liveIndex.price
                : price;

            const result = await apiExecuteIndexTrade(indexSymbol, state.tradeType, qty, executionPrice, leverage);

            if (!result.success) {
                throw new Error(result.error || 'Index trade failed');
            }

            setActiveBalance(result.new_balance);

            const idxSideLabel = state.tradeType === 'BUY' ? 'Bought' : 'Shorted';
            const _sc = result.spread_cost ? ` — Spread: $${Number(result.spread_cost).toFixed(2)}` : '';
            showToast('Trade Executed!', `${idxSideLabel} ${qty.toLocaleString()} kg of ${productName} at $${(result.execution_price || executionPrice).toFixed(2)}/kg (${leverage}x)${_sc}`);

            await loadIndexPositions();

        } else {
            // ── TEA TRADE (server-side atomic execution) ────────────────
            const result = await apiExecuteTrade(tea.symbol, state.tradeType, qty, leverage);

            if (!result.success) {
                throw new Error(result.error || 'Trade failed');
            }

            setActiveBalance(result.new_balance);

            const serverPrice = result.price;
            const serverTotal = result.total;

            const sideLabel = state.tradeType === 'BUY' ? 'Bought' : 'Shorted';
            const _sc = result.spread_cost ? ` — Spread: $${Number(result.spread_cost).toFixed(2)}` : '';
            showToast('Trade Executed!',
                `${sideLabel} ${qty.toLocaleString()} kg of ${tea.symbol} at $${serverPrice.toFixed(2)}/kg (${leverage}x)${_sc}`);

            if (stopLoss || takeProfit) {
                state.pendingSlTpOrders[tea.id] = {
                    sl: stopLoss, tp: takeProfit, side: state.tradeType,
                    qty: qty, symbol: tea.symbol, entryPrice: serverPrice
                };
                if (stopLoss && takeProfit) {
                    showToast('SL/TP Set', `SL: $${stopLoss.toFixed(2)} | TP: $${takeProfit.toFixed(2)}`);
                } else if (stopLoss) {
                    showToast('Stop Loss Set', `Will close at $${stopLoss.toFixed(2)}`);
                } else {
                    showToast('Take Profit Set', `Will close at $${takeProfit.toFixed(2)}`);
                }
            }
        }

        // Brief success flash on the button
        btn.textContent = '✓ Trade Executed';
        btn.classList.add('trade-success');
        btn.disabled = false;

        // Refresh data from server (source of truth)
        await loadPositions();
        await loadUserTrades();
        updateUIForLoggedInUser();

        // Hold the success state for a moment, then reset form
        await new Promise(r => setTimeout(r, 1500));
        btn.classList.remove('trade-success');
        document.getElementById('trade-qty').value = '';
        document.getElementById('trade-sl').value = '';
        document.getElementById('trade-tp').value = '';
        updateTradeSummary();

    } catch (error) {
        console.error('Trade error:', error);
        showToast('Trade Failed', error.message, true);
    }

    updateTradeButton();
}

// =============================================
// STOP-LOSS / TAKE-PROFIT EXECUTION
// =============================================

/**
 * Execute an automatic SL/TP close for a given tea position.
 * Called by `checkSlTpOrders` (in market.js) when a trigger fires.
 */
async function executeSlTpClose(teaId, order, currentPrice, triggerType) {
    const tea = state.teas.find(t => t.id === teaId);
    if (!tea) return;

    const position = state.positions.find(p => p.tea_id === teaId);
    if (!position) {
        delete state.pendingSlTpOrders[teaId];
        return;
    }

    const qty = Math.min(order.qty, position.quantity);

    try {
        // Server-side atomic SELL
        const result = await apiExecuteTrade(tea.symbol, 'SELL', qty);

        if (!result.success) {
            throw new Error(result.error || 'SL/TP execution failed');
        }

        const pnl = (result.price - order.entryPrice) * qty;
        const pnlText = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;

        delete state.pendingSlTpOrders[teaId];

        setActiveBalance(result.new_balance);
        await loadPositions();
        updateUIForLoggedInUser();

        showToast(`${triggerType} Triggered!`, `${order.symbol} closed at $${result.price.toFixed(2)} (${pnlText})`);

    } catch (error) {
        console.error('SL/TP execution error:', error);
        showToast('SL/TP Error', error.message, true);
    }
}

// =============================================
// POSITION CLOSE FUNCTIONS
// =============================================

/**
 * Close a tea position at the current market price.
 * Longs are closed by SELL, shorts are closed by BUY.
 * @param {number} teaId     - The tea instrument ID.
 * @param {number} quantity  - Signed quantity from position (positive=long, negative=short).
 * @param {string} teaSymbol - Display symbol (e.g. 'KEN-BP1').
 */
async function closePosition(teaId, quantity, teaSymbol) {
    if (!state.currentUser) {
        openAuthModal();
        return;
    }

    const position = state.positions.find(p => p.tea_id === teaId);
    if (!position) {
        showToast('Error', 'Position not found', true);
        return;
    }

    const isShort = position.quantity < 0;
    const closeSide = isShort ? 'BUY' : 'SELL';
    const closeQty = Math.abs(quantity);

    try {
        const result = await apiExecuteTrade(teaSymbol, closeSide, closeQty);

        if (!result.success) {
            throw new Error(result.error || 'Close failed');
        }

        setActiveBalance(result.new_balance);

        let pnl;
        if (isShort) {
            pnl = (position.avg_entry_price - result.price) * closeQty;
        } else {
            pnl = (result.price - position.avg_entry_price) * closeQty;
        }
        const pnlText = pnl >= 0 ? `Profit: +$${pnl.toFixed(2)}` : `Loss: -$${Math.abs(pnl).toFixed(2)}`;
        const action = isShort ? 'Covered' : 'Sold';
        showToast('Position Closed!', `${action} ${closeQty.toLocaleString()} kg of ${teaSymbol}. ${pnlText}`);

        recordClosedTrade({
            ...position,
            symbol: teaSymbol,
            quantity: closeQty,
            type: isShort ? 'short' : 'long'
        }, result.price);

        await loadPositions();
        await new Promise(r => setTimeout(r, 400));
        await loadUserTrades();
        updateUIForLoggedInUser();

    } catch (error) {
        console.error('Close position error:', error);
        showToast('Error', error.message, true);
    }
}

/**
 * Close an index position at the current calculated index price.
 * Longs are closed by SELL, shorts are closed by BUY.
 * @param {string} indexSymbol - e.g. 'KENYA'
 * @param {number} quantity    - Signed quantity from position.
 * @param {string} tradeId     - Original trade row ID (for reference).
 */
async function closeIndexPosition(indexSymbol, quantity, tradeId) {
    if (!state.currentUser) {
        openAuthModal();
        return;
    }

    const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
    const index = indexes.find(idx => idx.symbol === indexSymbol);
    if (!index) {
        showToast('Error', 'Index not found', true);
        return;
    }

    const position = state.indexPositions[indexSymbol];
    if (!position) {
        showToast('Error', 'Index position not found', true);
        return;
    }

    const isShort = position.quantity < 0;
    const closeSide = isShort ? 'BUY' : 'SELL';
    const closeQty = Math.abs(quantity);
    const price = index.price;

    try {
        const result = await apiExecuteIndexTrade(indexSymbol, closeSide, closeQty, price);

        if (!result.success) {
            throw new Error(result.error || 'Close failed');
        }

        setActiveBalance(result.new_balance);

        let pnl;
        if (isShort) {
            pnl = (position.avg_entry_price - price) * closeQty;
        } else {
            pnl = (price - position.avg_entry_price) * closeQty;
        }
        const pnlText = pnl >= 0 ? `Profit: +$${pnl.toFixed(2)}` : `Loss: -$${Math.abs(pnl).toFixed(2)}`;
        const action = isShort ? 'Covered' : 'Sold';
        showToast('Position Closed!', `${action} ${closeQty.toLocaleString()} kg of ${indexSymbol} Index. ${pnlText}`);

        await loadPositions();
        await loadIndexPositions();
        await new Promise(r => setTimeout(r, 400));
        await loadUserTrades();
        updateUIForLoggedInUser();

    } catch (error) {
        console.error('Close index position error:', error);
        showToast('Error', error.message, true);
    }
}

/**
 * Close a pair-trade position by its trade record ID.
 * Calculates the current ratio, derives P/L, and records the closing leg.
 * @param {string} tradeId - The original pair-trade row UUID.
 */
async function closePairPosition(tradeId) {
    if (!state.currentUser) {
        openAuthModal();
        return;
    }

    try {
        // Fetch original trade record
        const { data: trade, error: fetchError } = await apiFetchTradeById(tradeId);
        if (fetchError) throw fetchError;
        if (!trade || !trade.is_pair_trade) {
            showToast('Error', 'Pair trade not found', true);
            return;
        }

        // Resolve the pair definition
        let pair = null;
        let isIndexPair = false;

        if (trade.pair_id) {
            pair = state.teaPairs.find(p => p.id === trade.pair_id);
        }

        if (!pair && trade.index_symbol && trade.index_symbol.includes('/')) {
            const parts = trade.index_symbol.split('/');
            pair = { base_symbol: parts[0], quote_symbol: parts[1], isIndex: true };
            isIndexPair = true;
        }

        if (!pair && trade.pair_id) {
            pair = state.indexPairs.find(p => p.id === trade.pair_id);
            if (pair) isIndexPair = true;
        }

        if (!pair) {
            showToast('Error', 'Pair not found', true);
            return;
        }

        // Calculate current base / quote prices
        let basePrice, quotePrice;

        if (isIndexPair) {
            const baseIdx = getIndexPrice(pair.base_symbol);
            const quoteIdx = getIndexPrice(pair.quote_symbol);
            if (!baseIdx || !quoteIdx) {
                showToast('Error', 'Could not get current index prices', true);
                return;
            }
            basePrice = baseIdx.price;
            quotePrice = quoteIdx.price;
        } else {
            const teaMap = {};
            state.teas.forEach(t => teaMap[t.symbol] = t);
            const baseTea = teaMap[pair.base_symbol];
            const quoteTea = teaMap[pair.quote_symbol];
            if (!baseTea || !quoteTea) {
                showToast('Error', 'Could not get current prices', true);
                return;
            }
            basePrice = baseTea.current_price;
            quotePrice = quoteTea.current_price;
        }

        const currentRatio = basePrice / quotePrice;
        const entryRatio = trade.price;
        const leverage = trade.leverage || 1;
        const margin = trade.quantity;

        // C4 FIX: Server-side atomic pair close
        const result = await apiClosePairTrade(tradeId, currentRatio);

        if (!result.success) {
            throw new Error(result.error || 'Pair close failed');
        }

        setActiveBalance(result.new_balance);

        const pnl = result.pnl || 0;
        const baseShort = pair.base_symbol.split('-')[1] || pair.base_symbol;
        const quoteShort = pair.quote_symbol.split('-')[1] || pair.quote_symbol;
        const pnlText = pnl >= 0 ? `Profit: +$${pnl.toFixed(2)}` : `Loss: -$${Math.abs(pnl).toFixed(2)}`;
        const posType = trade.side === 'BUY' ? 'LONG' : 'SHORT';

        showToast('Pair Position Closed!', `Closed ${posType} ${baseShort}/${quoteShort} ${leverage}x. ${pnlText}`);

        recordClosedTrade({
            symbol: `${baseShort}/${quoteShort}`,
            type: trade.side === 'BUY' ? 'long' : 'short',
            quantity: margin,
            avg_price: entryRatio,
            created_at: trade.created_at
        }, currentRatio);

        await loadPositions();
        await loadIndexPositions();
        await new Promise(r => setTimeout(r, 400));
        await loadUserTrades();
        updateUIForLoggedInUser();

    } catch (error) {
        console.error('Close pair position error:', error);
        showToast('Error', error.message, true);
    }
}
