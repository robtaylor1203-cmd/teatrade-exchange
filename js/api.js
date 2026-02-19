/**
 * TeaTrade Exchange — Data Access Layer (api.js)
 * ================================================
 * This file is the SINGLE source of truth for all Supabase database operations.
 * Every `.from()` call in the application routes through one of these functions.
 *
 * Design principles:
 *   1. Each function wraps exactly ONE Supabase query.
 *   2. Functions return the raw `{ data, error }` from the Supabase client.
 *   3. Functions NEVER mutate global state — that is the caller's responsibility.
 *   4. No UI logic, no toasts, no DOM manipulation.
 *
 * For a production / real-money trading platform these thin client-side calls
 * would be replaced with authenticated server-side API endpoints (e.g. Edge
 * Functions, Express, or Next.js API routes) so that balance updates and trade
 * settlement cannot be tampered with from the browser.
 *
 * Globals used:
 *   - supabaseClient  (initialised in config.js)
 */

// =============================================
// PROFILES
// =============================================

/**
 * Fetch a single user profile by user ID.
 * @param {string} userId - The authenticated user's UUID.
 * @returns {Promise<{data: object|null, error: object|null}>}
 */
async function apiGetProfile(userId) {
    return supabaseClient
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();
}

// C1 FIX: apiUpdateBalance() REMOVED.
// cash_balance is now protected by column-level REVOKE.
// All balance changes go through SECURITY DEFINER functions.

// =============================================
// TEAS
// =============================================

/**
 * Fetch all tea instruments ordered by symbol.
 * @returns {Promise<{data: Array|null, error: object|null}>}
 */
async function apiFetchTeas() {
    return supabaseClient
        .from('teas')
        .select('*')
        .order('symbol');
}

// =============================================
// INDEXES / PAIRS / ORIGINS
// =============================================

/**
 * Fetch all market indexes ordered by display_order.
 * @returns {Promise<{data: Array|null, error: object|null}>}
 */
async function apiFetchIndexes() {
    return supabaseClient
        .from('indexes')
        .select('*')
        .order('display_order');
}

/**
 * Fetch all index pair definitions.
 * @returns {Promise<{data: Array|null, error: object|null}>}
 */
async function apiFetchIndexPairs() {
    return supabaseClient
        .from('index_pairs')
        .select('*');
}

/**
 * Fetch all origin/region definitions ordered by display_order.
 * @returns {Promise<{data: Array|null, error: object|null}>}
 */
async function apiFetchOrigins() {
    return supabaseClient
        .from('origins')
        .select('*')
        .order('display_order');
}

/**
 * Fetch all tea pair definitions.
 * @returns {Promise<{data: Array|null, error: object|null}>}
 */
async function apiFetchTeaPairs() {
    return supabaseClient
        .from('tea_pairs')
        .select('*');
}

// =============================================
// POSITIONS
// =============================================

/**
 * Fetch all positions for a user, including joined tea data.
 * @param {string} userId - The user's UUID.
 * @returns {Promise<{data: Array|null, error: object|null}>}
 */
async function apiFetchPositions(userId) {
    return supabaseClient
        .from('positions')
        .select('*, teas(*)')
        .eq('user_id', userId);
}

// C2 FIX: apiInsertPosition(), apiUpdatePosition(), apiDeletePosition() REMOVED.
// Positions are now managed exclusively by SECURITY DEFINER functions.
// Client can only READ positions (via apiFetchPositions).

// =============================================
// INDEX POSITIONS
// =============================================

/**
 * Fetch all index positions for a user.
 * @param {string} userId - The user's UUID.
 * @returns {Promise<{data: Array|null, error: object|null}>}
 */
async function apiFetchIndexPositions(userId) {
    return supabaseClient
        .from('index_positions')
        .select('*')
        .eq('user_id', userId);
}

// C2 FIX: apiInsertIndexPosition(), apiUpdateIndexPosition(), apiDeleteIndexPosition() REMOVED.
// Index positions are now managed exclusively by SECURITY DEFINER functions.
// Client can only READ index positions (via apiFetchIndexPositions).

// =============================================
// TRADES
// =============================================

