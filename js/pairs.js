/**
 * TeaTrade Exchange - Pairs Trading System (pairs.js)
 * ====================================================
 * Pairs trading interface: tea pairs, index pairs, modal, leverage,
 * trade execution, and table rendering with sorting.
 *
 * Globals used from config.js : state, isIndexSymbol
 * Globals used from api.js   : apiFetchTeaPairs, apiOpenPairTrade
 * Globals used from market.js: calculateRegionalIndexes
 * Globals used from utils.js : showToast
 *
 * Functions called from other modules (available at runtime as globals):
 *   loadUserTrades, loadPositions, updatePortfolioDisplay, openAuthModal
 */

// Module-local: tracks previous pair ratios for change/flash calculation
let previousPairRatios = {};

// =============================================
// LOAD TEA PAIRS
// =============================================

async function loadTeaPairs() {
    try {
        const { data, error } = await apiFetchTeaPairs();

        if (error) throw error;
        state.teaPairs = data;
        updatePairsTable();
    } catch (error) {
        console.error('Failed to load pairs:', error);
    }
}

// =============================================
// INDEX PRICE LOOKUP
// =============================================

/**
 * Get the current price info for a regional index symbol.
 * @param {string} indexSymbol - e.g. 'KENYA', 'INDIA'
 * @returns {{ price: number, previousPrice: number, name: string, color: string }|null}
 */
function getIndexPrice(indexSymbol) {
    const indexes = calculateRegionalIndexes();
    const idx = indexes.find(i => i.symbol === indexSymbol);
    return idx ? { price: idx.price, previousPrice: idx.previousPrice, name: idx.name, color: idx.color } : null;
}

// =============================================
// MARKET VIEW TOGGLE
// =============================================

function setMarketView(view) {
    const singlesView = document.getElementById('singles-view');
    const pairsView = document.getElementById('pairs-view');
    const toggleSingles = document.getElementById('toggle-singles');
    const togglePairs = document.getElementById('toggle-pairs');
    const gradeFilters = document.getElementById('grade-filters');

    if (view === 'singles') {
        singlesView.style.display = 'block';
        pairsView.style.display = 'none';
        toggleSingles.classList.add('active');
        togglePairs.classList.remove('active');
        gradeFilters.style.display = 'flex';
    } else {
        singlesView.style.display = 'none';
        pairsView.style.display = 'block';
        toggleSingles.classList.remove('active');
        togglePairs.classList.add('active');
        gradeFilters.style.display = 'none';
        if (state.teaPairs.length === 0) loadTeaPairs();
        updatePairsTable();
    }
}

// =============================================
// PAIRS TABLE SORTING
// =============================================

function sortPairsTable(column) {
    if (state.pairsSortColumn === column) {
        state.pairsSortDirection = state.pairsSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        state.pairsSortColumn = column;
        state.pairsSortDirection = 'asc';
    }

    // Update header classes
    document.querySelectorAll('#pairs-table th.sortable').forEach(th => {
        th.classList.remove('asc', 'desc');
        if (th.dataset.sort === column) {
            th.classList.add(state.pairsSortDirection);
        }
    });

    updatePairsTable();
}

// =============================================
// UPDATE PAIRS TABLE
// =============================================

