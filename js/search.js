/**
 * TeaTrade Exchange - Command Line / Universal Search (search.js)
 * ===============================================================
 * The universal search bar (Ctrl+K or /) that searches teas, indexes,
 * pairs, and commands.  Also contains helpers for switching the main
 * chart to a tea or index and launching quick-trade actions.
 *
 * Globals used from config.js     : state, isIndexSymbol
 * Globals used from market.js     : calculateRegionalIndexes,
 *     getPriceHistorySync
 * Globals used from charts.js     : drawChart
 * Globals used from quoteModal.js : openQuickQuoteModal
 * Globals used from trading.js    : setTradeType, updateTradeSummary
 * Globals used from ui.js         : selectTeaForTrading, switchWatchlistTab
 * Globals used from portfolio.js  : switchPortfolioTab
 * Globals used from hub.js        : toggleMaximize
 * Globals used from auth.js       : openAuthModal
 * Globals used from utils.js      : showToast
 *
 * Functions called from other files (available at runtime as globals):
 *   openPairsModal
 */

// =============================================
// COMMAND ALIASES
// =============================================

const commandAliases = {
    'NEWS':      { action: 'scrollTo',      target: 'news',    desc: 'Jump to News' },
    'CHART':     { action: 'scrollTo',      target: 'chart',   desc: 'Jump to Chart' },
    'ORDERS':    { action: 'scrollTo',      target: 'orders',  desc: 'View Orders' },
    'PORTFOLIO': { action: 'showPortfolio',                     desc: 'Show Portfolio' },
    'HISTORY':   { action: 'showHistory',                       desc: 'Trade History' },
    'PAIRS':     { action: 'showPairs',                         desc: 'View Tea Pairs' },
    'SINGLES':   { action: 'showSingles',                       desc: 'View Single Teas' },
    'MAX':       { action: 'maximizeChart',                     desc: 'Maximize Chart' },
    'CLEAR':     { action: 'clearCommand',                      desc: 'Clear Input' },
};

// =============================================
// INIT COMMAND LINE
// =============================================

