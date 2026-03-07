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
 * FCA leverage cap: 10x for real money, 25x for virtual/demo.
 */
function getMaxLeverage() {
    return state.tradingMode === 'REAL' ? 10 : 25;
}

function clampLeverage(rawLev) {
    return Math.max(1, Math.min(getMaxLeverage(), rawLev));
}

/**
 * Sync both leverage dropdowns (main trade form + quick-quote) to
 * enable/disable options that exceed the current mode's cap.
 */
function syncLeverageDropdowns() {
    const max = getMaxLeverage();
    ['trade-leverage', 'qq-leverage'].forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        Array.from(sel.options).forEach(opt => {
            const v = Number(opt.value);
            opt.disabled = v > max;
            if (v > max && opt.selected) {
                sel.value = String(max);
            }
        });
    });
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
    let baseSpread = 0.01;
    let volMultiplier = 1.0;
    let tradingMode = 'FULL';

    let isIndexSelected = false;

    // Index spread: 1% per side (2% total) to match platform_config.spread_pct = 0.02.
    // BUY at Ask = mid × 1.01, SELL at Bid = mid × 0.99.
    const INDEX_SPREAD_PCT = 0.02; // 2% total = 1% per side — matches order table

    if (selectValue) {
        if (selectValue.startsWith('INDEX_')) {
            isIndexSelected = true;
            const indexSymbol = selectValue.replace('INDEX_', '');
            const indexes = typeof calculateRegionalIndexes === 'function'
                ? calculateRegionalIndexes() : [];
            const idx = indexes.find(i => i.symbol === indexSymbol);
            price = idx?.price || 0;
        } else {
            const teaId = parseInt(selectValue);
            const tea = state.teas?.find(t => t.id === teaId);
            price = tea?.current_price || 0;
            baseSpread = Number(tea?.base_spread) || 0.01;
            volMultiplier = Number(tea?.volatility_multiplier) || 1.0;
            tradingMode = tea?.trading_mode || 'FULL';
        }
    }

    if (!price) {
        const selectedOption = select.options[select.selectedIndex];
        price = selectedOption?.dataset?.price ? parseFloat(selectedOption.dataset.price) : 0;
    }

    const qty = parseFloat(qtyInput.value) || 0;
    const leverage = clampLeverage(parseFloat(document.getElementById('trade-leverage')?.value) || 10);

    // Spread: index → fixed 0.2%; tea → base_spread × volatility_multiplier
    const SPREAD_PCT = isIndexSelected ? INDEX_SPREAD_PCT : (baseSpread * volMultiplier);

    const isBuy = state.tradeType === 'BUY';
    // BUY at Ask (mid + half-spread), SELL at Bid (mid − half-spread).
    // This is the T212 model: spread is the cost of entry visible in the form.
    const execPrice = price > 0
        ? (isBuy ? price * (1 + SPREAD_PCT / 2) : price * (1 - SPREAD_PCT / 2))
        : 0;
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
    if (spreadEl) {
        let spreadLabel = '$' + spreadCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (volMultiplier > 1.05) spreadLabel += ` (${volMultiplier.toFixed(1)}x)`;
        spreadEl.textContent = spreadLabel;
        spreadEl.classList.toggle('spread-elevated', volMultiplier > 1.05);
    }

    // Store for use by updateTradeButton
    state._currentTradingMode = tradingMode;

    updateTradeButton();

    // Keep mobile sticky bar prices in sync
    if (typeof updateMobileTradePrices === 'function') updateMobileTradePrices();
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
    const leverage = clampLeverage(parseFloat(document.getElementById('trade-leverage')?.value) || 10);
    const isBuy = state.tradeType === 'BUY';
    const margin = (price * qty) / leverage;

    btn.classList.remove('btn-halted', 'btn-close-only');
    btn.title = ''; // Reset tooltip

    if (!state.currentUser) {
        btn.textContent = 'Sign in to Trade';
        btn.disabled = false;
        btn.classList.add('signin-prompt');
        return;
    }

    btn.classList.remove('signin-prompt');

    // ── Account locked / combine enforcement ──────────────────────
    const acctStatus = state.userProfile?.account_status;
    if (acctStatus === 'LOCKED') {
        btn.textContent = 'ACCOUNT LOCKED';
        btn.disabled = true;
        btn.classList.add('btn-halted');
        return;
    }

    if (!select.value) {
        btn.textContent = 'Select a Tea';
        btn.disabled = true;
        return;
    }

    // ── Trading mode enforcement ──────────────────────────────────
    const tradingMode = state._currentTradingMode || 'FULL';

    if (tradingMode === 'HALTED') {
        btn.textContent = 'MARKET HALTED';
        btn.title = 'Trading Paused: Live auction in progress';
        btn.disabled = true;
        btn.classList.add('btn-halted');
        return;
    }

    if (tradingMode === 'CLOSE_ONLY') {
        // In CLOSE_ONLY, only allow trades that reduce exposure.
        // For teas: SELL closes a long → allowed. BUY opens → blocked.
        const selectValue = select.value;
        let userHasPosition = false;
        if (selectValue && !selectValue.startsWith('INDEX_')) {
            const teaId = parseInt(selectValue);
            userHasPosition = state.positions?.some(p => p.tea_id === teaId) || false;
        }

        if (isBuy || !userHasPosition) {
            btn.textContent = 'CLOSE ONLY';
            btn.disabled = true;
            btn.classList.add('btn-close-only');
            return;
        }
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
    const leverage = clampLeverage(parseFloat(document.getElementById('trade-leverage')?.value) || 10);
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

    // Re-read the live price from state right before execution so the form
    // reflects the most recent Realtime tick (avoids stale-form entry).
    updateTradeSummary();

    // ── Debounce guard: prevent double-click / double-submit ──────────────
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Executing...';
    const _originalBtnText = state.tradeType === 'BUY' ? 'Buy' : 'Sell';

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

            // ── Sync volume_24h from DB ─────────────────────────────────────────
            // The server computes its index VWA using live DB volume_24h weights.
            // Our client's state.teas[].volume_24h may be stale (only updated via
            // Realtime when the volume column changes). A stale VWA causes the client's
            // calculateRegionalIndexes() to return a different price than the server
            // computed, making open P/L appear incorrect immediately after execution.
            // Fix: fetch fresh current_price + volume_24h for all teas before rendering.
            try {
                const { data: freshTeas } = await supabaseClient
                    .from('teas')
                    .select('id, current_price, volume_24h');
                if (freshTeas && freshTeas.length > 0 && state.teas) {
                    freshTeas.forEach(ft => {
                        const idx = state.teas.findIndex(t => t.id === ft.id);
                        if (idx >= 0) {
                            if (ft.current_price > 0) state.teas[idx].current_price = ft.current_price;
                            if (ft.volume_24h != null) state.teas[idx].volume_24h = ft.volume_24h;
                        }
                    });
                }
            } catch (_) { /* non-fatal: stale weights are better than crashing */ }

            // Immediately patch local indexPositions state with the server-confirmed
            // execution price BEFORE loadUserTrades() renders the table.
            const confirmedIdxPrice = result.execution_price ?? executionPrice;
            if (state.indexPositions) {
                if (state.indexPositions[indexSymbol]) {
                    state.indexPositions[indexSymbol].avg_entry_price = confirmedIdxPrice;
                } else {
                    state.indexPositions[indexSymbol] = {
                        avg_entry_price: confirmedIdxPrice,
                        quantity: state.tradeType === 'BUY' ? qty : -qty,
                        leverage
                    };
                }
            }

            // Immediately fetch trades so the server-confirmed row
            // replaces any optimistic/estimated row in the UI.
            await loadUserTrades();

            // confirmedIdxPrice already declared above — reuse for toast.
            const idxSideLabel = state.tradeType === 'BUY' ? 'Bought' : 'Shorted';
            // Use result.price (the spread-adjusted Ask/Bid stored in DB by the RPC).
            // The Edge Function also returns 'execution_price' but overwrites it with
            // the raw mid price — NOT what's stored in the DB or shown in the orders table.
            const toastPrice = result.price ?? confirmedIdxPrice;
            const _sc = result.spread_cost ? ` — Spread: $${Number(result.spread_cost).toFixed(4)}` : '';
            showToast('Trade Executed!', `${idxSideLabel} ${qty.toLocaleString()} kg of ${productName} at $${Number(toastPrice).toFixed(4)}/kg (${leverage}x)${_sc}`);

            await loadIndexPositions();

        } else {
            // ── TEA TRADE (server-side atomic, slippage-guarded execution) ──
            const expectedPrice = tea.current_price;
            const slippageTolerance = expectedPrice * 0.01;
            const result = await apiExecuteTrade(tea.symbol, state.tradeType, qty, leverage, expectedPrice, slippageTolerance);

            if (!result.success) {
                throw new Error(result.error || 'Trade failed');
            }

            setActiveBalance(result.new_balance);

            // Immediately fetch trades so the server-confirmed row appears
            // in the table before the toast fires — prevents stale estimated rows.
            await loadUserTrades();

            // Use the server-confirmed price for the toast (source of truth).
            const serverPrice = result.price;

            const sideLabel = state.tradeType === 'BUY' ? 'Bought' : 'Shorted';
            const _sc = result.spread_cost ? ` — Spread: $${Number(result.spread_cost).toFixed(4)}` : '';
            showToast('Trade Executed!',
                `${sideLabel} ${qty.toLocaleString()} kg of ${tea.symbol} at $${serverPrice.toFixed(4)}/kg (${leverage}x)${_sc}`);

            if (stopLoss || takeProfit) {
                const slTpPayload = {};
                if (stopLoss) slTpPayload.stop_loss = stopLoss;
                if (takeProfit) slTpPayload.take_profit = takeProfit;

                const { error: slTpErr } = await supabaseClient
                    .from('positions')
                    .update(slTpPayload)
                    .eq('user_id', state.userId)
                    .eq('tea_id', tea.id)
                    .eq('trading_mode', state.tradingMode);

                if (slTpErr) {
                    console.warn('SL/TP write failed:', slTpErr.message);
                } else {
                    if (stopLoss && takeProfit) {
                        showToast('SL/TP Set', `SL: $${stopLoss.toFixed(2)} | TP: $${takeProfit.toFixed(2)}`);
                    } else if (stopLoss) {
                        showToast('Stop Loss Set', `Will close at $${stopLoss.toFixed(2)}`);
                    } else {
                        showToast('Take Profit Set', `Will close at $${takeProfit.toFixed(2)}`);
                    }
                }
            }
        }

        // Brief success flash on the button
        btn.textContent = '✓ Trade Executed';
        btn.classList.add('trade-success');

        if (typeof completeFirstTradeMissionTrade === 'function') {
            completeFirstTradeMissionTrade();
        }

        // Refresh data from server (source of truth)
        await Promise.all([loadPositions(), loadUserTrades(), loadUserProfile()]);
        updateUIForLoggedInUser();

        // Check for newly earned badges after trade
        if (typeof checkAndNotifyNewBadges === 'function') checkAndNotifyNewBadges();
        if (typeof checkSharePrompt === 'function') checkSharePrompt();

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
    } finally {
        // ── Always re-enable the button — even if the network call threw ──
        btn.disabled = false;
        btn.classList.remove('trade-success');
        updateTradeButton();
    }
}