// C3 FIX: apiInsertTrade() REMOVED.
// Trades are now recorded exclusively by SECURITY DEFINER functions.
// The audit trail cannot be tampered with from the browser.

/**
 * Fetch all trades for a user, newest first.
 * @param {string} userId - The user's UUID.
 * @returns {Promise<{data: Array|null, error: object|null}>}
 */
async function apiFetchTrades(userId) {
    return supabaseClient
        .from('trades')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
}

/**
 * Fetch a single trade by its ID.
 * @param {string} tradeId - The trade row UUID.
 * @returns {Promise<{data: object|null, error: object|null}>}
 */
async function apiFetchTradeById(tradeId) {
    return supabaseClient
        .from('trades')
        .select('*')
        .eq('id', tradeId)
        .single();
}

// =============================================
// PRICE HISTORY
// =============================================

/**
 * Fetch historical price data for a given symbol, ordered chronologically.
 * Fetches the most recent rows first (desc), then reverses to chronological
 * order so the LIMIT always captures the freshest data.
 * @param {string} symbol - The tea or index symbol (e.g. 'KEN-BP1').
 * @param {number} [limit=500] - Maximum number of records to return.
 * @param {string} [since] - ISO timestamp; only return rows recorded after this time.
 * @returns {Promise<{data: Array|null, error: object|null}>}
 */
async function apiFetchPriceHistory(symbol, limit, since) {
    // For short timeframes (1D / 1W) a single DESC query is fine — live ticks
    // are exactly what we want.
    //
    // For longer timeframes (1M / 3M / 1Y / ALL) the edge-function live ticks
    // from this week would saturate the LIMIT and push the simulated historical
    // daily records completely out of the result set.  We therefore run TWO
    // parallel queries and merge:
    //   A) All simulated rows in the window (at most ~365 per year — trivial)
    //   B) The most-recent 500 live-tick rows (covers the last few days)

    const recentCutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString(); // 2 weeks
    const useSplit = since && (new Date(Date.now()) - new Date(since)) > 14 * 24 * 3600 * 1000;

    if (useSplit && supabaseClient.from) {
        try {
            const [histResult, liveResult] = await Promise.all([
                // A: simulated historical rows for the full window
                supabaseClient
                    .from('price_history')
                    .select('price, recorded_at, volume')
                    .eq('symbol', symbol)
                    .eq('is_simulated', true)
                    .gte('recorded_at', since)
                    .order('recorded_at', { ascending: true })
                    .limit(2000),
                // B: recent live rows (last 2 weeks, not simulated)
                supabaseClient
                    .from('price_history')
                    .select('price, recorded_at, volume')
                    .eq('symbol', symbol)
                    .eq('is_simulated', false)
                    .gte('recorded_at', recentCutoff)
                    .order('recorded_at', { ascending: true })
                    .limit(500),
            ]);

            if (histResult.error && liveResult.error) {
                // Both failed — fall through to single query below
            } else {
                const hist = histResult.data || [];
                const live = liveResult.data || [];
                // Merge and sort by time
                const merged = [...hist, ...live].sort(
                    (a, b) => new Date(a.recorded_at) - new Date(b.recorded_at)
                );
                return { data: merged, error: null };
            }
        } catch (_) {
            // Fall through to single query
        }
    }

    // Default single-query path (short timeframes or split unavailable)
    let query = supabaseClient
        .from('price_history')
        .select('price, recorded_at, volume')
        .eq('symbol', symbol)
        .order('recorded_at', { ascending: false })
        .limit(limit || 500);

    if (since) {
        query = query.gte('recorded_at', since);
    }

    const result = await query;
    if (result.data) result.data.reverse();
    return result;
}

// M10 FIX: apiUpsertPriceHistory() REMOVED (dead code, C5 blocks client inserts anyway).

// =============================================
// CHAT
// =============================================

/**
 * Fetch recent public chat messages, oldest first.
 * @param {number} [limit=50] - Maximum number of messages.
 * @returns {Promise<{data: Array|null, error: object|null}>}
 */