function initCommandLine() {
    const input = document.getElementById('command-line');
    const suggestions = document.getElementById('command-suggestions');

    if (!input) return;

    // --- Input handler: build live search results ---
    input.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        const valUpper = val.toUpperCase();

        if (val.length === 0) {
            suggestions.classList.remove('active');
            return;
        }

        let html = '';

        // Search teas
        const teaMatches = state.teas.filter(tea => {
            const searchStr = `${tea.symbol} ${tea.name || ''} ${tea.grade || ''}`.toUpperCase();
            return searchStr.includes(valUpper);
        }).slice(0, 4);

        if (teaMatches.length > 0) {
            html += '<div class="search-category">Teas</div>';
            teaMatches.forEach(tea => {
                const change = tea.previous_price > 0
                    ? ((tea.current_price - tea.previous_price) / tea.previous_price) * 100
                    : 0;
                const changeClass = change >= 0 ? 'up' : 'down';
                const changeStr = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
                const shortSymbol = tea.symbol.split('-')[1] || tea.symbol;
                const origin = tea.symbol.split('-')[0] || '';

                html += `
                    <div class="command-suggestion" data-type="tea" data-symbol="${escapeHtml(tea.symbol)}">
                        <div class="search-result-info">
                            <span class="search-result-symbol"><span class="origin">${escapeHtml(origin)}</span> ${escapeHtml(shortSymbol)}</span>
                            <span class="search-result-name">${escapeHtml(tea.name || tea.symbol)}</span>
                        </div>
                        <span class="search-result-price ${changeClass}">$${tea.current_price.toFixed(2)} <small>${changeStr}</small></span>
                        <div class="search-result-actions">
                            <button class="search-action-btn chart" onclick="event.stopPropagation(); openTeaChart('${escapeHtml(tea.symbol)}')">Chart</button>
                            <button class="search-action-btn buy" onclick="event.stopPropagation(); quickTrade('${escapeHtml(tea.symbol)}', 'BUY')">Buy</button>
                            <button class="search-action-btn sell" onclick="event.stopPropagation(); quickTrade('${escapeHtml(tea.symbol)}', 'SELL')">Sell</button>
                        </div>
                    </div>
                `;
            });
        }

        // Search indexes
        const indexes = calculateRegionalIndexes();
        const indexMatches = indexes.filter(idx =>
            idx.symbol.includes(valUpper) || idx.name.toUpperCase().includes(valUpper)
        ).slice(0, 3);

        if (indexMatches.length > 0) {
            html += '<div class="search-category">Indexes</div>';
            indexMatches.forEach(idx => {
                const changeClass = idx.change >= 0 ? 'up' : 'down';
                const changeStr = `${idx.change >= 0 ? '+' : ''}${idx.change.toFixed(2)}%`;

                html += `
                    <div class="command-suggestion" data-type="index" data-symbol="${escapeHtml(idx.symbol)}">
                        <div class="search-result-info">
                            <span class="search-result-symbol" style="color: ${escapeHtml(idx.color)};">${escapeHtml(idx.symbol)}</span>
                            <span class="search-result-name">${escapeHtml(idx.name)}</span>
                        </div>
                        <span class="search-result-price ${changeClass}">$${idx.price.toFixed(2)} <small>${changeStr}</small></span>
                        <div class="search-result-actions">
                            <button class="search-action-btn chart" onclick="event.stopPropagation(); openIndexChart('${escapeHtml(idx.symbol)}')">Chart</button>
                        </div>
                    </div>
                `;
            });
        }

        // Search pairs
        if (state.teaPairs.length > 0) {
            const pairMatches = state.teaPairs.filter(pair => {
                const pairStr = `${pair.base_symbol}/${pair.quote_symbol}`.toUpperCase();
                return pairStr.includes(valUpper);
            }).slice(0, 3);

            if (pairMatches.length > 0) {
                html += '<div class="search-category">Pairs</div>';
                pairMatches.forEach(pair => {
                    const baseShort = pair.base_symbol.split('-')[1] || pair.base_symbol;
                    const quoteShort = pair.quote_symbol.split('-')[1] || pair.quote_symbol;

                    html += `
                        <div class="command-suggestion" data-type="pair" data-id="${escapeHtml(String(pair.id))}">
                            <div class="search-result-info">
                                <span class="search-result-symbol"><span style="color: var(--accent-green);">${escapeHtml(baseShort)}</span>/<span style="color: var(--accent-red);">${escapeHtml(quoteShort)}</span></span>
                                <span class="search-result-name">Tea Pair</span>
                            </div>
                            <div class="search-result-actions">
                                <button class="search-action-btn buy" onclick="event.stopPropagation(); openPairsModal('${escapeHtml(String(pair.id))}', 'LONG')">Long</button>
                                <button class="search-action-btn sell" onclick="event.stopPropagation(); openPairsModal('${escapeHtml(String(pair.id))}', 'SHORT')">Short</button>
                            </div>
                        </div>
                    `;
                });
            }
        }

        // Search commands
        const cmdMatches = Object.entries(commandAliases)
            .filter(([key]) => key.includes(valUpper))
            .slice(0, 3);

        if (cmdMatches.length > 0) {
            html += '<div class="search-category">Commands</div>';
            cmdMatches.forEach(([key, data]) => {
                html += `
                    <div class="command-suggestion" data-type="command" data-cmd="${key}">
                        <span class="command-suggestion-cmd">${key}</span>
                        <span class="command-suggestion-desc">${data.desc}</span>
                    </div>
                `;
            });
        }

        if (html) {
            suggestions.innerHTML = html;
            suggestions.classList.add('active');
        } else {
            suggestions.innerHTML = '<div class="search-category">No results found</div>';
            suggestions.classList.add('active');
        }
    });

    // --- Enter / Escape ---
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const firstResult = suggestions.querySelector('.command-suggestion');
            if (firstResult) {
                handleSearchResult(firstResult);
            }
            input.value = '';
            suggestions.classList.remove('active');
        } else if (e.key === 'Escape') {
            input.value = '';
            suggestions.classList.remove('active');
            input.blur();
        }
    });

    // --- Click on suggestion ---
    suggestions.addEventListener('click', (e) => {
        const item = e.target.closest('.command-suggestion');
        if (item) {
            handleSearchResult(item);
            input.value = '';
            suggestions.classList.remove('active');
        }
    });

    // --- Close on click outside ---
    document.addEventListener('click', (e) => {
        const commandWrapper = input.closest('.command-line-wrapper');
        if (commandWrapper && !commandWrapper.contains(e.target)) {
            suggestions.classList.remove('active');
        }
    });

    // --- Close on blur (short delay for click propagation) ---
    input.addEventListener('blur', () => {
        setTimeout(() => {
            suggestions.classList.remove('active');
        }, 150);
    });

    // --- Global keyboard shortcut: "/" to focus search ---
    document.addEventListener('keydown', (e) => {
        if (e.key === '/' && !e.ctrlKey && !e.metaKey && document.activeElement !== input) {
            e.preventDefault();
            input.focus();
        }
    });
}