// Module-level debounce guard: tracks closing operations in flight.
// Keyed by a string ID (teaId, indexSymbol, or pairTradeId).
// Prevents double-click on Close buttons from firing duplicate API requests.
const _closingInProgress = new Set();

/**
 * Close a tea position at the current market price.
 * Longs are closed by SELL, shorts are closed by BUY.
 * @param {number} teaId     - The tea instrument ID.
 * @param {number} quantity  - Signed quantity from position (positive=long, negative=short).
 * @param {string} teaSymbol - Display symbol (e.g. 'KEN-BP1').
 * @param {HTMLElement} [btn] - Optional close button element to debounce.
 */
async function closePosition(teaId, quantity, teaSymbol, btn) {
    if (!state.currentUser) {
        openAuthModal();
        return;
    }

    // ── Debounce guard ────────────────────────────────────────────────────
    const _guardKey = `tea_${teaId}`;
    if (_closingInProgress.has(_guardKey)) return;
    _closingInProgress.add(_guardKey);
    const _origBtnText = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Closing...'; }

    try {
        const position = state.positions.find(p => p.tea_id === teaId);
        if (!position) {
            showToast('Error', 'Position not found', true);
            return;
        }

        const isShort = position.quantity < 0;
        const closeSide = isShort ? 'BUY' : 'SELL';

        // Safety clamp: ensure we never close more than our active net position,
        // to prevent floating-point mismatches from accidentally flipping the trade side.
        let closeQty = Math.abs(quantity);
        if (closeQty > Math.abs(position.quantity)) {
            closeQty = Math.abs(position.quantity);
        }

        const tea = state.teas.find(t => t.id === teaId);
        const expectedPrice = tea?.current_price || 0;
        const slippageTolerance = expectedPrice * 0.01;
        const result = await apiExecuteTrade(teaSymbol, closeSide, closeQty, 1, expectedPrice, slippageTolerance);

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

        await Promise.all([loadPositions(), loadUserProfile()]);
        await new Promise(r => setTimeout(r, 400));
        await loadUserTrades();
        updateUIForLoggedInUser();
        if (typeof checkAndNotifyNewBadges === 'function') checkAndNotifyNewBadges();
        if (typeof checkSharePrompt === 'function') checkSharePrompt();

    } catch (error) {
        console.error('Close position error:', error);
        showToast('Error', error.message, true);
    } finally {
        // ── Always re-enable the button and clear the guard ──────────────
        _closingInProgress.delete(_guardKey);
        if (btn) { btn.disabled = false; btn.textContent = _origBtnText || 'Close'; }
    }
}

