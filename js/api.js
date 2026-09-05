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
        .eq('user_id', userId)
        .eq('trading_mode', state.tradingMode);
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
        .eq('user_id', userId)
        .eq('trading_mode', state.tradingMode);
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
        .eq('trading_mode', state.tradingMode)
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
    if (since && supabaseClient.from) {
        try {
            // Optimized 2-segment fetch to avoid slamming the connection pool on load.
            // 1) Simulated history (1 row/day)
            // 2) Live engine history (max 3000 rows requested, capped automatically by PostgREST to 1000)
            // By sorting descending and reversing, we ensure the most recent data is caught.
            const [histResult, liveResult] = await Promise.all([
                supabaseClient
                    .from('price_history')
                    .select('price, recorded_at, volume')
                    .eq('symbol', symbol)
                    .eq('is_simulated', true)
                    .gte('recorded_at', since)
                    .order('recorded_at', { ascending: false })
                    .limit(limit || 5000),
                supabaseClient
                    .from('price_history')
                    .select('price, recorded_at, volume')
                    .eq('symbol', symbol)
                    .eq('is_simulated', false)
                    .gte('recorded_at', since)
                    .order('recorded_at', { ascending: false })
                    .limit(limit || 5000)
            ]);

            if (!histResult.error || !liveResult.error) {
                // Reverse desc back to chronological asc
                const histData = (histResult.data || []).reverse();
                const liveData = (liveResult.data || []).reverse();

                const merged = [...histData, ...liveData]
                    .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());
                return { data: merged, error: null };
            }
        } catch (_) {
            // Fall through to single query
        }
    }

    // Fallback: no time window (ALL timeframe) — single DESC LIMIT query
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

async function apiFetchNews(limit = 12) {
    return supabaseClient
        .from('news')
        .select('title, snippet, sentiment, tags, published_at, url')
        .order('published_at', { ascending: false })
        .limit(limit);
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
    const result = await supabaseClient
        .from('profiles')
        .select('id, username, email, cash_balance, virtual_balance, real_balance, follower_count, following_count, created_at, badges, tier, combine_badge, showcase_badge')
        .ilike('username', username)
        .single();

    if (result.error && !result.data) {
        return supabaseClient
            .from('profiles')
            .select('id, username, email, cash_balance, virtual_balance, real_balance, follower_count, following_count, created_at, tier, combine_badge')
            .ilike('username', username)
            .single();
    }
    return result;
}

/**
 * Search profiles by partial username match (for the universal search bar).
 * Returns up to `limit` profiles whose username contains the query substring.
 */
