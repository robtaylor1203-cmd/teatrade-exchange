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

    updateTradeButton();
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
 */
function updateTradeSummary() {
    const select = document.getElementById('trade-tea-select');
    const qtyInput = document.getElementById('trade-qty');
    const priceInput = document.getElementById('trade-price');
    const valueEl = document.getElementById('trade-value');

    const selectedOption = select.options[select.selectedIndex];
    const price = selectedOption?.dataset?.price ? parseFloat(selectedOption.dataset.price) : 0;
    const qty = parseFloat(qtyInput.value) || 0;

    priceInput.value = price > 0 ? price.toFixed(3) : '';
    const total = price * qty;
    valueEl.textContent = '$' + total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
    const total = price * qty;

    if (!state.currentUser) {
        btn.textContent = 'Sign in to Trade';
        btn.disabled = false; // Keep enabled so it opens auth modal
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

    const balance = parseFloat(state.userProfile?.cash_balance);

    if (state.tradeType === 'BUY') {
        if (!isNaN(balance) && total > balance) {
            btn.textContent = 'Insufficient Balance';
            btn.disabled = true;
            return;
        }
        btn.textContent = `BUY ${qty.toLocaleString()} kg for $${total.toFixed(2)}`;
    } else {
        // SELL — check holdings
        const selectValue = select.value;
        const isIndex = selectValue.startsWith('INDEX_');

        if (isIndex) {
            btn.textContent = `SELL ${qty.toLocaleString()} kg for $${total.toFixed(2)}`;
        } else {
            const teaId = parseInt(selectValue);
            const position = state.positions.find(p => p.tea_id === teaId);
            if (!position || position.quantity < qty) {
                btn.textContent = 'Insufficient Holdings';
                btn.disabled = true;
                return;
            }
            btn.textContent = `SELL ${qty.toLocaleString()} kg for $${total.toFixed(2)}`;
        }
    }
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

    if (isIndexTrade) {
        indexSymbol = selectValue.replace('INDEX_', '');
        const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
        const index = indexes.find(idx => idx.symbol === indexSymbol);
        if (!index) {
            showToast('Index not found', 'error', true);
            return;
        }
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
            const result = await apiExecuteIndexTrade(indexSymbol, state.tradeType, qty, price);

            if (!result.success) {
                throw new Error(result.error || 'Index trade failed');
            }

            state.userProfile.cash_balance = result.new_balance;

            if (state.tradeType === 'BUY') {
                showToast('Trade Executed!', `Bought ${qty.toLocaleString()} kg of ${productName} at $${price.toFixed(2)}/kg`);
            } else {
                const indexPos = state.indexPositions?.[indexSymbol];
                const entryPrice = indexPos?.avg_entry_price || price;
                const pnl = (price - entryPrice) * qty;
                const pnlText = pnl >= 0 ? `Profit: +$${pnl.toFixed(2)}` : `Loss: -$${Math.abs(pnl).toFixed(2)}`;
                showToast('Trade Executed!', `Sold ${qty.toLocaleString()} kg of ${productName}. ${pnlText}`);
            }

            await loadIndexPositions();

        } else {
            // ── TEA TRADE (server-side atomic execution) ────────────────
            const result = await apiExecuteTrade(tea.symbol, state.tradeType, qty);

            if (!result.success) {
                throw new Error(result.error || 'Trade failed');
            }

            // Update local state from server response
            state.userProfile.cash_balance = result.new_balance;

            const serverPrice = result.price;
            const serverTotal = result.total;

            if (state.tradeType === 'BUY') {
                showToast('Trade Executed!',
                    `Bought ${qty.toLocaleString()} kg of ${tea.symbol} at $${serverPrice.toFixed(2)}/kg`);

                // Register SL/TP orders if set
                if (stopLoss || takeProfit) {
                    state.pendingSlTpOrders[tea.id] = {
                        sl: stopLoss, tp: takeProfit, side: 'BUY',
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
            } else {
                const existingPosition = state.positions.find(p => p.tea_id === tea.id);
                const entryPrice = existingPosition?.avg_entry_price || serverPrice;
                const pnl = (serverPrice - entryPrice) * qty;
                const pnlText = pnl >= 0 ? `Profit: +$${pnl.toFixed(2)}` : `Loss: -$${Math.abs(pnl).toFixed(2)}`;
                showToast('Trade Executed!', `Sold ${qty.toLocaleString()} kg of ${tea.symbol}. ${pnlText}`);
            }
        }

        // Refresh data from server (source of truth)
        await loadPositions();
        await loadUserTrades();
        updateUIForLoggedInUser();

        // Reset form
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

        state.userProfile.cash_balance = result.new_balance;
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
 * Close (sell) a tea position at the current market price.
 * @param {number} teaId     - The tea instrument ID.
 * @param {number} quantity  - Quantity to sell.
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

    try {
        // Server-side atomic SELL at current market price
        const result = await apiExecuteTrade(teaSymbol, 'SELL', quantity);

        if (!result.success) {
            throw new Error(result.error || 'Close failed');
        }

        state.userProfile.cash_balance = result.new_balance;

        const pnl = (result.price - position.avg_entry_price) * quantity;
        const pnlText = pnl >= 0 ? `Profit: +$${pnl.toFixed(2)}` : `Loss: -$${Math.abs(pnl).toFixed(2)}`;
        showToast('Position Closed!', `Sold ${quantity.toLocaleString()} kg of ${teaSymbol}. ${pnlText}`);

        recordClosedTrade({
            ...position,
            symbol: teaSymbol,
            quantity: quantity,
            type: 'long'
        }, result.price);

        await loadPositions();
        await loadUserTrades();
        updateUIForLoggedInUser();

    } catch (error) {
        console.error('Close position error:', error);
        showToast('Error', error.message, true);
    }
}

/**
 * Close (sell) an index position at the current calculated index price.
 * @param {string} indexSymbol - e.g. 'KENYA'
 * @param {number} quantity
 * @param {string} tradeId     - Original trade row ID (for reference).
 */
async function closeIndexPosition(indexSymbol, quantity, tradeId) {
    if (!state.currentUser) {
        openAuthModal();
        return;
    }

    // Get current index price
    const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
    const index = indexes.find(idx => idx.symbol === indexSymbol);
    if (!index) {
        showToast('Error', 'Index not found', true);
        return;
    }

    const position = state.indexPositions[indexSymbol];
    if (!position || position.quantity < quantity) {
        showToast('Error', 'Index position not found or insufficient quantity', true);
        return;
    }

    const price = index.price;

    try {
        // C4 FIX: Server-side atomic SELL
        const result = await apiExecuteIndexTrade(indexSymbol, 'SELL', quantity, price);

        if (!result.success) {
            throw new Error(result.error || 'Close failed');
        }

        state.userProfile.cash_balance = result.new_balance;

        const pnl = (price - position.avg_entry_price) * quantity;
        const pnlText = pnl >= 0 ? `Profit: +$${pnl.toFixed(2)}` : `Loss: -$${Math.abs(pnl).toFixed(2)}`;
        showToast('Position Closed!', `Sold ${quantity.toLocaleString()} kg of ${indexSymbol} Index. ${pnlText}`);

        // Refresh data
        await loadIndexPositions();
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

        state.userProfile.cash_balance = result.new_balance;

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

        await loadUserTrades();
        updateUIForLoggedInUser();

    } catch (error) {
        console.error('Close pair position error:', error);
        showToast('Error', error.message, true);
    }
}
