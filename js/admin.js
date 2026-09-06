// TeaTrade Exchange — Admin Analytics Dashboard
// ===============================================
// Gated to contact@teatrade.co.uk. Shows users, trades, P&L, email export.

const ADMIN_EMAIL = 'contact@teatrade.co.uk';

function isAdmin() {
    return state.currentUser?.email === ADMIN_EMAIL;
}

function showAdminButton() {
    const btn = document.getElementById('admin-dropdown-btn');
    if (btn) btn.style.display = isAdmin() ? '' : 'none';
}

function openAdminPanel() {
    if (!isAdmin()) return;
    const modal = document.getElementById('admin-modal');
    if (modal) {
        modal.classList.add('active');
        loadAdminData();
    }
}

function closeAdminPanel() {
    const modal = document.getElementById('admin-modal');
    if (modal) modal.classList.remove('active');
}

async function loadAdminData() {
    const body = document.getElementById('admin-body');
    if (!body) return;
    // Load the (fast) finance dashboard and the (heavy) platform analytics
    // independently, so finances always show even if analytics is slow/busy.
    body.innerHTML = '<div id="admin-finance-section" class="admin-loading">Loading finances…</div>'
        + '<div id="admin-analytics-section"></div>';
    loadAdminFinance();
    loadAdminAnalytics();
}

async function loadAdminFinance() {
    const el = document.getElementById('admin-finance-section');
    if (!el) return;
    try {
        const { data, error } = await supabaseClient.rpc('admin_finance');
        if (error) throw error;
        if (!data?.success) throw new Error(data?.error || 'Unknown error');
        renderAdminFinance(el, data);
    } catch (e) {
        el.className = '';
        el.innerHTML = `<div class="admin-error">Finances unavailable: ${e.message}</div>`;
    }
}

async function loadAdminAnalytics() {
    const el = document.getElementById('admin-analytics-section');
    if (!el) return;
    el.innerHTML = '<div class="admin-loading">Loading platform analytics…</div>';
    try {
        const { data, error } = await supabaseClient.rpc('admin_analytics');
        if (error) throw error;
        if (!data?.success) throw new Error(data?.error || 'Unknown error');

        const ts = document.getElementById('admin-timestamp');
        if (ts) ts.textContent = 'Generated: ' + new Date(data.generated_at).toLocaleString();

        renderAdminDashboard(el, data);
    } catch (e) {
        el.innerHTML = `<div class="admin-error">Platform analytics unavailable (the database may be busy — try again shortly): ${e.message}</div>`;
    }
}