async function apiSearchUsers(query, limit = 4) {
    return supabaseClient
        .from('profiles')
        .select('id, username, created_at, follower_count, following_count')
        .ilike('username', `%${query}%`)
        .order('follower_count', { ascending: false })
        .limit(limit);
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
            try { supabaseClient.removeChannel(state.tickerSubscription); } catch (_) { }
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
            try { supabaseClient.removeChannel(state.macroSubscription); } catch (_) { }
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
            try { supabaseClient.removeChannel(state.pressureSubscription); } catch (_) { }
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
            try { supabaseClient.removeChannel(state.chatSubscription); } catch (_) { }
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
            try { supabaseClient.removeChannel(state.positionsSubscription); } catch (_) { }
        }
        state.positionsSubscription = supabaseClient
            .channel(`user:positions:${userId}`)
            .on('postgres_changes', {
                event: 'DELETE',
                schema: 'public',
                table: 'positions',
                filter: `user_id=eq.${userId}`
            }, async (payload) => {
                const old = payload.old;
                if (old && (old.stop_loss || old.take_profit)) {
                    const sym = (state.teas || []).find(t => t.id === old.tea_id)?.symbol || 'Position';
                    const trigger = old.stop_loss ? 'Stop Loss' : 'Take Profit';
                    if (typeof showToast === 'function') {
                        showToast(`${trigger} Triggered`, `${sym} was automatically closed via ${trigger}`);
                    }
                }
                if (typeof loadPositions === 'function') await loadPositions();
                if (typeof loadUserProfile === 'function') await loadUserProfile();
                if (typeof updatePortfolioDisplay === 'function') updatePortfolioDisplay();
                if (typeof updateUIForLoggedInUser === 'function') updateUIForLoggedInUser();
            })
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'positions',
                filter: `user_id=eq.${userId}`
            }, async () => {
                if (typeof loadPositions === 'function') await loadPositions();
                if (typeof updatePortfolioDisplay === 'function') updatePortfolioDisplay();
            })
            .on('postgres_changes', {
                event: 'UPDATE',
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
 * Subscribe to index position changes for the current user.
 * Detects server-side SL/TP closures on index positions.
 */
function subscribeToIndexPositions(userId) {
    const key = 'idxPosRetries';
    if (!_realtimeState[key]) _realtimeState[key] = 0;

    function create() {
        if (state.indexPositionsSubscription) {
            try { supabaseClient.removeChannel(state.indexPositionsSubscription); } catch (_) { }
        }
        state.indexPositionsSubscription = supabaseClient
            .channel(`user:index_positions:${userId}`)
            .on('postgres_changes', {
                event: 'DELETE',
                schema: 'public',
                table: 'index_positions',
                filter: `user_id=eq.${userId}`
            }, async (payload) => {
                const old = payload.old;
                if (old && (old.stop_loss || old.take_profit)) {
                    const sym = old.index_symbol || 'Index position';
                    const trigger = old.stop_loss ? 'Stop Loss' : 'Take Profit';
                    if (typeof showToast === 'function') {
                        showToast(`${trigger} Triggered`, `${sym} was automatically closed via ${trigger}`);
                    }
                }
                if (typeof loadIndexPositions === 'function') await loadIndexPositions();
                if (typeof loadUserProfile === 'function') await loadUserProfile();
                if (typeof updatePortfolioDisplay === 'function') updatePortfolioDisplay();
                if (typeof updateUIForLoggedInUser === 'function') updateUIForLoggedInUser();
            })
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'index_positions',
                filter: `user_id=eq.${userId}`
            }, async () => {
                if (typeof loadIndexPositions === 'function') await loadIndexPositions();
                if (typeof updatePortfolioDisplay === 'function') updatePortfolioDisplay();
            })
            .subscribe((status) => {
                _handleChannelStatus(status, `idx_positions:${userId.slice(0, 8)}`, key, create);
            });
        return state.indexPositionsSubscription;
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
            try { supabaseClient.removeChannel(state.tradesSubscription); } catch (_) { }
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
            try { supabaseClient.removeChannel(state.profileSubscription); } catch (_) { }
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
                    if (payload.new.virtual_balance !== undefined) state.userProfile.virtual_balance = payload.new.virtual_balance;
                    if (payload.new.real_balance !== undefined) state.userProfile.real_balance = payload.new.real_balance;
                    updateBalanceDisplay();
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
            try { supabaseClient.removeChannel(state.pendingOrdersSubscription); } catch (_) { }
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
 * Subscribe to margin call / stop-out notifications for the current user.
 * Shows a prominent warning toast when the server detects danger levels.
 */
function subscribeToMarginNotifications(userId) {
    const key = 'marginNotifRetries';
    if (!_realtimeState[key]) _realtimeState[key] = 0;

    function create() {
        if (state.marginNotifSubscription) {
            try { supabaseClient.removeChannel(state.marginNotifSubscription); } catch (_) { }
        }
        state.marginNotifSubscription = supabaseClient
            .channel(`user:margin:${userId}`)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'margin_notifications',
                filter: `user_id=eq.${userId}`
            }, (payload) => {
                const n = payload.new;
                if (!n) return;
                if (n.type === 'STOP_OUT') {
                    _showMarginAlert('STOP OUT — Positions Liquidated',
                        n.message || 'All positions have been closed to protect your account.',
                        'stop_out');
                    if (typeof loadPositions === 'function') loadPositions();
                    if (typeof loadIndexPositions === 'function') loadIndexPositions();
                } else if (n.type === 'MARGIN_CALL') {
                    _showMarginAlert('Margin Call Warning',
                        n.message || `Margin level at ${Number(n.margin_level).toFixed(0)}%. Deposit funds or close positions.`,
                        'margin_call');
                }
            })
            .subscribe((status) => {
                _handleChannelStatus(status, `margin:${userId.slice(0, 8)}`, key, create);
            });
        return state.marginNotifSubscription;
    }
    return create();
}