async function apiFetchPublicChatMessages(limit) {
    return supabaseClient
        .from('chat_messages')
        .select('*')
        .eq('is_private', false)
        .order('created_at', { ascending: true })
        .limit(limit || 50);
}

/**
 * Fetch private (DM) messages involving a specific user, oldest first.
 * @param {string} userEmail - The current user's email address.
 * @param {number} [limit=50] - Maximum number of messages.
 * @returns {Promise<{data: Array|null, error: object|null}>}
 */
async function apiFetchPrivateChatMessages(userEmail, limit) {
    return supabaseClient
        .from('chat_messages')
        .select('*')
        .eq('is_private', true)
        .or(`recipient_email.eq.${userEmail},sender_email.eq.${userEmail}`)
        .order('created_at', { ascending: true })
        .limit(limit || 50);
}

/**
 * Insert a new chat message (public or private).
 * @param {object} data - Message data (sender_email, sender_name, message, is_private, recipient_email, etc.).
 * @returns {Promise<{data: object|null, error: object|null}>}
 */
async function apiInsertChatMessage(data) {
    return supabaseClient
        .from('chat_messages')
        .insert(data);
}

/**
 * Look up a user profile by username (case-insensitive).
 * Used for DM recipient resolution.
 * @param {string} username - The username to search for.
 * @returns {Promise<{data: object|null, error: object|null}>}
 */
async function apiLookupUserByUsername(username) {
    return supabaseClient
        .from('profiles')
        .select('id, username, email')
        .ilike('username', username)
        .single();
}

// =============================================
// REALTIME SUBSCRIPTIONS (live server -> frontend)
// =============================================

const _realtimeState = {
    tickerRetries: 0,
    macroRetries: 0,
    chatRetries: 0,
    MAX_RETRIES: 10,
    BASE_DELAY_MS: 2000,
    MAX_DELAY_MS: 60000,
};

function _retryDelay(attempt) {
    const jitter = Math.random() * 1000;
    return Math.min(
        _realtimeState.BASE_DELAY_MS * Math.pow(2, attempt) + jitter,
        _realtimeState.MAX_DELAY_MS
    );
}

function _handleChannelStatus(status, channelName, retryKey, createFn) {
    if (status === 'SUBSCRIBED') {
        console.log(`[Realtime] ${channelName} connected`);
        _realtimeState[retryKey] = 0;
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        const attempt = _realtimeState[retryKey];
        if (attempt < _realtimeState.MAX_RETRIES) {
            const delay = _retryDelay(attempt);
            console.warn(`[Realtime] ${channelName} ${status}, reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${_realtimeState.MAX_RETRIES})`);
            _realtimeState[retryKey]++;
            setTimeout(() => createFn(), delay);
        } else {
            console.error(`[Realtime] ${channelName} failed after ${_realtimeState.MAX_RETRIES} attempts. Refresh the page to retry.`);
        }
    } else if (status === 'CLOSED') {
        console.warn(`[Realtime] ${channelName} closed unexpectedly, attempting reconnect...`);
        _realtimeState[retryKey] = 0;
        setTimeout(() => createFn(), _realtimeState.BASE_DELAY_MS);
    }
}

/**
 * Subscribe to real-time price updates on the `teas` table with
 * automatic exponential-backoff reconnection on failure.
 */
function subscribeToTicker(callback) {
    function create() {
        if (state.tickerSubscription) {
            try { supabaseClient.removeChannel(state.tickerSubscription); } catch (_) {}
        }
        state.tickerSubscription = supabaseClient
            .channel('ticker:teas')
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'teas'
            }, (payload) => { callback(payload); })
            .subscribe((status) => {
                _handleChannelStatus(status, 'ticker:teas', 'tickerRetries', create);
            });
        return state.tickerSubscription;
    }
    return create();
}

/**
 * Subscribe to real-time changes on `market_state` with
 * automatic exponential-backoff reconnection on failure.
 */
function subscribeToMacro(callback) {
    function create() {
        if (state.macroSubscription) {
            try { supabaseClient.removeChannel(state.macroSubscription); } catch (_) {}
        }
        state.macroSubscription = supabaseClient
            .channel('ticker:market_state')
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'market_state'
            }, (payload) => { callback(payload); })
            .subscribe((status) => {
                _handleChannelStatus(status, 'ticker:market_state', 'macroRetries', create);
            });
        return state.macroSubscription;
    }
    return create();
}