function updatePairsTable() {
    const tbody = document.getElementById('pairs-table-body');
    if (!tbody || !state.teas.length) return;

    // Build tea price map
    const teaMap = {};
    state.teas.forEach(tea => teaMap[tea.symbol] = tea);

    // Get regional indexes
    const indexes = calculateRegionalIndexes();
    const indexMap = {};
    indexes.forEach(idx => indexMap[idx.symbol] = idx);

    // Build data array from regular tea pairs
    const pairsData = (state.teaPairs || []).map(pair => {
        const baseTea = teaMap[pair.base_symbol];
        const quoteTea = teaMap[pair.quote_symbol];

        if (!baseTea || !quoteTea) return null;

        const basePrice = baseTea.current_price;
        const quotePrice = quoteTea.current_price;
        const ratio = quotePrice > 0 ? basePrice / quotePrice : 0;
        const pairKey = `${pair.base_symbol}/${pair.quote_symbol}`;

        // Calculate change from previous ratio
        let changePct = 0;
        let changeStr = '\u2014';
        let changeClass = '';
        let flashClass = '';

        if (previousPairRatios[pairKey] !== undefined) {
            const prevRatio = previousPairRatios[pairKey];
            if (prevRatio !== ratio) {
                changePct = ((ratio - prevRatio) / prevRatio) * 100;
                changeStr = `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`;
                changeClass = changePct > 0 ? 'up' : 'down';
                flashClass = changePct > 0 ? 'flash-up' : 'flash-down';
            }
        }
        previousPairRatios[pairKey] = ratio;

        // Spread (price difference)
        const spread = Math.abs(basePrice - quotePrice);

        // Format symbols for display
        const baseShort = pair.base_symbol.split('-')[1] || pair.base_symbol;
        const quoteShort = pair.quote_symbol.split('-')[1] || pair.quote_symbol;

        return {
            pair, basePrice, quotePrice, ratio, changePct, changeStr, changeClass, flashClass, spread, baseShort, quoteShort, isIndex: false
        };
    }).filter(Boolean);

    // Add index pairs
    state.indexPairs.forEach(pair => {
        const baseIdx = indexMap[pair.base_symbol];
        const quoteIdx = indexMap[pair.quote_symbol];

        if (!baseIdx || !quoteIdx || baseIdx.price === 0 || quoteIdx.price === 0) return;

        const basePrice = baseIdx.price;
        const quotePrice = quoteIdx.price;
        const ratio = quotePrice > 0 ? basePrice / quotePrice : 0;
        const pairKey = `${pair.base_symbol}/${pair.quote_symbol}`;

        let changePct = 0;
        let changeStr = '\u2014';
        let changeClass = '';
        let flashClass = '';

        if (previousPairRatios[pairKey] !== undefined) {
            const prevRatio = previousPairRatios[pairKey];
            if (prevRatio !== ratio) {
                changePct = ((ratio - prevRatio) / prevRatio) * 100;
                changeStr = `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`;
                changeClass = changePct > 0 ? 'up' : 'down';
                flashClass = changePct > 0 ? 'flash-up' : 'flash-down';
            }
        }
        previousPairRatios[pairKey] = ratio;

        const spread = Math.abs(basePrice - quotePrice);

        pairsData.push({
            pair,
            basePrice,
            quotePrice,
            ratio,
            changePct,
            changeStr,
            changeClass,
            flashClass,
            spread,
            baseShort: pair.base_symbol,
            quoteShort: pair.quote_symbol,
            isIndex: true,
            baseColor: baseIdx.color,
            quoteColor: quoteIdx.color
        });
    });

    // Sort the data
    pairsData.sort((a, b) => {
        // Index pairs always at top
        if (a.isIndex !== b.isIndex) {
            return a.isIndex ? -1 : 1;
        }

        let valA, valB;
        switch (state.pairsSortColumn) {
            case 'pair':
                valA = `${a.baseShort}/${a.quoteShort}`;
                valB = `${b.baseShort}/${b.quoteShort}`;
                break;
            case 'base':
                valA = a.basePrice;
                valB = b.basePrice;
                break;
            case 'quote':
                valA = a.quotePrice;
                valB = b.quotePrice;
                break;
            case 'ratio':
                valA = a.ratio;
                valB = b.ratio;
                break;
            case 'change':
                valA = a.changePct;
                valB = b.changePct;
                break;
            case 'spread':
                valA = a.spread;
                valB = b.spread;
                break;
            default:
                valA = a.baseShort;
                valB = b.baseShort;
        }

        if (typeof valA === 'string') {
            return state.pairsSortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
        return state.pairsSortDirection === 'asc' ? valA - valB : valB - valA;
    });

    // Render sorted data
    tbody.innerHTML = pairsData.map(data => {
        const baseStyle = data.isIndex ? `style="color: ${data.baseColor}; font-weight: 700;"` : '';
        const quoteStyle = data.isIndex ? `style="color: ${data.quoteColor}; font-weight: 700;"` : '';
        const rowClass = data.isIndex ? 'index-pair-row' : '';
        const clickHandler = data.isIndex ?
            `onclick="openIndexPairModal('${escapeHtml(String(data.pair.id))}', 'LONG')"` :
            `onclick="openPairsModal('${escapeHtml(String(data.pair.id))}', 'LONG')"`;

        return `
            <tr ${clickHandler} style="cursor: pointer;" class="${rowClass}">
                <td>
                    <span class="pair-symbol">
                        <span class="base" ${baseStyle}>${escapeHtml(data.baseShort)}</span>/<span class="quote" ${quoteStyle}>${escapeHtml(data.quoteShort)}</span>
                        ${data.isIndex ? '<span class="index-badge">IDX</span>' : ''}
                    </span>
                </td>
                <td class="pairs-price ${data.flashClass}">$${data.basePrice.toFixed(2)}</td>
                <td class="pairs-price">$${data.quotePrice.toFixed(2)}</td>
                <td><span class="pair-ratio">${data.ratio.toFixed(4)}</span></td>
                <td class="${data.changeClass}">${data.changeStr}</td>
                <td>$${data.spread.toFixed(2)}</td>
            </tr>
        `;
    }).join('');
}

// =============================================
// INDEX PAIR MODAL
// =============================================

function openIndexPairModal(pairId, side) {
    if (!state.currentUser) {
        showToast('Login Required', 'Please sign in to trade pairs', true);
        return;
    }

    const pair = state.indexPairs.find(p => p.id === pairId);
    if (!pair) {
        showToast('Error', 'Index pair not found', true);
        return;
    }

    const baseIdx = getIndexPrice(pair.base_symbol);
    const quoteIdx = getIndexPrice(pair.quote_symbol);

    if (!baseIdx || !quoteIdx) {
        showToast('Error', 'Index prices not available', true);
        return;
    }

    const ratio = baseIdx.price / quoteIdx.price;

    state.currentPairTrade = {
        pairId,
        pair,
        side,
        baseTea: { current_price: baseIdx.price, symbol: pair.base_symbol },
        quoteTea: { current_price: quoteIdx.price, symbol: pair.quote_symbol },
        ratio,
        baseShort: pair.base_symbol,
        quoteShort: pair.quote_symbol,
        isIndex: true
    };

    // Update modal display
    document.getElementById('pairs-modal-title').textContent = `${side} ${pair.base_symbol}/${pair.quote_symbol}`;
    document.getElementById('modal-pair-display').innerHTML =
        `<span class="base" style="color: ${baseIdx.color};">${escapeHtml(pair.base_symbol)}</span>/<span class="quote" style="color: ${quoteIdx.color};">${escapeHtml(pair.quote_symbol)}</span>`;
    document.getElementById('modal-ratio-display').textContent = `Ratio: ${ratio.toFixed(4)}`;

    setLeverage(1);
    setPairsSide(side);
    updatePairsSummary();
    document.getElementById('pairs-modal').classList.add('active');
}

// =============================================
// TEA PAIR MODAL
// =============================================

function openPairsModal(pairId, side) {
    if (!state.currentUser) {
        showToast('Login Required', 'Please sign in to trade pairs', true);
        return;
    }

    const pair = state.teaPairs.find(p => p.id === pairId);
    if (!pair) {
        showToast('Error', 'Pair not found. Please refresh the page.', true);
        return;
    }

    const teaMap = {};
    state.teas.forEach(tea => teaMap[tea.symbol] = tea);

    const baseTea = teaMap[pair.base_symbol];
    const quoteTea = teaMap[pair.quote_symbol];
    if (!baseTea || !quoteTea) {
        showToast('Error', 'Tea prices not available. Please refresh.', true);
        return;
    }

    const ratio = baseTea.current_price / quoteTea.current_price;
    const baseShort = pair.base_symbol.split('-')[1] || pair.base_symbol;
    const quoteShort = pair.quote_symbol.split('-')[1] || pair.quote_symbol;

    state.currentPairTrade = {
        pairId,
        pair,
        side,
        baseTea,
        quoteTea,
        ratio,
        baseShort,
        quoteShort
    };

    // Update modal display
    document.getElementById('pairs-modal-title').textContent = `${side} ${baseShort}/${quoteShort}`;
    document.getElementById('modal-pair-display').innerHTML =
        `<span class="base">${escapeHtml(baseShort)}</span>/<span class="quote">${escapeHtml(quoteShort)}</span>`;
    document.getElementById('modal-ratio-display').textContent = `Ratio: ${ratio.toFixed(4)}`;

    // Reset leverage
    setLeverage(1);

    // Set initial side
    setPairsSide(side);

    updatePairsSummary();
    document.getElementById('pairs-modal').classList.add('active');
}

// =============================================
// MODAL CONTROLS
// =============================================

function closePairsModal() {
    document.getElementById('pairs-modal').classList.remove('active');
    state.currentPairTrade = null;
}

function setLeverage(lev) {
    state.selectedLeverage = lev;
    document.querySelectorAll('.leverage-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.leverage) === lev);
    });
    updatePairsSummary();
}