/**
 * Display a prominent margin alert overlay.
 */
function _showMarginAlert(title, message, type) {
    const existing = document.getElementById('margin-alert-overlay');
    if (existing) existing.remove();

    const isStopOut = type === 'stop_out';
    const overlay = document.createElement('div');
    overlay.id = 'margin-alert-overlay';
    overlay.className = `margin-alert ${isStopOut ? 'margin-alert-danger' : 'margin-alert-warning'}`;
    overlay.innerHTML = `
        <div class="margin-alert-icon">${isStopOut ? '🛑' : '⚠️'}</div>
        <div class="margin-alert-content">
            <div class="margin-alert-title">${title}</div>
            <div class="margin-alert-msg">${message}</div>
        </div>
        <button class="margin-alert-close" onclick="this.parentElement.remove()">✕</button>
    `;
    document.body.appendChild(overlay);

    if (!isStopOut) {
        setTimeout(() => { if (overlay.parentElement) overlay.remove(); }, 30000);
    }
}

/**
 * Start all user-specific Realtime subscriptions.
 * Call this after login.
 */
function startUserSubscriptions(userId) {
    subscribeToPositions(userId);
    subscribeToIndexPositions(userId);
    subscribeToTrades(userId);
    subscribeToProfile(userId);
    subscribeToPendingOrders(userId);
    subscribeToMarginNotifications(userId);
}

/**
 * Tear down user-specific subscriptions on logout.
 */