// =============================================
// SEARCH RESULT DISPATCHER
// =============================================

function handleSearchResult(item) {
    const type = item.dataset.type;

    switch (type) {
        case 'tea':
            openTeaChart(item.dataset.symbol);
            break;
        case 'index':
            openIndexChart(item.dataset.symbol);
            break;
        case 'pair':
            openPairsModal(item.dataset.id, 'LONG');
            break;
        case 'command':
            executeCommand(item.dataset.cmd);
            break;
    }
}

// =============================================
// OPEN TEA CHART (Quick Quote Modal)
// =============================================

function openTeaChart(symbol) {
    const tea = state.teas.find(t => t.symbol === symbol);
    if (!tea) {
        showToast('Tea Not Found', 'Could not find tea data', true);
        return;
    }

    openQuickQuoteModal(tea);
}

// =============================================
// SWITCH MAIN CHART TO A TEA
// =============================================

function switchToTea(symbol) {
    const tea = state.teas.find(t => t.symbol === symbol);
    if (!tea) return;

    const shortSymbol = symbol.split('-')[1] || symbol;
    const origin = symbol.split('-')[0] || '';
    const change = tea.previous_price > 0
        ? ((tea.current_price - tea.previous_price) / tea.previous_price) * 100
        : 0;

    const chartSection = document.getElementById('chart-section');
    chartSection.style.opacity = '0.7';
    chartSection.style.transform = 'scale(0.98)';

    setTimeout(() => {
        state.mainChartData = {
            name: tea.name || `${origin} ${shortSymbol}`,
            symbol: symbol,
            basePrice: tea.current_price,
            currency: '$',
            change: change,
            volume: '12.5K MT',
            isTea: true
        };

        document.getElementById('main-chart-title').textContent = state.mainChartData.name;
        const priceEl = document.getElementById('main-chart-price');
        priceEl.textContent = `$${tea.current_price.toFixed(2)}`;
        priceEl.className = 'chart-stat-value ' + (change >= 0 ? 'up' : 'down');

        const changeEl = document.getElementById('main-chart-change');
        changeEl.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
        changeEl.style.color = change >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';

        state.cachedTimeframe = null;
        if (window.mainYAxisCache) window.mainYAxisCache = {};
        state.chartData = getPriceHistorySync(tea.symbol, 'tea');
        drawChart();

        chartSection.style.opacity = '1';
        chartSection.style.transform = 'scale(1)';

        showToast('Chart Updated', `Now viewing ${state.mainChartData.name}`);
    }, 150);
}

// =============================================
// OPEN INDEX CHART (switch main chart to index)
// =============================================

