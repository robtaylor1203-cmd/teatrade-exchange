/**
 * TeaTrade Exchange - Init Orchestrator (app.js)
 * ===============================================
 * Application bootstrap: DOMContentLoaded handler, periodic refresh
 * intervals, and data-loading functions that don't belong to any
 * single domain module.
 *
 * This file contains NO business logic — only initialization wiring
 * and the thin data-fetch → state-store → UI-refresh pipelines.
 *
 * Globals used from config.js     : state, defaultDbIndexes
 * Globals used from api.js        : apiFetchTeas, apiFetchIndexes,
 *     apiFetchIndexPairs, apiFetchOrigins, apiFetchTeaPairs,
 *     apiFetchLeaderboard
 * Globals used from auth.js       : checkAuthState
 * Globals used from market.js     : initializePriceCache, startTickerSubscription,
 *     loadMarketState, updateAllMarketIndexes, updateMainChartWithRealData
 * Globals used from charts.js     : drawChart, resizeCanvas, setupRSIHover
 * Globals used from search.js     : initCommandLine
 * Globals used from ui.js         : populateTeaSelect, updateAuctionTable,
 *     updateQuoteBoard, updateWatchlistTeas, initQuoteBoard,
 *     updateMarketDepth, updateMacroIndicators, populateHubTeaSelects,
 *     adjustViewportScale
 * Globals used from portfolio.js  : loadPositions, updatePortfolioDisplay,
 *     loadLeaderboard, loadUserTrades
 * Globals used from chat.js       : initChat
 */

// =============================================
// DATA LOADING FUNCTIONS
// =============================================

/**
 * Fetch all teas from the database, store in state, and refresh every
 * UI surface that depends on tea data.
 */
async function loadTeas() {
    try {
        const [teaResult, openPrices] = await Promise.all([
            apiFetchTeas(),
            apiFetchTodayOpenPrices()
        ]);
        const { data, error } = teaResult;
        if (error) throw error;

        data.forEach(tea => {
            if (openPrices[tea.symbol]) {
                tea.previous_price = openPrices[tea.symbol];
            } else if (!tea.previous_price || tea.previous_price <= 0) {
                tea.previous_price = tea.current_price;
            }
        });

        state.teas = data;

        populateTeaSelect();
        updateAuctionTable();
        updatePairsTable();
        updatePortfolioDisplay();
        updateQuoteBoard();
        updateWatchlistTeas();
        populateHubTeaSelects();
        updateAllMarketIndexes();
        updateMainChartWithRealData();
    } catch (error) {
        console.error('Failed to load teas:', error);
    }
}

/**
 * Fetch index definitions from the database and store in state.
 * Falls back to `defaultDbIndexes` from config.js on error.
 */
async function loadIndexes() {
    try {
        const { data, error } = await apiFetchIndexes();
        if (error) throw error;
        state.dbIndexes = (data || []).map(row => ({
            ...row,
            forexKey: row.forex_key || row.forexKey || null,
        }));
    } catch (error) {
        console.error('Failed to load indexes:', error);
        state.dbIndexes = defaultDbIndexes;
    }
}

/**
 * Fetch index pair definitions and store in state.
 */
async function loadIndexPairs() {
    try {
        const { data, error } = await apiFetchIndexPairs();
        if (error) throw error;
        state.indexPairs = (data || []).map(p => ({ ...p, isIndex: true }));
    } catch (error) {
        console.error('Failed to load index pairs:', error);
        state.indexPairs = [
            // Country vs Country
            { id: 'idx-kenya-india',     base_symbol: 'KENYA',      quote_symbol: 'INDIA',      isIndex: true },
            { id: 'idx-kenya-ceylon',    base_symbol: 'KENYA',      quote_symbol: 'CEYLON',     isIndex: true },
            { id: 'idx-india-ceylon',    base_symbol: 'INDIA',      quote_symbol: 'CEYLON',     isIndex: true },
            { id: 'idx-indo-bangla',     base_symbol: 'INDONESIA',  quote_symbol: 'BANGLADESH', isIndex: true },
            { id: 'idx-africa-asia',     base_symbol: 'AFRICA',     quote_symbol: 'ASIA',       isIndex: true },
            // Auction Centre Cross-Region
            { id: 'idx-mom-col',         base_symbol: 'MOMBASA',    quote_symbol: 'COLOMBO',    isIndex: true },
            { id: 'idx-mom-kol',         base_symbol: 'MOMBASA',    quote_symbol: 'KOLKATA',    isIndex: true },
            { id: 'idx-kol-col',         base_symbol: 'KOLKATA',    quote_symbol: 'COLOMBO',    isIndex: true },
            { id: 'idx-kol-guw',         base_symbol: 'KOLKATA',    quote_symbol: 'GUWAHATI',   isIndex: true },
            { id: 'idx-col-jak',         base_symbol: 'COLOMBO',    quote_symbol: 'JAKARTA',    isIndex: true },
            { id: 'idx-chi-jak',         base_symbol: 'CHITTAGONG', quote_symbol: 'JAKARTA',    isIndex: true },
            { id: 'idx-guw-jal',         base_symbol: 'GUWAHATI',   quote_symbol: 'JALPAIGURI', isIndex: true },
            { id: 'idx-coc-cmb',         base_symbol: 'COCHIN',     quote_symbol: 'COIMBATORE', isIndex: true },
            { id: 'idx-sil-coo',         base_symbol: 'SILIGURI',   quote_symbol: 'COONOOR',    isIndex: true },
            { id: 'idx-lim-mom',         base_symbol: 'LIMBE',      quote_symbol: 'MOMBASA',    isIndex: true },
            // Composite
            { id: 'idx-fut-africa',      base_symbol: 'FUTURES',    quote_symbol: 'AFRICA',     isIndex: true },
            { id: 'idx-fut-asia',        base_symbol: 'FUTURES',    quote_symbol: 'ASIA',       isIndex: true },
            { id: 'idx-fut-kenya',       base_symbol: 'FUTURES',    quote_symbol: 'KENYA',      isIndex: true },
            { id: 'idx-fut-india',       base_symbol: 'FUTURES',    quote_symbol: 'INDIA',      isIndex: true },
        ];
    }
}

