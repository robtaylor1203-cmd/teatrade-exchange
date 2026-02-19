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
        const { data, error } = await apiFetchTeas();
        if (error) throw error;

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
        state.dbIndexes = data || [];
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
            { id: 'idx-kenya-india',   base_symbol: 'KENYA',  quote_symbol: 'INDIA',  isIndex: true },
            { id: 'idx-india-ceylon',  base_symbol: 'INDIA',  quote_symbol: 'CEYLON', isIndex: true },
            { id: 'idx-africa-asia',   base_symbol: 'AFRICA', quote_symbol: 'ASIA',   isIndex: true },
            { id: 'idx-kenya-ceylon',  base_symbol: 'KENYA',  quote_symbol: 'CEYLON', isIndex: true },
            { id: 'idx-china-india',   base_symbol: 'CHINA',  quote_symbol: 'INDIA',  isIndex: true },
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
            CHN: 'China', JPN: 'Japan', MLW: 'Malawi', RWA: 'Rwanda'
        };
    }
}

// =============================================
// BOOTSTRAP — DOMContentLoaded
// =============================================

document.addEventListener('DOMContentLoaded', async () => {
    // Auth first
    await checkAuthState();

    // Load reference data from Supabase (indexes, origins, pairs)
    await loadIndexes();
    await loadIndexPairs();
    await loadOrigins();

    // Load teas (triggers all dependent UI refreshes)
    await loadTeas();

    // Unified price cache from database
    await initializePriceCache();

    // Load initial macro indicator values from DB (Brent crude, last cron tick)
    await loadMarketState();

    // Start the browser-direct live forex feed (fetches open.er-api.com every 60s,
    // completely independent of the server cron — macros are always live).
    startLiveForexFeed();

    // Seed order-flow depth from DB before Realtime events arrive
    await loadMarketPressure();

    // Start Realtime subscriptions (prices + macro + order flow)
    startTickerSubscription();

    // Command line / universal search
    initCommandLine();

    // Quote board initial paint
    initQuoteBoard();

    // Chat (slight delay to let DOM settle)
    setTimeout(() => { initChat(); }, 1000);

    // Leaderboard & tea pairs
    await loadLeaderboard();
    await loadTeaPairs();

    // User data
    await loadUserTrades();

    // Canvas sizing + initial draw
    resizeCanvas();
    drawChart();

    // Responsive handlers
    window.addEventListener('resize', () => {
        resizeCanvas();
        adjustViewportScale();
    });

    adjustViewportScale();

    // RSI hover interactivity
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
        await loadPositions();
        updatePortfolioDisplay();
    }
    await loadLeaderboard();
}, 60000);