function setPairsSide(side) {
    if (!state.currentPairTrade) return;

    state.currentPairTrade.side = side;

    // Update side buttons
    document.querySelectorAll('.side-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.side === side);
    });

    // Update modal title and confirm button
    const { baseShort, quoteShort } = state.currentPairTrade;
    document.getElementById('pairs-modal-title').textContent = `${side} ${baseShort}/${quoteShort}`;

    const confirmBtn = document.getElementById('pairs-confirm-btn');
    confirmBtn.className = `confirm-btn ${side.toLowerCase()}`;
    confirmBtn.textContent = `${side} ${baseShort}/${quoteShort}`;
}

function updatePairsSummary() {
    const amount = parseFloat(document.getElementById('pairs-amount').value) || 0;
    const exposure = amount * state.selectedLeverage;

    document.getElementById('summary-size').textContent = `$${amount.toFixed(2)}`;
    document.getElementById('summary-leverage').textContent = `${state.selectedLeverage}x`;
    document.getElementById('summary-exposure').textContent = `$${exposure.toFixed(2)}`;
    document.getElementById('summary-ratio').textContent = state.currentPairTrade ?
        state.currentPairTrade.ratio.toFixed(4) : '\u2014';
}

// =============================================
// EXECUTE PAIR TRADE
// =============================================