/**
 * Subscribe to real-time market_pressure updates.
 * Fires within ~50-100 ms of every trade INSERT on the server.
 * Each payload.new contains buy_volume_5m, sell_volume_5m,
 * buy_volume_30m, sell_volume_30m, last_side, last_qty for one symbol.
 */
function subscribeToMarketPressure(callback) {
    function create() {
        if (state.pressureSubscription) {
            try { supabaseClient.removeChannel(state.pressureSubscription); } catch (_) {}
        }
        state.pressureSubscription = supabaseClient
            .channel('market:pressure')
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'market_pressure'
            }, (payload) => { callback(payload); })
            .subscribe((status) => {
                _handleChannelStatus(status, 'market:pressure', 'pressureRetries', create);
            });
        return state.pressureSubscription;
    }
    return create();
}

/**
 * Fetch the current market_pressure snapshot for all symbols.
 * Called once on startup so the depth bars are populated immediately
 * rather than waiting for the first trade event.
 */
async function apiFetchMarketPressure() {
    return supabaseClient
        .from('market_pressure')
        .select('*');
}

/**
 * Subscribe to chat messages with automatic reconnection.
 */
function subscribeToChatMessages(callback) {
    function create() {
        if (state.chatSubscription) {
            try { supabaseClient.removeChannel(state.chatSubscription); } catch (_) {}
        }
        state.chatSubscription = supabaseClient
            .channel('chat_messages')
            .on('postgres_changes',
                { event: 'INSERT', schema: 'public', table: 'chat_messages' },
                (payload) => { callback(payload); })
            .subscribe((status) => {
                _handleChannelStatus(status, 'chat_messages', 'chatRetries', create);
            });
        return state.chatSubscription;
    }
    return create();
}

// =============================================
// MULTI-TAB SYNC (Phase 4-18)
// Realtime subscriptions for user-specific data
// so that trades/positions update across all tabs.
// =============================================

/**
 * Subscribe to position changes for the current user.
 * Any INSERT/UPDATE/DELETE on positions triggers a full reload.
 */
function subscribeToPositions(userId) {
    const key = 'positionsRetries';
    if (!_realtimeState[key]) _realtimeState[key] = 0;

    function create() {
        if (state.positionsSubscription) {
            try { supabaseClient.removeChannel(state.positionsSubscription); } catch (_) {}
        }
        state.positionsSubscription = supabaseClient
            .channel(`user:positions:${userId}`)
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'positions',
                filter: `user_id=eq.${userId}`
            }, async () => {
                if (typeof loadPositions === 'function') await loadPositions();
                if (typeof updatePortfolioDisplay === 'function') updatePortfolioDisplay();
            })
            .subscribe((status) => {
                _handleChannelStatus(status, `positions:${userId.slice(0, 8)}`, key, create);
            });
        return state.positionsSubscription;
    }
    return create();
}

/**
 * Subscribe to trade inserts for the current user.
 * Any new trade triggers a reload of the orders table.
 */
function subscribeToTrades(userId) {
    const key = 'tradesRetries';
    if (!_realtimeState[key]) _realtimeState[key] = 0;

    function create() {
        if (state.tradesSubscription) {
            try { supabaseClient.removeChannel(state.tradesSubscription); } catch (_) {}
        }
        state.tradesSubscription = supabaseClient
            .channel(`user:trades:${userId}`)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'trades',
                filter: `user_id=eq.${userId}`
            }, async () => {
                if (typeof loadUserTrades === 'function') {
                    await new Promise(r => setTimeout(r, 200));
                    await loadUserTrades();
                }
            })
            .subscribe((status) => {
                _handleChannelStatus(status, `trades:${userId.slice(0, 8)}`, key, create);
            });
        return state.tradesSubscription;
    }
    return create();
}

/**
 * Subscribe to balance/profile changes for the current user.
 * Any UPDATE on profiles triggers a balance display refresh.
 */