function openIndexChart(indexSymbol) {
    const indexes = calculateRegionalIndexes();
    const idx = indexes.find(i => i.symbol === indexSymbol);

    if (!idx) {
        showToast('Index Not Found', 'Could not find index data', true);
        return;
    }

    const chartSection = document.getElementById('chart-section');
    chartSection.style.opacity = '0.7';
    chartSection.style.transform = 'scale(0.98)';

    setTimeout(() => {
        state.mainChartData = {
            name: idx.name,
            symbol: idx.symbol,
            basePrice: idx.price,
            currency: '$',
            change: idx.change,
            volume: '\u2014',
            isIndex: true
        };

        document.getElementById('main-chart-title').textContent = state.mainChartData.name;
        const priceEl = document.getElementById('main-chart-price');
        priceEl.textContent = `$${idx.price.toFixed(2)}`;
        priceEl.className = 'chart-stat-value ' + (idx.change >= 0 ? 'up' : 'down');

        const idxChangeEl = document.getElementById('main-chart-change');
        idxChangeEl.textContent = `${idx.change >= 0 ? '+' : ''}${idx.change.toFixed(2)}%`;
        idxChangeEl.style.color = idx.change >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';

        state.cachedTimeframe = null;
        if (window.mainYAxisCache) window.mainYAxisCache = {};
        state.chartData = getPriceHistorySync(idx.symbol, 'index');
        drawChart();

        chartSection.style.opacity = '1';
        chartSection.style.transform = 'scale(1)';

        showToast('Index Chart', `Now viewing ${idx.name}`);
    }, 150);

    document.getElementById('chart-section')?.scrollIntoView({ behavior: 'smooth' });
}

// =============================================
// QUICK TRADE FROM SEARCH
// =============================================

function quickTrade(symbol, side) {
    if (!state.currentUser) {
        showToast('Login Required', 'Please sign in to trade', true);
        openAuthModal();
        return;
    }

    const tea = state.teas.find(t => t.symbol === symbol);
    if (!tea) return;

    const teaSelect = document.getElementById('trade-tea-select');
    if (teaSelect) {
        teaSelect.value = tea.id;
    }

    setTradeType(side);
    updateTradeSummary();

    document.querySelector('.trade-panel')?.scrollIntoView({ behavior: 'smooth' });

    showToast('Trade Ready', `${side} ${tea.name || symbol}`);
}

// =============================================
// EXECUTE COMMAND
// =============================================

function executeCommand(cmd) {
    const parts = cmd.toUpperCase().trim().split(' ');
    const command = parts[0];
    const arg = parts[1];

    // BUY / SELL shorthand
    if (command === 'BUY' || command === 'SELL') {
        const qty = parseInt(arg) || 100;
        const selectedTea = document.getElementById('trade-tea-select')?.value;
        if (selectedTea) {
            document.getElementById('trade-qty').value = qty;
            setTradeType(command);
            updateTradeSummary();
            showToast('Trade Ready', `${command} ${qty} kg of ${selectedTea}`);
        } else {
            showToast('Select a tea first', 'Click on a tea in Quick Quotes', true);
        }
        return;
    }

    // Named command aliases
    const alias = commandAliases[command];
    if (alias) {
        switch (alias.action) {
            case 'selectTea': {
                const tea = state.teas.find(t => t.symbol === alias.symbol);
                if (tea) {
                    selectTeaForTrading(tea.symbol);
                    showToast('Selected', alias.desc);
                }
                break;
            }
            case 'scrollTo':
                if (alias.target === 'chart') {
                    document.getElementById('chart-section')?.scrollIntoView({ behavior: 'smooth' });
                } else if (alias.target === 'orders') {
                    document.getElementById('orders-section')?.scrollIntoView({ behavior: 'smooth' });
                }
                break;
            case 'showPortfolio':
                document.getElementById('portfolio-section').style.display = 'block';
                switchPortfolioTab('positions');
                break;
            case 'showHistory':
                document.getElementById('portfolio-section').style.display = 'block';
                switchPortfolioTab('history');
                break;
            case 'showMacro':
                switchWatchlistTab('macro');
                break;
            case 'setTradeType':
                setTradeType(alias.type);
                break;
            case 'maximizeChart':
                toggleMaximize('chart-section');
                break;
            case 'clearCommand':
                break;
        }
    } else {
        // Fallback: fuzzy-match tea by symbol or name
        const foundTea = state.teas.find(t =>
            t.symbol.toUpperCase().includes(command) ||
            t.name.toUpperCase().includes(command)
        );
        if (foundTea) {
            selectTeaForTrading(foundTea.symbol);
            showToast('Selected', foundTea.name);
        }
    }
}