/**
 * Close an index position at the current calculated index price.
 * Longs are closed by SELL, shorts are closed by BUY.
 * @param {string} indexSymbol - e.g. 'KENYA'
 * @param {number} quantity    - Signed quantity from position.
 * @param {string} tradeId     - Original trade row ID (for reference).
 * @param {HTMLElement} [btn]  - Optional close button element to debounce.
 */
async function closeIndexPosition(indexSymbol, quantity, tradeId, btn) {
    if (!state.currentUser) {
        openAuthModal();
        return;
    }

    // ── Debounce guard ────────────────────────────────────────────────────
    const _guardKey = `idx_${indexSymbol}`;
    if (_closingInProgress.has(_guardKey)) return;
    _closingInProgress.add(_guardKey);
    const _origBtnText = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Closing...'; }

    try {
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

        // Safety clamp: ensure we never close more than our active net position,
        // to prevent floating-point mismatches from accidentally flipping the trade side.
        let closeQty = Math.abs(quantity);
        if (closeQty > Math.abs(position.quantity)) {
            closeQty = Math.abs(position.quantity);
        }

        const price = index.price;
        const result = await apiExecuteIndexTrade(indexSymbol, closeSide, closeQty, price);

        if (!result.success) {
            throw new Error(result.error || 'Close failed');
        }

        setActiveBalance(result.new_balance);

        // Close price = mid price. Server no longer applies spread on close
        // (see migration 20260307000000_index_close_no_spread.sql).
        // result.price now equals p_price (the mid we sent), so the balance
        // adjustment, the orders table, and the toast all show the same figure.
        const closePrice = result.price ?? price;
        let pnl;
        if (isShort) {
            pnl = (position.avg_entry_price - closePrice) * closeQty;
        } else {
            pnl = (closePrice - position.avg_entry_price) * closeQty;
        }
        const pnlText = pnl >= 0 ? `Profit: +$${pnl.toFixed(2)}` : `Loss: -$${Math.abs(pnl).toFixed(2)}`;
        const action = isShort ? 'Covered' : 'Sold';
        showToast('Position Closed!', `${action} ${closeQty.toLocaleString()} kg of ${indexSymbol} Index at $${Number(closePrice).toFixed(4)}/kg. ${pnlText}`);

        await Promise.all([loadPositions(), loadIndexPositions(), loadUserProfile()]);
        await new Promise(r => setTimeout(r, 400));
        await loadUserTrades();
        updateUIForLoggedInUser();
        if (typeof checkAndNotifyNewBadges === 'function') checkAndNotifyNewBadges();
        if (typeof checkSharePrompt === 'function') checkSharePrompt();

    } catch (error) {
        console.error('Close index position error:', error);
        showToast('Error', error.message, true);
    } finally {
        // ── Always re-enable the button and clear the guard ──────────────
        _closingInProgress.delete(_guardKey);
        if (btn) { btn.disabled = false; btn.textContent = _origBtnText || 'Close'; }
    }
}