function subscribeToProfile(userId) {
    const key = 'profileRetries';
    if (!_realtimeState[key]) _realtimeState[key] = 0;

    function create() {
        if (state.profileSubscription) {
            try { supabaseClient.removeChannel(state.profileSubscription); } catch (_) {}
        }
        state.profileSubscription = supabaseClient
            .channel(`user:profile:${userId}`)
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'profiles',
                filter: `id=eq.${userId}`
            }, async (payload) => {
                if (payload.new && state.userProfile) {
                    state.userProfile.cash_balance = payload.new.cash_balance;
                    if (typeof updateUIForLoggedInUser === 'function') updateUIForLoggedInUser();
                }
            })
            .subscribe((status) => {
                _handleChannelStatus(status, `profile:${userId.slice(0, 8)}`, key, create);
            });
        return state.profileSubscription;
    }
    return create();
}

/**
 * Subscribe to pending order fills for the current user.
 */
function subscribeToPendingOrders(userId) {
    const key = 'ordersRetries';
    if (!_realtimeState[key]) _realtimeState[key] = 0;

    function create() {
        if (state.pendingOrdersSubscription) {
            try { supabaseClient.removeChannel(state.pendingOrdersSubscription); } catch (_) {}
        }
        state.pendingOrdersSubscription = supabaseClient
            .channel(`user:orders:${userId}`)
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'pending_orders',
                filter: `user_id=eq.${userId}`
            }, async (payload) => {
                if (payload.new?.status === 'FILLED') {
                    const sym = payload.new.symbol;
                    const side = payload.new.side;
                    showToast('Order Filled!', `${side} ${sym} @ $${Number(payload.new.fill_price).toFixed(2)}`);
                    if (typeof loadPositions === 'function') await loadPositions();
                    if (typeof loadUserTrades === 'function') {
                        await new Promise(r => setTimeout(r, 300));
                        await loadUserTrades();
                    }
                }
                if (typeof loadPendingOrders === 'function') loadPendingOrders();
            })
            .subscribe((status) => {
                _handleChannelStatus(status, `orders:${userId.slice(0, 8)}`, key, create);
            });
        return state.pendingOrdersSubscription;
    }
    return create();
}

/**
 * Start all user-specific Realtime subscriptions.
 * Call this after login.
 */
function startUserSubscriptions(userId) {
    subscribeToPositions(userId);
    subscribeToTrades(userId);
    subscribeToProfile(userId);
    subscribeToPendingOrders(userId);
}

/**
 * Tear down user-specific subscriptions on logout.
 */
function stopUserSubscriptions() {
    ['positionsSubscription', 'tradesSubscription', 'profileSubscription', 'pendingOrdersSubscription'].forEach(key => {
        if (state[key]) {
            try { supabaseClient.removeChannel(state[key]); } catch (_) {}
            state[key] = null;
        }
    });
}

/**
 * Re-establish all Realtime subscriptions after network recovery.
 * Called by the visibility/online event handlers.
 */
function reconnectAllChannels() {
    console.log('[Realtime] Reconnecting all channels...');
    _realtimeState.tickerRetries = 0;
    _realtimeState.macroRetries = 0;
    _realtimeState.chatRetries = 0;
    if (typeof startTickerSubscription === 'function') startTickerSubscription();
    if (state.currentUser) startUserSubscriptions(state.currentUser.id);
}

/**
 * Fetch all rows from the market_state table (initial load).
 * @returns {Promise<{data: Array|null, error: object|null}>}
 */
async function apiFetchMarketState() {
    return supabaseClient
        .from('market_state')
        .select('*');
}

// =============================================
// SERVER-SIDE TRADE EXECUTION
// =============================================

async function _invokeEdgeFunction(fnName, body) {
    try {
        const { data, error } = await supabaseClient.functions.invoke(fnName, { body });

        if (!error) {
            return data || { success: false, error: 'Empty response' };
        }

        // Extract the actual error body from the Edge Function response
        let serverMsg = '';
        try {
            const errBody = await error.context?.json();
            serverMsg = errBody?.error || errBody?.message || '';
        } catch (_) {}

        if (!serverMsg) {
            try {
                serverMsg = await error.context?.text();
            } catch (_) {}
        }

        const msg = serverMsg || error.message || 'Trade request failed';
        console.error(`[${fnName}]`, msg);
        return { success: false, error: msg };
    } catch (err) {
        console.error(`[${fnName}] error:`, err);
        return { success: false, error: err.message || 'Request failed' };
    }
}