/**
 * Fetch origin/region definitions and build the `state.originNames` lookup.
 */
async function loadOrigins() {
    try {
        const { data, error } = await apiFetchOrigins();
        if (error) throw error;
        state.originNames = {};
        (data || []).forEach(o => { state.originNames[o.code] = o.name; });
    } catch (error) {
        console.error('Failed to load origins:', error);
        state.originNames = {
            KEN: 'Kenya', IND: 'India', SRI: 'Sri Lanka',
            IDN: 'Indonesia', BGD: 'Bangladesh', MLW: 'Malawi',
            RWA: 'Rwanda'
        };
    }
}

// =============================================
// BOOTSTRAP — DOMContentLoaded
// =============================================

document.addEventListener('DOMContentLoaded', async () => {
    // Handle Stripe checkout return before anything else
    if (typeof handleCheckoutReturn === 'function') handleCheckoutReturn();

    // ── Phase 1: Auth (everything depends on this) ──
    await checkAuthState();

    // Hydrate tea watchlist from localStorage
    try { state.teaWatchlist = JSON.parse(localStorage.getItem('tt_tea_watchlist')) || []; }
    catch { state.teaWatchlist = []; }

    // ── Phase 2: All reference data in parallel ──
    await Promise.all([
        loadIndexes(),
        loadIndexPairs(),
        loadOrigins(),
        loadTeas(),
    ]);

    // ── Phase 3: Price cache + market data in parallel ──
    // initializePriceCache needs teas + indexes (loaded above).
    // Market state/pressure are independent — run everything together.
    const priceCachePromise = initializePriceCache();
    Promise.allSettled([
        loadMarketState(),
        loadMarketPressure(),
    ]);

    // ── Phase 4: Immediate UI paint (no await — use data already in state) ──
    startLiveForexFeed();
    startTickerSubscription();
    initCommandLine();
    initQuoteBoard();
    resizeCanvas();
    drawChart();

    // ── Phase 5: Non-critical data — fire and forget ──
    Promise.allSettled([
        loadLeaderboard(),
        loadTeaPairs(),
        loadUserTrades(),
    ]);
    loadTopTraders();
    setTimeout(() => { initChat(); }, 1000);

    if (state.currentUser && typeof _ensureTradeNotificationChannel === 'function') {
        _ensureTradeNotificationChannel();
        _buildNotifyProfileCache();
    }

    // ── Phase 6: Responsive handlers ──
    window.addEventListener('resize', () => {
        resizeCanvas();
        adjustViewportScale();
    });
    adjustViewportScale();
    setupRSIHover();

    // Reconnect Realtime channels when network recovers or tab regains focus
    window.addEventListener('online', () => {
        console.log('[Network] Back online - reconnecting Realtime channels');
        reconnectAllChannels();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            console.log('[Visibility] Tab visible - checking Realtime channels');
            reconnectAllChannels();
        }
    });

    // Wait for price cache in background (sparklines fill in as data arrives)
    priceCachePromise.catch(e => console.warn('Price cache init error:', e));
});

// =============================================
// PERIODIC REFRESH INTERVALS
// =============================================

// Market depth uses real bid/ask data from state (no simulation)
setInterval(updateMarketDepth, 5000);

// Quote board re-renders from state.teas (prices arrive via Realtime)
setInterval(updateQuoteBoard, 5000);

// Periodic data refresh — fallback in case Realtime misses events
setInterval(async () => {
    await loadTeas();
    if (state.currentUser) {
        await Promise.all([loadPositions(), loadUserProfile()]);
        updatePortfolioDisplay();
        if (typeof updateCombineBanner === 'function') updateCombineBanner();
    }
    await loadLeaderboard();
    loadTopTraders();
}, 60000);