function stopUserSubscriptions() {
    ['positionsSubscription', 'indexPositionsSubscription', 'tradesSubscription',
        'profileSubscription', 'pendingOrdersSubscription', 'marginNotifSubscription'].forEach(key => {
            if (state[key]) {
                try { supabaseClient.removeChannel(state[key]); } catch (_) { }
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
    if (state.currentUser) {
        startUserSubscriptions(state.currentUser.id);
        if (typeof reconnectTradeNotifications === 'function') {
            reconnectTradeNotifications();
        }
    }
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
        // Always refresh the session before calling an Edge Function.
        // supabaseClient.functions.invoke() does NOT auto-refresh the access
        // token, so a slightly-expired JWT gets sent to the gateway and comes
        // back as "Invalid JWT". getSession() triggers a silent token refresh
        // when the access token is within the expiry window.
        let accessToken = null;
        try {
            const { data: sessionData } = await supabaseClient.auth.getSession();
            accessToken = sessionData?.session?.access_token || null;
        } catch (_) { }

        const invokeOpts = { body };
        if (accessToken) {
            invokeOpts.headers = { Authorization: `Bearer ${accessToken}` };
        }

        const { data, error } = await supabaseClient.functions.invoke(fnName, invokeOpts);

        if (!error) {
            return data || { success: false, error: 'Empty response' };
        }

        // Extract the actual error body from the Edge Function response
        let serverMsg = '';
        try {
            const errBody = await error.context?.json();
            serverMsg = errBody?.error || errBody?.message || '';
        } catch (_) { }

        if (!serverMsg) {
            try {
                serverMsg = await error.context?.text();
            } catch (_) { }
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
 * Execute a trade via the server-side Edge Function (execute_trade_secure).
 * The server validates the user, fetches the REAL market price, checks
 * slippage against expected_price, and executes atomically with row locks.
 *
 * @param {string} symbol   - Tea symbol (e.g. 'KEN-BP1')
 * @param {'BUY'|'SELL'} side
 * @param {number} quantity - Quantity in kg
 * @param {number} [leverage=1]
 * @param {number|null} [expectedPrice=null] - Price the client last saw (Fill or Kill guard)
 * @param {number} [slippageTolerance=0.05] - Max acceptable price deviation ($)
 * @returns {Promise<{success: boolean, trade_id?: string, price?: number, total?: number, new_balance?: number, error?: string}>}
 */
async function apiExecuteTrade(symbol, side, quantity, leverage = 1, expectedPrice = null, slippageTolerance = 0.05) {
    const payload = { symbol, side, quantity, leverage, mode: state.tradingMode };
    if (expectedPrice != null && expectedPrice > 0) {
        payload.expected_price = expectedPrice;
        payload.slippage_tolerance = slippageTolerance;
    }
    return _invokeEdgeFunction('execute-trade', payload);
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
async function apiExecuteIndexTrade(symbol, side, quantity, price, leverage = 1) {
    return _invokeEdgeFunction('execute-index-trade', { action: 'trade', symbol, side, quantity, price, leverage, mode: state.tradingMode });
}

/**
 * Close a pair trade via the server-side Edge Function.
 * @param {string} tradeId   - Original pair trade row ID
 * @param {number} exitRatio - Current base/quote ratio
 * @returns {Promise<{success: boolean, ...}>}
 */
async function apiClosePairTrade(tradeId, exitRatio) {
    return _invokeEdgeFunction('execute-index-trade', { action: 'close_pair', trade_id: tradeId, exit_ratio: exitRatio, mode: state.tradingMode });
}

/**
 * Open a pair trade via the server-side Edge Function.
 * @param {object} params - { side, amount, ratio, leverage, pair_id, tea_id, index_symbol }
 * @returns {Promise<{success: boolean, ...}>}
 */
async function apiOpenPairTrade(params) {
    return _invokeEdgeFunction('execute-index-trade', { action: 'open_pair', ...params, mode: state.tradingMode });
}

/**
 * Reset account via the server-side Edge Function.
 * Wipes all positions, trades, and resets balance to $10,000.
 * @returns {Promise<{success: boolean, new_balance?: number, error?: string}>}
 */
async function apiResetAccount() {
    return _invokeEdgeFunction('execute-index-trade', { action: 'reset', mode: state.tradingMode });
}

// =============================================
// MONETIZATION / STRIPE
// =============================================

async function apiCreateCheckout(product) {
    return _invokeEdgeFunction('stripe-checkout', { product });
}

async function apiFetchActiveCombine() {
    return supabaseClient
        .from('combine_challenges')
        .select('*')
        .eq('user_id', state.currentUser?.id)
        .eq('status', 'ACTIVE')
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();
}

async function apiFetchCombineRules() {
    return supabaseClient.rpc('check_combine_rules', {
        p_user_id: state.currentUser?.id,
    });
}

// =============================================
// FUNDED ACCOUNT / PROP TRADING
// =============================================

async function apiFetchFundedAccountStatus() {
    return supabaseClient.rpc('get_funded_account_status', {
        p_user_id: state.currentUser?.id,
    });
}

// Reward-payout API removed — TeaTrade is a risk-free educational platform
// with no real-money withdrawals.

async function apiFetchLiquidationAudit() {
    return supabaseClient.rpc('get_liquidation_audit', {
        p_user_id: state.currentUser?.id,
    });
}

// =============================================
// LIMIT / STOP ORDERS (Phase 4-16)
// =============================================

async function apiPlaceOrder(symbol, isIndex, side, orderType, quantity, targetPrice, expiresHours) {
    return _invokeEdgeFunction('execute-index-trade', {
        action: 'place_order',
        symbol, is_index: isIndex, side, order_type: orderType,
        quantity, target_price: targetPrice,
        expires_hours: expiresHours || null,
        mode: state.tradingMode
    });
}

async function apiCancelOrder(orderId) {
    return _invokeEdgeFunction('execute-index-trade', { action: 'cancel_order', order_id: orderId, mode: state.tradingMode });
}

async function apiFetchPendingOrders() {
    return supabaseClient
        .from('pending_orders')
        .select('*')
        .eq('user_id', state.currentUser?.id)
        .eq('trading_mode', state.tradingMode)
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

// =============================================
// FOLLOWS
// =============================================

async function apiFollowUser(targetUserId) {
    const me = state.currentUser?.id;
    if (!me || me === targetUserId) return { data: null, error: { message: 'Cannot follow' } };
    return supabaseClient.from('follows').insert({ follower_id: me, following_id: targetUserId });
}

async function apiUnfollowUser(targetUserId) {
    const me = state.currentUser?.id;
    if (!me) return { data: null, error: { message: 'Not logged in' } };
    return supabaseClient.from('follows').delete().eq('follower_id', me).eq('following_id', targetUserId);
}

async function apiIsFollowing(targetUserId) {
    const me = state.currentUser?.id;
    if (!me) return false;
    const { data } = await supabaseClient
        .from('follows')
        .select('id')
        .eq('follower_id', me)
        .eq('following_id', targetUserId)
        .maybeSingle();
    return !!data;
}

async function apiFetchFollowCounts(userId) {
    const { data } = await supabaseClient
        .from('profiles')
        .select('follower_count, following_count')
        .eq('id', userId)
        .single();
    return data || { follower_count: 0, following_count: 0 };
}

async function apiToggleFollowNotify(targetUserId, notify) {
    const me = state.currentUser?.id;
    if (!me) return { error: { message: 'Not logged in' } };
    return supabaseClient
        .from('follows')
        .update({ notify })
        .eq('follower_id', me)
        .eq('following_id', targetUserId);
}

async function apiFetchMyFollows() {
    const me = state.currentUser?.id;
    if (!me) return [];
    const { data } = await supabaseClient
        .from('follows')
        .select('following_id, notify, created_at')
        .eq('follower_id', me);
    return data || [];
}

async function apiFetchTraderProfile(username) {
    const { data } = await supabaseClient
        .from('leaderboard')
        .select('*')
        .ilike('username', username)
        .maybeSingle();
    return data;
}

// =============================================
// TODAY'S OPENING PRICES (for accurate % change)
// =============================================

/**
 * Fetch top traders by total volume (quantity) traded in the last 7 days.
 * Groups by user_id, sums quantity, joins profiles for username.
 */
async function apiFetchTopTraders(limit = 5) {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data, error } = await supabaseClient
        .rpc('top_traders_by_volume', { since_ts: weekAgo, max_rows: limit });
    if (error || !data) {
        const fallback = await supabaseClient
            .from('trades')
            .select('user_id, quantity, profiles!inner(username)')
            .gte('created_at', weekAgo)
            .limit(1000);
        if (!fallback.data) return [];
        const agg = {};
        fallback.data.forEach(t => {
            const uid = t.user_id;
            if (!agg[uid]) agg[uid] = { user_id: uid, username: t.profiles?.username || uid.slice(0, 8), total_volume: 0 };
            agg[uid].total_volume += Math.abs(Number(t.quantity) || 0);
        });
        return Object.values(agg).sort((a, b) => b.total_volume - a.total_volume).slice(0, limit);
    }
    return data;
}

async function apiFetchTodayOpenPrices() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayISO = todayStart.toISOString();

    const { data } = await supabaseClient
        .from('price_history')
        .select('symbol, price')
        .gte('recorded_at', todayISO)
        .order('recorded_at', { ascending: true })
        .limit(500);

    if (!data) return {};

    const openPrices = {};
    data.forEach(row => {
        if (!openPrices[row.symbol]) {
            openPrices[row.symbol] = row.price;
        }
    });
    return openPrices;
}