async function executePairTrade() {
    if (!state.currentPairTrade || !state.currentUser) {
        showToast('Error', 'Trade data not available. Please try again.', true);
        return;
    }

    if (!state.currentPairTrade.side) {
        showToast('Error', 'Invalid trade direction. Please reopen the trade modal.', true);
        return;
    }

    const amount = parseFloat(document.getElementById('pairs-amount').value);
    if (!amount || amount < 10) {
        showToast('Invalid Amount', 'Minimum position size is $10', true);
        return;
    }

    if (amount > getActiveBalance()) {
        showToast('Insufficient Funds', 'Not enough cash balance', true);
        return;
    }

    try {
        // C4 FIX: Server-side atomic pair trade opening
        let teaId = null;
        let indexSymbol = null;

        if (state.currentPairTrade.isIndex) {
            const indexes = typeof calculateRegionalIndexes === 'function' ? calculateRegionalIndexes() : [];
            const baseIndex = indexes.find(i => i.symbol === state.currentPairTrade.baseTea.symbol);
            const underlyingTea = baseIndex ? state.teas?.find(t => baseIndex.teas?.includes(t.symbol)) : null;
            teaId = underlyingTea?.id || null;
            indexSymbol = `${state.currentPairTrade.baseTea.symbol}/${state.currentPairTrade.quoteTea.symbol}`;
        } else {
            teaId = state.currentPairTrade.baseTea.id;
        }

        const result = await apiOpenPairTrade({
            side: state.currentPairTrade.side,
            amount: amount,
            ratio: state.currentPairTrade.ratio,
            leverage: state.selectedLeverage,
            pair_id: state.currentPairTrade.isIndex ? null : state.currentPairTrade.pairId,
            tea_id: teaId,
            index_symbol: indexSymbol
        });

        if (!result.success) {
            throw new Error(result.error || 'Pair trade failed');
        }

        setActiveBalance(result.new_balance);

        // Save values before closing modal (which nulls currentPairTrade)
        const tradeInfo = {
            side: state.currentPairTrade.side,
            baseShort: state.currentPairTrade.baseShort,
            quoteShort: state.currentPairTrade.quoteShort,
            ratio: state.currentPairTrade.ratio
        };

        closePairsModal();

        const exposure = amount * state.selectedLeverage;
        showToast('Pair Trade Executed!',
            `${tradeInfo.side} ${tradeInfo.baseShort}/${tradeInfo.quoteShort} @ ${tradeInfo.ratio.toFixed(4)} with ${state.selectedLeverage}x leverage ($${exposure.toFixed(2)} exposure)`);

        await loadUserTrades();
        await loadPositions();
        updatePortfolioDisplay();

    } catch (error) {
        console.error('Pair trade failed:', error);
        showToast('Trade Failed', error.message, true);
    }
}
