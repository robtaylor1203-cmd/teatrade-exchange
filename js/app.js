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
// LOCAL STORAGE CACHE (instant hydration for return visitors)
// =============================================

const TT_CACHE_TEAS = 'tt_cache_teas';
const TT_CACHE_INDEXES = 'tt_cache_indexes';
const TT_CACHE_TTL = 300000; // 5 min

function _writeCache(key, data) {
    try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), d: data })); } catch { }
}

function _readCache(key) {
    try {
        var raw = JSON.parse(localStorage.getItem(key));
        if (raw && raw.d && (Date.now() - raw.ts < TT_CACHE_TTL)) return raw.d;
    } catch { }
    return null;
}

function _refreshTeaUI() {
    populateTeaSelect();
    updateAuctionTable();
    updatePairsTable();
    updatePortfolioDisplay();
    updateQuoteBoard();
    updateWatchlistTeas();
    populateHubTeaSelects();
    updateAllMarketIndexes();
    updateMainChartWithRealData();
}

// =============================================
// DATA LOADING FUNCTIONS
// =============================================

/**
 * Fetch all teas from the database, store in state, and refresh every
 * UI surface that depends on tea data.
 * Optimistic: renders from localStorage cache before the fetch completes.
 */
async function loadTeas() {
    var cached = _readCache(TT_CACHE_TEAS);
    if (cached && cached.length > 0 && state.teas.length === 0) {
        state.teas = cached;
        _refreshTeaUI();
    }

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
        _writeCache(TT_CACHE_TEAS, data);
        _refreshTeaUI();
    } catch (error) {
        console.error('Failed to load teas:', error);
    }
}

/**
 * Fetch index definitions from the database and store in state.
 * Falls back to `defaultDbIndexes` from config.js on error.
 */