/**
 * Execute a trade via the server-side Edge Function.
 * The server validates the user, fetches the REAL market price, checks
 * balance/holdings, and executes everything atomically in one transaction.
 *
 * @param {string} symbol   - Tea symbol (e.g. 'KEN-BP1')
 * @param {'BUY'|'SELL'} side
 * @param {number} quantity - Quantity in kg
 * @returns {Promise<{success: boolean, trade_id?: string, price?: number, total?: number, new_balance?: number, error?: string}>}
 */
async function apiExecuteTrade(symbol, side, quantity) {
    return _invokeEdgeFunction('execute-trade', { symbol, side, quantity });
}

// =============================================
// SERVER-SIDE INDEX TRADE EXECUTION (C4 FIX)
// =============================================

/**
 * Execute an index trade via the server-side Edge Function.
 * @param {string} symbol   - Index symbol (e.g. 'KENYA')
 * @param {'BUY'|'SELL'} side
 * @param {number} quantity - Quantity in kg
 * @param {number} price    - Current index price (server validates within 5%)
 * @returns {Promise<{success: boolean, ...}>}
 */
async function apiExecuteIndexTrade(symbol, side, quantity, price) {
    return _invokeEdgeFunction('execute-index-trade', { action: 'trade', symbol, side, quantity, price });
}

/**
 * Close a pair trade via the server-side Edge Function.
 * @param {string} tradeId   - Original pair trade row ID
 * @param {number} exitRatio - Current base/quote ratio
 * @returns {Promise<{success: boolean, ...}>}
 */
async function apiClosePairTrade(tradeId, exitRatio) {
    return _invokeEdgeFunction('execute-index-trade', { action: 'close_pair', trade_id: tradeId, exit_ratio: exitRatio });
}

/**
 * Open a pair trade via the server-side Edge Function.
 * @param {object} params - { side, amount, ratio, leverage, pair_id, tea_id, index_symbol }
 * @returns {Promise<{success: boolean, ...}>}
 */
async function apiOpenPairTrade(params) {
    return _invokeEdgeFunction('execute-index-trade', { action: 'open_pair', ...params });
}

/**
 * Reset account via the server-side Edge Function.
 * Wipes all positions, trades, and resets balance to $10,000.
 * @returns {Promise<{success: boolean, new_balance?: number, error?: string}>}
 */
async function apiResetAccount() {
    return _invokeEdgeFunction('execute-index-trade', { action: 'reset' });
}

// =============================================
// LIMIT / STOP ORDERS (Phase 4-16)
// =============================================

async function apiPlaceOrder(symbol, isIndex, side, orderType, quantity, targetPrice, expiresHours) {
    return _invokeEdgeFunction('execute-index-trade', {
        action: 'place_order',
        symbol, is_index: isIndex, side, order_type: orderType,
        quantity, target_price: targetPrice,
        expires_hours: expiresHours || null
    });
}

async function apiCancelOrder(orderId) {
    return _invokeEdgeFunction('execute-index-trade', { action: 'cancel_order', order_id: orderId });
}

async function apiFetchPendingOrders() {
    return supabaseClient
        .from('pending_orders')
        .select('*')
        .eq('user_id', state.currentUser?.id)
        .order('created_at', { ascending: false });
}

// =============================================
// LEADERBOARD
// =============================================

/**
 * Fetch the top traders from the leaderboard view, sorted by total portfolio value.
 * @param {number} [limit=10] - Number of leaders to return.
 * @returns {Promise<{data: Array|null, error: object|null}>}
 */
async function apiFetchLeaderboard(limit) {
    return supabaseClient
        .from('leaderboard')
        .select('*')
        .order('total_value', { ascending: false })
        .limit(limit || 10);
}