function _fmtGbp(pence) {
    return '£' + (Number(pence || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderAdminFinance(container, data) {
    const raised = data.raised || {};
    const paid = data.paid_out || {};
    const byMonth = data.by_month || [];

    container.className = '';
    container.innerHTML = `
        <div class="admin-finance">
            <div class="admin-fin-hero">
                <div class="admin-fin-hero-label">Total Funds Raised</div>
                <div class="admin-fin-hero-value">${_fmtGbp(raised.total_pence)}</div>
                <div class="admin-fin-hero-sub">${_fmt(raised.count || 0)} payments &middot; total paid out ${_fmtGbp(paid.total_pence)}</div>
            </div>
            <div class="admin-fin-grid">
                <div class="admin-fin-card"><div class="admin-fin-num">${_fmtGbp(raised.this_month)}</div><div class="admin-fin-lbl">This Month</div></div>
                <div class="admin-fin-card"><div class="admin-fin-num">${_fmtGbp(raised.last_90d)}</div><div class="admin-fin-lbl">Last 90 Days</div></div>
                <div class="admin-fin-card"><div class="admin-fin-num">${_fmtGbp(raised.ytd)}</div><div class="admin-fin-lbl">Year to Date</div></div>
                <div class="admin-fin-card"><div class="admin-fin-num">${_fmtGbp(paid.total_pence)}</div><div class="admin-fin-lbl">Total Paid Out</div></div>
            </div>
            ${byMonth.length ? `
            <div class="admin-fin-months">
                <div class="admin-fin-months-title">Monthly Revenue</div>
                ${byMonth.map(m => `<div class="admin-fin-month-row"><span>${m.month}</span><span class="admin-fin-month-amt">${_fmtGbp(m.pence)}</span><span class="admin-fin-month-count">${m.count} txns</span></div>`).join('')}
            </div>` : ''}
        </div>
    `;
}

function _fmt(n) {
    return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function _fmtUsd(n) {
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderAdminDashboard(container, data) {
    const u = data.users;
    const t = data.trades;
    const r = data.revenue;
    const p = data.pnl || {};
    const top = data.top_traders || [];
    const exposure = data.exposure || { total_long_kg: 0, total_short_kg: 0 };
    const scraper = data.scraper || [];

    const netPnl = Number(p.net_pnl || 0);
    const counterparty = Number(p.counterparty_pnl || 0);
    const netPnlClass = netPnl >= 0 ? 'admin-buy' : 'admin-sell';
    const counterpartyClass = counterparty >= 0 ? 'admin-buy' : 'admin-sell';

    const emailApiUrl = `${SUPABASE_URL}/functions/v1/admin-emails`;

    container.innerHTML = `
        <div class="admin-grid">
            <!-- SYSTEM EXPOSURE CARD -->
            <div class="admin-card">
                <div class="admin-card-header">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>
                    System Exposure
                </div>
                <div class="admin-stat-big">${_fmt(exposure.total_long_kg + exposure.total_short_kg)} kg</div>
                <div class="admin-stat-label">Total open volume across all markets</div>
                <div class="admin-stat-row">
                    <div class="admin-stat-item">
                        <span class="admin-stat-value admin-buy">${_fmt(exposure.total_long_kg)}</span>
                        <span class="admin-stat-sub">Long (kg)</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value admin-sell">${_fmt(exposure.total_short_kg)}</span>
                        <span class="admin-stat-sub">Short (kg)</span>
                    </div>
                </div>
                <div class="admin-divider"></div>
                <div class="admin-stat-row">
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${exposure.total_long_kg > exposure.total_short_kg ? 'LONG BIASED' : 'SHORT BIASED'}</span>
                        <span class="admin-stat-sub">Platform bias</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmt(Math.abs(exposure.total_long_kg - exposure.total_short_kg))}</span>
                        <span class="admin-stat-sub">Net Delta (kg)</span>
                    </div>
                </div>
            </div>

            <!-- SCRAPER HEALTH CARD -->
            <div class="admin-card">
                <div class="admin-card-header">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
                    Scraper Diagnostics
                </div>
                <div class="admin-stat-label" style="margin-bottom:8px">Last 5 VWAP Sync Events</div>
                <div class="admin-scraper-logs" style="font-family:monospace; font-size:11px; color:var(--text-muted); background:var(--bg-tertiary); padding:8px; border-radius:4px; max-height:140px; overflow-y:auto; line-height: 1.4;">
                    ${scraper.length === 0 ? '<i>No logs found</i>' : scraper.map(s => {
        const isErr = !!s.error_message;
        const target = s.target_id || 'UNKNOWN';
        const time = new Date(s.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (isErr) {
            return '<div style="color:var(--accent-red); margin-bottom:4px; border-bottom:1px solid var(--border-light); padding-bottom:4px;">[' + time + '] ' + target + ': ERR - ' + s.error_message + '</div>';
        } else {
            return '<div style="color:var(--accent-green); margin-bottom:4px; border-bottom:1px solid var(--border-light); padding-bottom:4px;">[' + time + '] ' + target + ': OK - ' + s.records_updated + ' synced</div>';
        }
    }).join('')}
                </div>
            </div>

            <!-- PLATFORM NET P&L CARD — the real bottom line -->
            <div class="admin-card admin-card-highlight">
                <div class="admin-card-header">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M2 12h20"/><circle cx="12" cy="12" r="10"/></svg>
                    Platform Net P&L
                </div>
                <div class="admin-stat-big ${netPnlClass}">${_fmtUsd(netPnl)}</div>
                <div class="admin-stat-label">True bottom line (fees + counterparty)</div>
                <div class="admin-stat-row">
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmtUsd(p.fee_revenue)}</span>
                        <span class="admin-stat-sub">Fee revenue</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value ${counterpartyClass}">${_fmtUsd(counterparty)}</span>
                        <span class="admin-stat-sub">Counterparty P&L</span>
                    </div>
                </div>
                <div class="admin-divider"></div>
                <div class="admin-stat-row">
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmtUsd(p.starting_capital)}</span>
                        <span class="admin-stat-sub">Capital issued</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmtUsd(p.total_user_equity)}</span>
                        <span class="admin-stat-sub">User equity now</span>
                    </div>
                </div>
                <div class="admin-stat-row">
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmtUsd(p.open_tea_pnl)}</span>
                        <span class="admin-stat-sub">Open tea P&L</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmtUsd(p.open_index_pnl)}</span>
                        <span class="admin-stat-sub">Open index P&L</span>
                    </div>
                </div>
                <div class="admin-pnl-note">Counterparty = what traders collectively lost (positive = you profit). Excludes resets &amp; top-ups.</div>
            </div>

            <!-- USERS CARD -->
            <div class="admin-card">
                <div class="admin-card-header">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                    Users
                </div>
                <div class="admin-stat-big">${_fmt(u.total)}</div>
                <div class="admin-stat-label">Total registered users</div>
                <div class="admin-stat-row">
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmt(u.last_7d)}</span>
                        <span class="admin-stat-sub">Last 7d</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmt(u.last_30d)}</span>
                        <span class="admin-stat-sub">Last 30d</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmt(u.last_365d)}</span>
                        <span class="admin-stat-sub">Last year</span>
                    </div>
                </div>
                <div class="admin-divider"></div>
                <div class="admin-stat-row">
                    <div class="admin-stat-item">
                        <span class="admin-stat-value admin-pro">${_fmt(u.tier_pro)}</span>
                        <span class="admin-stat-sub">PRO</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmt(u.tier_free)}</span>
                        <span class="admin-stat-sub">FREE</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value admin-locked">${_fmt(u.status_locked)}</span>
                        <span class="admin-stat-sub">Locked</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value admin-combine">${_fmt(u.status_combine)}</span>
                        <span class="admin-stat-sub">Combine</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmt(u.with_badge)}</span>
                        <span class="admin-stat-sub">Funded</span>
                    </div>
                </div>
            </div>

            <!-- TRADES CARD -->
            <div class="admin-card">
                <div class="admin-card-header">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>
                    Trading Activity
                </div>
                <div class="admin-stat-big">${_fmt(t.total_count)}</div>
                <div class="admin-stat-label">Total trades placed</div>
                <div class="admin-stat-row">
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmt(t.today_count)}</span>
                        <span class="admin-stat-sub">Today</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmt(t.week_count)}</span>
                        <span class="admin-stat-sub">This week</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmt(t.month_count)}</span>
                        <span class="admin-stat-sub">This month</span>
                    </div>
                </div>
                <div class="admin-divider"></div>
                <div class="admin-stat-row">
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmtUsd(t.total_notional)}</span>
                        <span class="admin-stat-sub">Total notional</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmtUsd(t.month_notional)}</span>
                        <span class="admin-stat-sub">This month</span>
                    </div>
                </div>
                <div class="admin-stat-row">
                    <div class="admin-stat-item">
                        <span class="admin-stat-value admin-buy">${_fmt(t.buy_count)}</span>
                        <span class="admin-stat-sub">Buys</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value admin-sell">${_fmt(t.sell_count)}</span>
                        <span class="admin-stat-sub">Sells</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmt(t.unique_traders)}</span>
                        <span class="admin-stat-sub">Unique traders</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${t.avg_leverage}x</span>
                        <span class="admin-stat-sub">Avg leverage</span>
                    </div>
                </div>
            </div>

            <!-- FEE REVENUE CARD -->
            <div class="admin-card">
                <div class="admin-card-header">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
                    Fee Revenue (Gross)
                </div>
                <div class="admin-stat-big admin-revenue">${_fmtUsd(r.total)}</div>
                <div class="admin-stat-label">Spreads + swaps + stop-out fees</div>
                <div class="admin-stat-row">
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmtUsd(r.today)}</span>
                        <span class="admin-stat-sub">Today</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmtUsd(r.this_week)}</span>
                        <span class="admin-stat-sub">This week</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmtUsd(r.this_month)}</span>
                        <span class="admin-stat-sub">This month</span>
                    </div>
                </div>
                <div class="admin-divider"></div>
                <div class="admin-stat-row">
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmtUsd(r.spread)}</span>
                        <span class="admin-stat-sub">Spreads</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmtUsd(r.swap)}</span>
                        <span class="admin-stat-sub">Swaps</span>
                    </div>
                    <div class="admin-stat-item">
                        <span class="admin-stat-value">${_fmtUsd(r.stop_out)}</span>
                        <span class="admin-stat-sub">Stop-outs</span>
                    </div>
                </div>
            </div>
        </div>

        <!-- TOP TRADERS TABLE -->
        <div class="admin-card admin-card-wide">
            <div class="admin-card-header">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8.21 13.89L7 23l5-3 5 3-1.21-9.12"/><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z"/></svg>
                Top 5 Traders
            </div>
            <table class="admin-table">
                <thead>
                    <tr><th>Username</th><th>Net P/L</th><th>Balance</th><th>Trades</th><th>Tier</th><th>Status</th></tr>
                </thead>
                <tbody>
                    ${top.map(tr => `
                        <tr>
                            <td>${escapeHtml(tr.username)}</td>
                            <td class="${Number(tr.net_pnl) >= 0 ? 'admin-buy' : 'admin-sell'}">${_fmtUsd(tr.net_pnl)}</td>
                            <td>${_fmtUsd(tr.virtual_balance)}</td>
                            <td>${_fmt(tr.trade_count)}</td>
                            <td><span class="admin-badge-${(tr.tier || 'free').toLowerCase()}">${tr.tier}</span></td>
                            <td>${tr.account_status}</td>
                        </tr>
                    `).join('')}
                    ${top.length === 0 ? '<tr><td colspan="6" style="text-align:center;opacity:.5;">No traders yet</td></tr>' : ''}
                </tbody>
            </table>
        </div>

        <!-- EMAIL EXPORT -->
        <div class="admin-card admin-card-wide">
            <div class="admin-card-header">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                Email List &amp; Export
            </div>
            <p class="admin-email-desc">${_fmt(u.total)} registered users. Export for newsletters or pipe the API endpoint into Mailchimp.</p>
            <div class="admin-email-actions">
                <button class="admin-btn" onclick="downloadEmailCsv()">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    Download CSV
                </button>
                <button class="admin-btn admin-btn-secondary" onclick="copyEmailApiUrl()">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    Copy API URL
                </button>
            </div>
            <div class="admin-api-url" id="admin-api-url-display">
                <code>${emailApiUrl}</code>
            </div>
        </div>
    `;
}

async function downloadEmailCsv() {
    try {
        const session = await supabaseClient.auth.getSession();
        const token = session.data.session?.access_token;
        if (!token) { showToast('Error', 'Not authenticated', true); return; }

        const resp = await fetch(`${SUPABASE_URL}/functions/v1/admin-emails?format=csv`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!resp.ok) throw new Error('Failed to fetch');

        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'teatrade_users.csv';
        a.click();
        URL.revokeObjectURL(url);
        showToast('Downloaded', 'CSV file saved');
    } catch (e) {
        showToast('Error', 'Failed to download: ' + e.message, true);
    }
}

function copyEmailApiUrl() {
    const url = `${SUPABASE_URL}/functions/v1/admin-emails`;
    navigator.clipboard.writeText(url).then(() => {
        showToast('Copied', 'API URL copied to clipboard');
    }).catch(() => {
        showToast('URL', url);
    });
}