async function loadIndexes() {
    if (!state.dbIndexes || state.dbIndexes.length === 0) {
        var cached = _readCache(TT_CACHE_INDEXES);
        if (cached && cached.length > 0) state.dbIndexes = cached;
    }

    try {
        const { data, error } = await apiFetchIndexes();
        if (error) throw error;
        state.dbIndexes = (data || []).map(row => ({
            ...row,
            forexKey: row.forex_key || row.forexKey || null,
        }));
        _writeCache(TT_CACHE_INDEXES, state.dbIndexes);
    } catch (error) {
        console.error('Failed to load indexes:', error);
        if (!state.dbIndexes || state.dbIndexes.length === 0) {
            state.dbIndexes = defaultDbIndexes;
        }
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
            { id: 'idx-kenya-india', base_symbol: 'KENYA', quote_symbol: 'INDIA', isIndex: true },
            { id: 'idx-kenya-ceylon', base_symbol: 'KENYA', quote_symbol: 'CEYLON', isIndex: true },
            { id: 'idx-india-ceylon', base_symbol: 'INDIA', quote_symbol: 'CEYLON', isIndex: true },
            { id: 'idx-indo-bangla', base_symbol: 'INDONESIA', quote_symbol: 'BANGLADESH', isIndex: true },
            { id: 'idx-africa-asia', base_symbol: 'AFRICA', quote_symbol: 'ASIA', isIndex: true },
            // Auction Centre Cross-Region
            { id: 'idx-mom-col', base_symbol: 'MOMBASA', quote_symbol: 'COLOMBO', isIndex: true },
            { id: 'idx-mom-kol', base_symbol: 'MOMBASA', quote_symbol: 'KOLKATA', isIndex: true },
            { id: 'idx-kol-col', base_symbol: 'KOLKATA', quote_symbol: 'COLOMBO', isIndex: true },
            { id: 'idx-kol-guw', base_symbol: 'KOLKATA', quote_symbol: 'GUWAHATI', isIndex: true },
            { id: 'idx-col-jak', base_symbol: 'COLOMBO', quote_symbol: 'JAKARTA', isIndex: true },
            { id: 'idx-chi-jak', base_symbol: 'CHITTAGONG', quote_symbol: 'JAKARTA', isIndex: true },
            { id: 'idx-guw-jal', base_symbol: 'GUWAHATI', quote_symbol: 'JALPAIGURI', isIndex: true },
            { id: 'idx-coc-cmb', base_symbol: 'COCHIN', quote_symbol: 'COIMBATORE', isIndex: true },
            { id: 'idx-sil-coo', base_symbol: 'SILIGURI', quote_symbol: 'COONOOR', isIndex: true },
            { id: 'idx-lim-mom', base_symbol: 'LIMBE', quote_symbol: 'MOMBASA', isIndex: true },
            // Composite
            { id: 'idx-fut-africa', base_symbol: 'FUTURES', quote_symbol: 'AFRICA', isIndex: true },
            { id: 'idx-fut-asia', base_symbol: 'FUTURES', quote_symbol: 'ASIA', isIndex: true },
            { id: 'idx-fut-kenya', base_symbol: 'FUTURES', quote_symbol: 'KENYA', isIndex: true },
            { id: 'idx-fut-india', base_symbol: 'FUTURES', quote_symbol: 'INDIA', isIndex: true },
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
    if (typeof handleCheckoutReturn === 'function') handleCheckoutReturn();

    // ── Phase 0: Instant skeleton UI + sync hydration ──
    // The nav bar and balance already render from HTML; we just need
    // to fill every data container with shimmer placeholders so the
    // page looks alive the millisecond the DOM is ready.
    if (typeof injectSkeletons === 'function') injectSkeletons();

    try { state.teaWatchlist = JSON.parse(localStorage.getItem('tt_tea_watchlist')) || []; }
    catch { state.teaWatchlist = []; }

    // ── Phase 1: Fire everything in parallel ──
    // Auth, reference data, market state — all launch at once.
    // Each loader self-hydrates its UI (replacing skeletons) the
    // moment its own fetch resolves, so we never block on anything.
    const authPromise = checkAuthState();

    // Reference data: each call replaces its skeleton on completion
    const refPromise = Promise.allSettled([
        loadIndexes(),
        loadIndexPairs(),
        loadOrigins(),
        loadTeas(),
        loadMarketState(),
        loadMarketPressure(),
    ]);

    // ── Phase 2: Immediate UI paint (uses cached / default data) ──
    // These are synchronous — they read whatever state already has
    // (optimistic cache from localStorage) and render immediately.
    resizeCanvas();
    drawChart();
    initCommandLine();
    initQuoteBoard();

    // Deferred chart redraw: layout may not be final when DOMContentLoaded fires,
    // so re-measure the canvas once the browser has painted the first frame.
    requestAnimationFrame(() => { resizeCanvas(); drawChart(); });

    // Wait for auth so user-specific paths (positions, trades) work
    await authPromise;

    // Realtime feeds (need supabase auth token)
    startLiveForexFeed();
    startTickerSubscription();

    // ── Phase 3: Non-blocking secondary data ──
    // Price cache starts streaming; sparklines fill as data arrives.
    const priceCachePromise = initializePriceCache().then(() => {
        state.cachedTimeframe = null;
        drawChart();
    });

    Promise.allSettled([
        loadTeaPairs(),
        loadUserTrades(),
    ]);

    // ── Phase 4: Heavy / non-critical — lazy-loaded ──
    setTimeout(() => {
        if (typeof initWeather === 'function') initWeather();
        loadLeaderboard();
        loadTopTraders();
    }, 200);
    setTimeout(() => { initChat(); }, 1000);

    if (state.currentUser && typeof _ensureTradeNotificationChannel === 'function') {
        _ensureTradeNotificationChannel();
        _buildNotifyProfileCache();
    }

    // Wait for reference data to finish before we consider bootstrap done
    // (individual loaders already painted their sections as they resolved)
    await refPromise;

    // ── Phase 5: Responsive handlers & reconnect logic ──
    window.addEventListener('resize', () => {
        resizeCanvas();
        adjustViewportScale();
    });
    adjustViewportScale();
    setupRSIHover();

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



// =============================================
// FCA COMPLIANCE INTERCEPTOR (EMERGENCY PATCH)
// =============================================
document.addEventListener('DOMContentLoaded', () => {
    // Locate the Virtual/Real mode toggle switch from your top bar
    const modeToggle = document.getElementById('mode-toggle');
    const fcaModal = document.getElementById('fca-warning-modal');
    const closeBtn = document.getElementById('close-fca-modal');

    if (modeToggle) {
        modeToggle.addEventListener('click', (e) => {
            // In a click event, .checked reflects the NEW state. 
            // If true, they are trying to activate REAL mode.
            if (modeToggle.checked === true) {
                e.preventDefault(); // Physically stop the switch from moving
                if (fcaModal) fcaModal.style.display = 'flex'; // Trigger the brick wall
            }
        });
    }

    // Catch-all for any other buttons that might try to upgrade the account
    document.addEventListener('click', (e) => {
        const target = e.target.closest('button, a');
        if (!target) return;

        const text = target.textContent.toLowerCase();
        if (text.includes('upgrade to real') || text.includes('convert to real')) {
            e.preventDefault();
            e.stopPropagation();
            if (fcaModal) fcaModal.style.display = 'flex';
        }
    });

    if (closeBtn && fcaModal) {
        closeBtn.addEventListener('click', () => {
            fcaModal.style.display = 'none';
        });
    }
});