/**
 * Close a pair-trade position by its trade record ID.
 * Calculates the current ratio, derives P/L, and records the closing leg.
 * @param {string} tradeId    - The original pair-trade row UUID.
 * @param {HTMLElement} [btn] - Optional close button element to debounce.
 */
async function closePairPosition(tradeId, btn) {
    if (!state.currentUser) {
        openAuthModal();
        return;
    }

    // ── Debounce guard ────────────────────────────────────────────────────
    const _guardKey = `pair_${tradeId}`;
    if (_closingInProgress.has(_guardKey)) return;
    _closingInProgress.add(_guardKey);
    const _origBtnText = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Closing...'; }

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

        await Promise.all([loadPositions(), loadIndexPositions(), loadUserProfile()]);
        await new Promise(r => setTimeout(r, 400));
        await loadUserTrades();
        updateUIForLoggedInUser();
        if (typeof checkAndNotifyNewBadges === 'function') checkAndNotifyNewBadges();
        if (typeof checkSharePrompt === 'function') checkSharePrompt();

    } catch (error) {
        console.error('Close pair position error:', error);
        showToast('Error', error.message, true);
    } finally {
        // ── Always re-enable the button and clear the guard ──────────────
        _closingInProgress.delete(_guardKey);
        if (btn) { btn.disabled = false; btn.textContent = _origBtnText || 'Close'; }
    }
}
