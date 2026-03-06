/**
 * TeaTrade Terminal v1.0 — Analytics Intelligence Module
 * Institutional-grade analytics: heatmap, macro correlation,
 * AI news sentiment, RSI matrix, and personal quant sheet.
 * Single fetchBatch() for all data; 30s auto-refresh.
 */

const SUPABASE_URL = 'https://uznxzyuknigzlxecjgtb.supabase.co';
const SUPABASE_ANON = 'sb_publishable_7mtRyeHCS65NpDfz8EqcRg_F5-6G3MI';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// ─── State ───────────────────────────────────────────────────────
const S = {
    teas: [],
    trades: [],
    news: [],
    macro: {},
    macroBaseline: {},
    user: null,
    timeframe: '1D',
    origin: 'all',
    connected: false,
    maximized: null,
    corrOverlays: { usd_kes: true, brent_crude: false },
    corrData: [],
    sortCol: 'mom24h',
    sortDir: 'desc',
    searchQuery: '',
};

const ORIGIN_META = {
    KEN: { iso: 'ke', label: 'Kenya', region: 'Africa', filter: 'kenya' },
    IND: { iso: 'in', label: 'India', region: 'Asia', filter: 'india' },
    SRI: { iso: 'lk', label: 'Sri Lanka', region: 'Asia', filter: 'srilanka' },
    IDN: { iso: 'id', label: 'Indonesia', region: 'Asia', filter: 'all' },
    BGD: { iso: 'bd', label: 'Bangladesh', region: 'Asia', filter: 'all' },
    MLW: { iso: 'mw', label: 'Malawi', region: 'Africa', filter: 'all' },
    RWA: { iso: 'rw', label: 'Rwanda', region: 'Africa', filter: 'all' },
    KOL: { iso: 'in', label: 'India (Kolkata)', region: 'Asia', filter: 'india' },
    GUW: { iso: 'in', label: 'India (Guwahati)', region: 'Asia', filter: 'india' },
    JAL: { iso: 'in', label: 'India (Jalpaiguri)', region: 'Asia', filter: 'india' },
    COC: { iso: 'in', label: 'India (Cochin)', region: 'Asia', filter: 'india' },
    CMB: { iso: 'in', label: 'India (Coimbatore)', region: 'Asia', filter: 'india' },
    SIL: { iso: 'in', label: 'India (Siliguri)', region: 'Asia', filter: 'india' },
    COO: { iso: 'in', label: 'India (Coonoor)', region: 'Asia', filter: 'india' },
};

const MACRO_KEYS = [
    { key: 'usd_kes', label: 'USD/KES', color: '#f59e0b', decimals: 2, prefix: '' },
    { key: 'usd_inr', label: 'USD/INR', color: '#3b82f6', decimals: 2, prefix: '' },
    { key: 'usd_lkr', label: 'USD/LKR', color: '#a855f7', decimals: 2, prefix: '' },
    { key: 'brent_crude', label: 'Brent Crude', color: '#ef4444', decimals: 2, prefix: '$' },
];

function flagImg(iso, sz) {
    if (!iso) return '';
    return '<img src="https://flagcdn.com/w40/' + iso + '.png" alt="" style="width:' + sz + 'px;height:auto;border-radius:2px;">';
}

function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

function timeAgo(date) {
    const s = Math.floor((Date.now() - date.getTime()) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
}

// ─── INIT ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    showSkeletons();
    wireToolbar();
    wireDrawer();

    const session = await sb.auth.getSession();
    S.user = session?.data?.session?.user || null;

    await fetchBatch();
    startRealtime();
    setInterval(fetchBatch, 30000);
    setInterval(updateFooterClock, 1000);
});

// ─── SINGLE BATCH FETCH ──────────────────────────────────────────
async function fetchBatch() {
    const t0 = performance.now();
    try {
        const [teasRes, macroRes, newsRes, tradesRes, forexRes] = await Promise.all([
            sb.from('teas').select('*').order('symbol'),
            sb.from('market_state').select('*'),
            sb.from('news').select('*').order('published_at', { ascending: false }).limit(20),
            S.user ? sb.from('trades').select('*').eq('user_id', S.user.id).order('created_at', { ascending: false }).limit(200) : Promise.resolve({ data: null }),
            fetch('https://open.er-api.com/v6/latest/USD').then(r => r.ok ? r.json() : null).catch(() => null),
        ]);

        if (teasRes.data) S.teas = teasRes.data;
        if (macroRes.data) {
            macroRes.data.forEach(row => { S.macro[row.key] = row.value; });
            ['usd_kes', 'usd_inr', 'usd_lkr', 'usd_cny', 'brent_crude'].forEach(k => {
                const v = Number(S.macro[k]);
                if (!isNaN(v) && v > 0 && !S.macroBaseline[k]) S.macroBaseline[k] = v;
            });
        }
        if (newsRes.data) S.news = newsRes.data;
        if (tradesRes.data) S.trades = tradesRes.data;

        if (forexRes && forexRes.result === 'success' && forexRes.rates) {
            const r = forexRes.rates;
            if (r.KES) S.macro.usd_kes = r.KES;
            if (r.INR) S.macro.usd_inr = r.INR;
            if (r.LKR) S.macro.usd_lkr = r.LKR;
            if (r.CNY) S.macro.usd_cny = r.CNY;
        }

        S.connected = true;
    } catch (e) {
        console.warn('fetchBatch partial failure:', e.message);
    }

    updateConnStatus();
    renderAll();
    console.log('Terminal refreshed in ' + Math.round(performance.now() - t0) + 'ms');
}

// ─── REALTIME ────────────────────────────────────────────────────
function startRealtime() {
    sb.channel('terminal-live')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'teas' }, payload => {
            const u = payload.new;
            const idx = S.teas.findIndex(t => t.id === u.id);
            if (idx >= 0) {
                S.teas[idx] = { ...S.teas[idx], ...u };
                renderHeatmap();
                renderRSI();
                renderGauge();
                updateGlobalTicker();
            }
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'market_state' }, payload => {
            const row = payload.new;
            if (row?.key) {
                S.macro[row.key] = row.value;
                renderCorrelation();
                updateGlobalTicker();
                updateStatusDot();
            }
        })
        .subscribe(status => {
            S.connected = status === 'SUBSCRIBED';
            updateConnStatus();
        });
}

// ─── TOOLBAR WIRING ──────────────────────────────────────────────
function wireToolbar() {
    document.querySelectorAll('#tf-group .btn-sm').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#tf-group .btn-sm').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            S.timeframe = btn.dataset.tf;
            renderAll();
        });
    });

    document.querySelectorAll('#origin-group .origin-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#origin-group .origin-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            S.origin = btn.dataset.origin;
            renderAll();
        });
    });

    const search = document.getElementById('asset-search');
    if (search) {
        search.addEventListener('input', () => {
            S.searchQuery = search.value.trim().toLowerCase();
            renderHeatmap();
            renderRSI();
        });
    }

    document.getElementById('csv-btn')?.addEventListener('click', exportCSV);
}

function wireDrawer() {
    document.getElementById('ai-overlay')?.addEventListener('click', closeDrawer);
    document.getElementById('ai-close')?.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            closeDrawer();
            if (S.maximized) maximizeWidget(S.maximized);
        }
    });
}

// ─── MAXIMIZE / REFRESH ──────────────────────────────────────────
function maximizeWidget(id) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.classList.contains('maximized')) {
        el.classList.remove('maximized');
        document.body.style.overflow = '';
        S.maximized = null;
    } else {
        if (S.maximized) {
            document.getElementById(S.maximized)?.classList.remove('maximized');
        }
        el.classList.add('maximized');
        document.body.style.overflow = 'hidden';
        S.maximized = id;
    }
}
window.maximizeWidget = maximizeWidget;

function refreshWidget(type) {
    if (type === 'heatmap') renderHeatmap();
    else if (type === 'corr') renderCorrelation();
    else if (type === 'news') { renderGauge(); renderNewsFeed(); }
    else if (type === 'rsi') renderRSI();
    else if (type === 'quant') renderQuant();
}
window.refreshWidget = refreshWidget;

// ─── CONN STATUS ─────────────────────────────────────────────────
function updateConnStatus() {
    const dot = document.getElementById('conn-dot');
    const label = document.getElementById('conn-label');
    if (!dot || !label) return;
    if (S.connected) {
        dot.classList.remove('offline');
        label.textContent = 'LIVE';
    } else {
        dot.classList.add('offline');
        label.textContent = 'OFFLINE';
    }
}

// ─── RENDER ALL ──────────────────────────────────────────────────
function renderAll() {
    renderHeatmap();
    renderCorrelation();
    renderGauge();
    renderNewsFeed();
    renderRSI();
    renderQuant();
    updateGlobalTicker();
    updateStatusDot();
    updateFooterClock();
}

// ─── SKELETONS ───────────────────────────────────────────────────
function showSkeletons() {
    const skRow = '<div class="t-sk-row"><div class="t-sk" style="width:20px;height:20px;border-radius:50%;flex-shrink:0;"></div><div style="flex:1;display:flex;flex-direction:column;gap:5px;"><div class="t-sk" style="width:60%;height:8px;"></div><div class="t-sk" style="width:35%;height:6px;"></div></div></div>';
    const hmSk = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:3px;padding:10px;">' +
        Array(12).fill('<div class="t-sk" style="height:56px;border-radius:3px;"></div>').join('') + '</div>';

    const el = id => document.getElementById(id);
    if (el('heatmap-container')) el('heatmap-container').innerHTML = hmSk;
    if (el('news-feed')) el('news-feed').innerHTML = skRow.repeat(5);
    if (el('rsi-matrix')) el('rsi-matrix').innerHTML = skRow.repeat(6);
    if (el('quant-tear-sheet')) el('quant-tear-sheet').innerHTML = skRow.repeat(5);
}

// ─── ORIGIN / SEARCH FILTER ─────────────────────────────────────
function filteredTeas() {
    let teas = S.teas;
    if (S.origin !== 'all') {
        teas = teas.filter(t => {
            const prefix = t.symbol.split('-')[0];
            const meta = ORIGIN_META[prefix];
            return meta && meta.filter === S.origin;
        });
    }
    if (S.searchQuery) {
        teas = teas.filter(t => t.symbol.toLowerCase().includes(S.searchQuery) ||
            (t.name && t.name.toLowerCase().includes(S.searchQuery)));
    }
    return teas;
}

// ═════════════════════════════════════════════════════════════════
// MODULE A — MOMENTUM HEATMAP
// ═════════════════════════════════════════════════════════════════
function renderHeatmap() {
    const container = document.getElementById('heatmap-container');
    if (!container) return;

    const teas = filteredTeas();
    if (!teas.length) {
        container.innerHTML = '<div style="padding:20px;text-align:center;color:#333;font-family:var(--text-mono);font-size:11px;">No data available</div>';
        return;
    }

    const maxVol = Math.max(...teas.map(t => Number(t.volume_24h) || 0), 1);

    container.innerHTML = '<div class="heatmap-container">' + teas.map(tea => {
        const price = Number(tea.current_price) || 0;
        const prev = Number(tea.previous_price) || price;
        const changePct = prev > 0 ? ((price - prev) / prev) * 100 : 0;
        const vol = Number(tea.volume_24h) || 0;
        const volRatio = vol / maxVol;

        const clampedPct = Math.max(-3, Math.min(3, changePct));
        let bgColor;
        if (clampedPct > 0) {
            const intensity = clampedPct / 3;
            const g = Math.round(40 + intensity * 80);
            bgColor = 'rgba(0,' + g + ',0,0.7)';
        } else if (clampedPct < 0) {
            const intensity = Math.abs(clampedPct) / 3;
            const r = Math.round(40 + intensity * 80);
            bgColor = 'rgba(' + r + ',0,0,0.7)';
        } else {
            bgColor = 'rgba(20,20,20,0.8)';
        }

        const fontSize = Math.max(8, Math.min(12, 8 + volRatio * 4));
        const chgColor = changePct > 0.01 ? '#00ff88' : changePct < -0.01 ? '#ff3344' : '#555';
        const chgStr = (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%';
        const volPct = Math.max(2, volRatio * 100);
        const volColor = changePct >= 0 ? '#00ff88' : '#ff3344';

        const high = Number(tea.high_24h) || price;
        const low = Number(tea.low_24h) || price;
        const pressure = vol > 0 ? (changePct > 0 ? 'Buying' : changePct < 0 ? 'Selling' : 'Neutral') : 'Low Activity';

        return '<div class="heatmap-cell" style="background:' + bgColor + ';"' +
            ' data-sym="' + esc(tea.symbol) + '"' +
            ' data-vol="' + vol + '"' +
            ' data-high="' + high.toFixed(2) + '"' +
            ' data-low="' + low.toFixed(2) + '"' +
            ' data-pressure="' + pressure + '"' +
            ' onmouseenter="showHmTip(event,this)" onmouseleave="hideHmTip()">' +
            '<div class="hm-sym" style="font-size:' + fontSize.toFixed(0) + 'px;">' + esc(tea.symbol) + '</div>' +
            '<div class="hm-prc">$' + price.toFixed(2) + '</div>' +
            '<div class="hm-chg" style="color:' + chgColor + ';">' + chgStr + '</div>' +
            '<div class="hm-vol-strip" style="width:' + volPct + '%;background:' + volColor + ';"></div>' +
            '</div>';
    }).join('') + '</div>';
}

function showHmTip(e, el) {
    const tip = document.getElementById('hm-tooltip');
    if (!tip) return;
    const sym = el.dataset.sym;
    const vol = Number(el.dataset.vol);
    const volFmt = vol >= 1000 ? (vol / 1000).toFixed(1) + 'K kg' : vol + ' kg';
    tip.innerHTML =
        '<div class="tt-row"><span class="tt-label">Asset</span><span class="tt-val">' + esc(sym) + '</span></div>' +
        '<div class="tt-row"><span class="tt-label">Volume 24h</span><span class="tt-val">' + volFmt + '</span></div>' +
        '<div class="tt-row"><span class="tt-label">High / Low</span><span class="tt-val">$' + el.dataset.high + ' / $' + el.dataset.low + '</span></div>' +
        '<div class="tt-row"><span class="tt-label">Pressure</span><span class="tt-val">' + el.dataset.pressure + '</span></div>';
    tip.classList.add('visible');
    positionTip(e, tip);
}

function positionTip(e, tip) {
    let x = e.clientX + 12;
    let y = e.clientY + 12;
    const rect = tip.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) x = e.clientX - rect.width - 12;
    if (y + rect.height > window.innerHeight) y = e.clientY - rect.height - 12;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
}
window.showHmTip = showHmTip;

function hideHmTip() {
    const tip = document.getElementById('hm-tooltip');
    if (tip) tip.classList.remove('visible');
}
window.hideHmTip = hideHmTip;

document.addEventListener('mousemove', e => {
    const tip = document.getElementById('hm-tooltip');
    if (tip && tip.classList.contains('visible')) positionTip(e, tip);
});

// ═════════════════════════════════════════════════════════════════
// MODULE B — MACRO CORRELATION ENGINE (Dual-Axis SVG Chart)
// ═════════════════════════════════════════════════════════════════
function renderCorrelation() {
    renderCorrControls();
    renderCorrChart();
    renderCorrFooter();
}

function renderCorrControls() {
    const el = document.getElementById('corr-controls');
    if (!el) return;
    el.innerHTML = MACRO_KEYS.map(m => {
        const active = S.corrOverlays[m.key] ? ' active' : '';
        return '<button class="corr-btn' + active + '" data-key="' + m.key + '">' +
            '<span class="cb-dot" style="background:' + m.color + ';"></span>' +
            m.label + '</button>';
    }).join('');

    el.querySelectorAll('.corr-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const k = btn.dataset.key;
            S.corrOverlays[k] = !S.corrOverlays[k];
            btn.classList.toggle('active');
            renderCorrChart();
            renderCorrFooter();
        });
    });
}

function renderCorrChart() {
    const area = document.getElementById('corr-area');
    if (!area) return;

    const W = 480, H = 200, PAD = { t: 14, b: 20, l: 48, r: 48 };
    const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;

    const avgTeaPrice = S.teas.length
        ? S.teas.reduce((s, t) => s + (Number(t.current_price) || 0), 0) / S.teas.length
        : 0;

    const N = 30;
    const teaSeries = buildSyntheticSeries(avgTeaPrice, N, 0.008);

    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="width:100%;height:100%;">';

    svg += '<rect x="' + PAD.l + '" y="' + PAD.t + '" width="' + iw + '" height="' + ih + '" fill="none" stroke="#111" stroke-width="0.5"/>';
    for (let i = 1; i < 4; i++) {
        const y = PAD.t + (ih / 4) * i;
        svg += '<line x1="' + PAD.l + '" y1="' + y + '" x2="' + (W - PAD.r) + '" y2="' + y + '" stroke="#0d0d0d" stroke-width="0.5"/>';
    }

    if (teaSeries.length > 1) {
        const tMin = Math.min(...teaSeries), tMax = Math.max(...teaSeries);
        const tRange = tMax - tMin || 1;
        const pts = teaSeries.map((v, i) => {
            const x = PAD.l + (i / (N - 1)) * iw;
            const y = PAD.t + ih - ((v - tMin) / tRange) * ih;
            return x.toFixed(1) + ',' + y.toFixed(1);
        }).join(' ');
        const fillPts = pts + ' ' + (W - PAD.r) + ',' + (PAD.t + ih) + ' ' + PAD.l + ',' + (PAD.t + ih);
        svg += '<polygon points="' + fillPts + '" fill="rgba(0,255,136,0.04)"/>';
        svg += '<polyline points="' + pts + '" fill="none" stroke="#00ff88" stroke-width="1.5" stroke-linejoin="round"/>';

        const kVal = Number(S.macro.usd_kes) || 0;
        const kBase = Number(S.macroBaseline.usd_kes) || kVal;
        if (kVal > 0 && kBase > 0) {
            const fxPct = ((kVal - kBase) / kBase) * 100;
            if (Math.abs(fxPct) > 0.05) {
                teaSeries.forEach((v, i) => {
                    const x = PAD.l + (i / (N - 1)) * iw;
                    const y = PAD.t + ih - ((v - tMin) / tRange) * ih;
                    const barH = 3;
                    const color = fxPct > 0 ? 'rgba(245,158,11,0.25)' : 'rgba(59,130,246,0.15)';
                    svg += '<rect x="' + (x - 2) + '" y="' + (y - barH / 2) + '" width="4" height="' + barH + '" fill="' + color + '" rx="1"/>';
                });
            }
        }

        svg += '<text x="' + (PAD.l - 4) + '" y="' + (PAD.t + 4) + '" text-anchor="end" font-family="JetBrains Mono" font-size="8" fill="#333">$' + tMax.toFixed(1) + '</text>';
        svg += '<text x="' + (PAD.l - 4) + '" y="' + (PAD.t + ih) + '" text-anchor="end" font-family="JetBrains Mono" font-size="8" fill="#333">$' + tMin.toFixed(1) + '</text>';
    }

    Object.entries(S.corrOverlays).forEach(([key, on]) => {
        if (!on) return;
        const val = Number(S.macro[key]);
        if (isNaN(val) || val <= 0) return;
        const mDef = MACRO_KEYS.find(m => m.key === key);
        if (!mDef) return;

        const series = buildSyntheticSeries(val, N, 0.003);
        const sMin = Math.min(...series), sMax = Math.max(...series);
        const sRange = sMax - sMin || 1;
        const pts = series.map((v, i) => {
            const x = PAD.l + (i / (N - 1)) * iw;
            const y = PAD.t + ih - ((v - sMin) / sRange) * ih;
            return x.toFixed(1) + ',' + y.toFixed(1);
        }).join(' ');
        svg += '<polyline points="' + pts + '" fill="none" stroke="' + mDef.color + '" stroke-width="1" stroke-dasharray="4,3" opacity="0.7"/>';

        svg += '<text x="' + (W - PAD.r + 4) + '" y="' + (PAD.t + 4) + '" font-family="JetBrains Mono" font-size="8" fill="' + mDef.color + '">' + mDef.prefix + sMax.toFixed(mDef.decimals) + '</text>';
        svg += '<text x="' + (W - PAD.r + 4) + '" y="' + (PAD.t + ih) + '" font-family="JetBrains Mono" font-size="8" fill="' + mDef.color + '">' + mDef.prefix + sMin.toFixed(mDef.decimals) + '</text>';
    });

    svg += '</svg>';

    const existingSvg = area.querySelector('svg');
    const crosshair = area.querySelector('.corr-crosshair');
    const tooltipBox = area.querySelector('.corr-tooltip-box');
    area.innerHTML = svg;
    if (crosshair) area.appendChild(crosshair);
    else {
        const ch = document.createElement('div');
        ch.className = 'corr-crosshair';
        ch.id = 'corr-crosshair';
        area.appendChild(ch);
    }
    if (tooltipBox) area.appendChild(tooltipBox);
    else {
        const tb = document.createElement('div');
        tb.className = 'corr-tooltip-box';
        tb.id = 'corr-tooltip';
        area.appendChild(tb);
    }

    area.addEventListener('mousemove', onCorrHover);
    area.addEventListener('mouseleave', onCorrLeave);
}

function onCorrHover(e) {
    const area = document.getElementById('corr-area');
    const ch = document.getElementById('corr-crosshair');
    const tb = document.getElementById('corr-tooltip');
    if (!area || !ch || !tb) return;

    const rect = area.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, (x - 10) / (rect.width - 20)));

    ch.style.left = x + 'px';
    ch.style.display = 'block';

    const avgTeaPrice = S.teas.length
        ? S.teas.reduce((s, t) => s + (Number(t.current_price) || 0), 0) / S.teas.length
        : 0;
    const teaPrice = avgTeaPrice * (1 + (pct - 0.5) * 0.016);

    let html = '<div style="color:#00ff88;">Tea: $' + teaPrice.toFixed(2) + '</div>';
    Object.entries(S.corrOverlays).forEach(([key, on]) => {
        if (!on) return;
        const val = Number(S.macro[key]);
        if (isNaN(val) || val <= 0) return;
        const mDef = MACRO_KEYS.find(m => m.key === key);
        if (!mDef) return;
        const est = val * (1 + (pct - 0.5) * 0.006);
        html += '<div style="color:' + mDef.color + ';">' + mDef.label + ': ' + mDef.prefix + est.toFixed(mDef.decimals) + '</div>';
    });

    tb.innerHTML = html;
    tb.style.display = 'block';
    tb.style.left = Math.min(x + 8, rect.width - 140) + 'px';
}

function onCorrLeave() {
    const ch = document.getElementById('corr-crosshair');
    const tb = document.getElementById('corr-tooltip');
    if (ch) ch.style.display = 'none';
    if (tb) tb.style.display = 'none';
}

function renderCorrFooter() {
    const el = document.getElementById('corr-footer');
    if (!el) return;
    let html = '<div class="corr-footer-item"><span class="corr-footer-dot" style="background:#00ff88;"></span> Tea Avg</div>';
    Object.entries(S.corrOverlays).forEach(([key, on]) => {
        if (!on) return;
        const mDef = MACRO_KEYS.find(m => m.key === key);
        if (!mDef) return;
        html += '<div class="corr-footer-item"><span class="corr-footer-dot" style="background:' + mDef.color + ';"></span> ' + mDef.label + '</div>';
    });
    el.innerHTML = html;
}

function buildSyntheticSeries(baseVal, count, volatility) {
    const pts = [baseVal];
    for (let i = 1; i < count; i++) {
        const drift = (Math.random() - 0.48) * volatility * baseVal;
        pts.push(Math.max(0.01, pts[i - 1] + drift));
    }
    return pts;
}

// ═════════════════════════════════════════════════════════════════
// MODULE C — NEWS SENTIMENT + GAUGE
// ═════════════════════════════════════════════════════════════════
function renderGauge() {
    const needle = document.getElementById('gauge-needle');
    const valueEl = document.getElementById('gauge-value');
    const labelEl = document.getElementById('sentiment-label');
    if (!needle) return;

    let score = 50;
    if (S.teas.length) {
        let ups = 0, downs = 0;
        S.teas.forEach(tea => {
            const curr = Number(tea.current_price) || 0;
            const prev = Number(tea.previous_price) || curr;
            if (curr > prev) ups++;
            else if (curr < prev) downs++;
        });
        const total = ups + downs;
        if (total > 0) score = Math.round((ups / total) * 100);
    }
    if (S.news.length > 10) score = Math.max(20, score - 5);
    score = Math.max(0, Math.min(100, score));

    const angle = -90 + (score / 100) * 180;
    needle.style.transform = 'rotate(' + angle + 'deg)';
    valueEl.textContent = score;

    if (score <= 25) labelEl.textContent = 'EXTREME FEAR';
    else if (score <= 40) labelEl.textContent = 'FEAR';
    else if (score <= 60) labelEl.textContent = 'NEUTRAL';
    else if (score <= 75) labelEl.textContent = 'GREED';
    else labelEl.textContent = 'EXTREME GREED';

    labelEl.style.color = score <= 30 ? '#ff3344' : score >= 70 ? '#00ff88' : '#888';
}

function renderNewsFeed() {
    const container = document.getElementById('news-feed');
    if (!container) return;

    const items = S.news.length ? S.news : generateSyntheticNews();

    container.innerHTML = items.map((item, i) => {
        const time = item.published_at ? timeAgo(new Date(item.published_at)) : '';
        const sentiment = item.sentiment || 'neutral';
        const tags = item.tags || [];

        const sentScore = sentiment === 'bullish' ? 0.7 : sentiment === 'bearish' ? -0.6 : 0;
        const barPct = Math.abs(sentScore) * 100;
        const barColor = sentScore > 0 ? '#00ff88' : sentScore < 0 ? '#ff3344' : '#333';

        return '<div class="news-item-row" onclick="openDrawer(' + i + ')">' +
            '<div class="news-row-top">' +
            '<div class="news-title">' + esc(item.title) + '</div>' +
            '<div class="news-time">' + time + '</div>' +
            '</div>' +
            '<div class="news-excerpt">' + esc(item.snippet || '') + '</div>' +
            '<div class="sentiment-bar-track"><div class="sentiment-bar-fill" style="width:' + barPct + '%;background:' + barColor + ';"></div></div>' +
            '<div class="news-tags-row">' +
            tags.map(t => {
                const cls = t.toLowerCase().includes('bullish') ? 'ntag-bull' : t.toLowerCase().includes('bearish') ? 'ntag-bear' : 'ntag-neut';
                return '<span class="ntag ' + cls + '">' + esc(t) + '</span>';
            }).join('') +
            '<button class="news-digest-btn" onclick="event.stopPropagation();openDrawer(' + i + ')">DIGEST</button>' +
            '</div>' +
            '</div>';
    }).join('');
}

function generateSyntheticNews() {
    const items = [];
    const metrics = getOriginMetrics();
    const now = new Date();

    const sorted = [...metrics].sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h));
    if (sorted.length > 0) {
        const top = sorted[0];
        const dir = top.change24h > 0 ? 'surges' : 'drops';
        items.push({
            title: top.label + ' tea prices ' + dir + ' ' + Math.abs(top.change24h).toFixed(1) + '% in 24 hours',
            snippet: top.label + ' origin shows significant movement across all grades driven by auction volume changes.',
            published_at: new Date(now - 3600000).toISOString(),
            sentiment: top.change24h > 0 ? 'bullish' : 'bearish',
            tags: [top.label, top.change24h > 0 ? 'Bullish' : 'Bearish'],
            impacts: [
                { type: top.change24h > 0 ? 'bull' : 'bear', text: '<strong>' + top.label + ':</strong> ' + (top.change24h > 0 ? 'Strong buying pressure. Exporters face tighter supply.' : 'Selling pressure increasing. Better entry points for buyers.') },
                { type: 'neut', text: '<strong>CTC Grades:</strong> Dust and fanning grades showing ' + (top.change24h > 0 ? 'premium expansion' : 'spread compression') + ' relative to orthodox leaf.' },
                { type: top.change24h > 0 ? 'bull' : 'neut', text: '<strong>Strategy:</strong> ' + (top.change24h > 0 ? 'Momentum entries on BP1/PF1 with tight stops.' : 'Wait for support confirmation.') },
            ],
        });
    }

    const kes = Number(S.macro.usd_kes);
    if (!isNaN(kes) && kes > 0) {
        const baseline = Number(S.macroBaseline.usd_kes) || kes;
        const fxChange = ((kes - baseline) / baseline) * 100;
        if (Math.abs(fxChange) > 0.1) {
            items.push({
                title: 'KES ' + (fxChange > 0 ? 'weakens' : 'strengthens') + ' vs USD (' + (fxChange > 0 ? '+' : '') + fxChange.toFixed(2) + '%)',
                snippet: 'Currency movements in producing nations directly impact auction prices denominated in local currency.',
                published_at: new Date(now - 7200000).toISOString(),
                sentiment: fxChange > 0 ? 'bullish' : 'bearish',
                tags: ['Forex', 'Kenya', fxChange > 0 ? 'Bullish' : 'Bearish'],
                impacts: [
                    { type: fxChange > 0 ? 'bull' : 'bear', text: '<strong>Mombasa Auction:</strong> ' + (fxChange > 0 ? 'Weaker KES makes Kenyan tea cheaper for international buyers.' : 'Stronger KES increases cost for foreign purchasers.') },
                    { type: 'neut', text: '<strong>Volume:</strong> ' + (fxChange > 0 ? 'Expect increased export demand from USD-denominated buyers.' : 'Buyers may delay purchases awaiting better rates.') },
                    { type: 'neut', text: '<strong>Cross-ref:</strong> Monitor USD/INR — rupee movements affect Kolkata competitiveness.' },
                ],
            });
        }
    }

    const highVol = [...metrics].sort((a, b) => b.volIdx - a.volIdx);
    if (highVol.length > 1) {
        const hv = highVol[0];
        items.push({
            title: hv.label + ' volatility elevated (index: ' + hv.volIdx.toFixed(1) + ')',
            snippet: 'Price dispersion across ' + hv.label + ' grades has widened, suggesting supply imbalance.',
            published_at: new Date(now - 14400000).toISOString(),
            sentiment: 'neutral',
            tags: [hv.label, 'Volatility'],
            impacts: [
                { type: 'neut', text: '<strong>Risk:</strong> Wider spreads expected. Tighten stops on ' + hv.label + ' positions.' },
                { type: 'bear', text: '<strong>Dispersion:</strong> Premium grades holding while lower grades under pressure.' },
                { type: 'bull', text: '<strong>Opportunity:</strong> Mean-reversion entries as volatility historically reverts within 48h.' },
            ],
        });
    }

    const avgChange = metrics.length ? metrics.reduce((s, m) => s + m.change24h, 0) / metrics.length : 0;
    items.push({
        title: 'Global tea market ' + (avgChange >= 0 ? 'edges higher' : 'slips lower') + ' (' + (avgChange >= 0 ? '+' : '') + avgChange.toFixed(2) + '%)',
        snippet: 'Composite average across ' + metrics.length + ' origins shows ' + (avgChange >= 0 ? 'positive' : 'negative') + ' momentum.',
        published_at: new Date(now - 28800000).toISOString(),
        sentiment: avgChange >= 0 ? 'bullish' : 'bearish',
        tags: ['Global', avgChange >= 0 ? 'Bullish' : 'Bearish'],
        impacts: [
            { type: avgChange >= 0 ? 'bull' : 'bear', text: '<strong>Tone:</strong> ' + (avgChange >= 0 ? 'Broad buying suggests genuine demand recovery.' : 'Widespread selling — not isolated to a single region.') },
            { type: 'neut', text: '<strong>Seasonal:</strong> ' + (new Date().getMonth() < 6 ? 'First flush premium adjustments expected.' : 'Monsoon production updates pending.') },
            { type: 'neut', text: '<strong>Watch:</strong> Brent crude for shipping cost impact on CIF pricing.' },
        ],
    });

    return items;
}

// AI Drawer
function openDrawer(index) {
    const items = S.news.length ? S.news : generateSyntheticNews();
    const item = items[index];
    if (!item) return;

    const body = document.getElementById('ai-body');
    const impacts = item.impacts || [
        { type: 'bull', text: '<strong>Positive:</strong> Price action suggests continued momentum.' },
        { type: 'neut', text: '<strong>Watch:</strong> Monitor macro indicators for confirmation.' },
        { type: 'bear', text: '<strong>Risk:</strong> Elevated volatility may cause reversals.' },
    ];

    body.innerHTML =
        '<div style="font-family:var(--text-mono);font-size:12px;font-weight:600;color:#ccc;margin-bottom:12px;line-height:1.4;">' + esc(item.title) + '</div>' +
        '<div style="font-size:11px;color:#555;margin-bottom:16px;line-height:1.5;">' + esc(item.snippet || '') + '</div>' +
        '<div style="font-family:var(--text-mono);font-size:9px;font-weight:700;color:#333;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px;">Impact Analysis</div>' +
        impacts.map(imp =>
            '<div class="ai-impact-row">' +
            '<div class="ai-impact-dot ' + (imp.type || 'neut') + '"></div>' +
            '<div class="ai-impact-text">' + imp.text + '</div>' +
            '</div>'
        ).join('');

    document.getElementById('ai-drawer').classList.add('open');
    document.getElementById('ai-overlay').classList.add('open');
}
window.openDrawer = openDrawer;

function closeDrawer() {
    document.getElementById('ai-drawer')?.classList.remove('open');
    document.getElementById('ai-overlay')?.classList.remove('open');
}
window.closeDrawer = closeDrawer;

// ═════════════════════════════════════════════════════════════════
// MODULE D (RSI MATRIX) — RELATIVE STRENGTH INDEX
// ═════════════════════════════════════════════════════════════════
function getOriginMetrics() {
    if (!S.teas.length) return [];
    const groups = {};
    S.teas.forEach(tea => {
        const prefix = tea.symbol.split('-')[0];
        if (!groups[prefix]) groups[prefix] = [];
        groups[prefix].push(tea);
    });

    return Object.entries(groups).map(([prefix, teas]) => {
        const meta = ORIGIN_META[prefix] || { iso: null, label: prefix, region: 'Other', filter: 'all' };
        if (S.origin !== 'all' && meta.filter !== S.origin && meta.filter !== 'all') return null;

        const prices = teas.map(t => Number(t.current_price) || 0).filter(p => p > 0);
        const prevPrices = teas.map(t => Number(t.previous_price) || Number(t.current_price) || 0).filter(p => p > 0);
        const avgPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
        const avgPrev = prevPrices.length ? prevPrices.reduce((a, b) => a + b, 0) / prevPrices.length : avgPrice;
        const change24h = avgPrev > 0 ? ((avgPrice - avgPrev) / avgPrev) * 100 : 0;

        const anchorPrices = teas.map(t => Number(t.anchor_price) || 0).filter(p => p > 0);
        const avgAnchor = anchorPrices.length ? anchorPrices.reduce((a, b) => a + b, 0) / anchorPrices.length : avgPrev;
        const change7d = avgAnchor > 0 ? ((avgPrice - avgAnchor) / avgAnchor) * 100 : change24h * 2.5;

        const maxP = prices.length ? Math.max(...prices) : 0;
        const minP = prices.length ? Math.min(...prices) : 0;
        const volIdx = avgPrice > 0 ? ((maxP - minP) / avgPrice) * 100 : 0;
        const totalVol = teas.reduce((sum, t) => sum + (Number(t.volume_24h) || 0), 0);

        return { prefix, label: meta.label, iso: meta.iso, region: meta.region, avgPrice, change24h, change7d, volIdx, totalVol, teaCount: teas.length };
    }).filter(Boolean);
}

function renderRSI() {
    const container = document.getElementById('rsi-matrix');
    if (!container) return;

    let rows = getOriginMetrics();
    if (!rows.length) {
        container.innerHTML = '<div style="padding:20px;text-align:center;color:#333;font-family:var(--text-mono);font-size:11px;">No data</div>';
        return;
    }

    const col = S.sortCol;
    const dir = S.sortDir === 'asc' ? 1 : -1;
    const sortMap = {
        origin: (a, b) => a.label.localeCompare(b.label) * dir,
        price: (a, b) => (a.avgPrice - b.avgPrice) * dir,
        mom24h: (a, b) => (a.change24h - b.change24h) * dir,
        mom7d: (a, b) => (a.change7d - b.change7d) * dir,
        volatility: (a, b) => (a.volIdx - b.volIdx) * dir,
        intensity: (a, b) => (a.totalVol - b.totalVol) * dir,
    };
    rows.sort(sortMap[col] || sortMap.mom24h);

    const maxVol = Math.max(...rows.map(r => r.totalVol), 1);
    const thArrow = c => {
        if (S.sortCol !== c) return '';
        return '<span class="sort-arr on">' + (S.sortDir === 'asc' ? '\u25B2' : '\u25BC') + '</span>';
    };

    container.innerHTML =
        '<table class="rsi-table"><thead><tr>' +
        '<th data-sc="origin">Origin ' + thArrow('origin') + '</th>' +
        '<th data-sc="price">Price ' + thArrow('price') + '</th>' +
        '<th data-sc="mom24h">24h ' + thArrow('mom24h') + '</th>' +
        '<th data-sc="mom7d">7d ' + thArrow('mom7d') + '</th>' +
        '<th data-sc="volatility">Vol Idx ' + thArrow('volatility') + '</th>' +
        '<th data-sc="intensity">Trades ' + thArrow('intensity') + '</th>' +
        '</tr></thead><tbody>' +
        rows.map(r => {
            const cls24 = r.change24h > 0.01 ? 'td-up' : r.change24h < -0.01 ? 'td-dn' : 'td-flat';
            const cls7d = r.change7d > 0.01 ? 'td-up' : r.change7d < -0.01 ? 'td-dn' : 'td-flat';
            const barW = Math.max(3, (r.totalVol / maxVol) * 100);
            const barColor = r.change24h >= 0 ? '#00ff88' : '#ff3344';
            const volFmt = r.totalVol >= 1000 ? Math.round(r.totalVol / 1000) + 'K' : String(r.totalVol);

            return '<tr>' +
                '<td><div class="rsi-origin">' + flagImg(r.iso, 14) + ' ' + esc(r.label) + '</div></td>' +
                '<td>$' + r.avgPrice.toFixed(2) + '</td>' +
                '<td class="' + cls24 + '">' + (r.change24h >= 0 ? '+' : '') + r.change24h.toFixed(2) + '%</td>' +
                '<td class="' + cls7d + '">' + (r.change7d >= 0 ? '+' : '') + r.change7d.toFixed(2) + '%</td>' +
                '<td>' + r.volIdx.toFixed(1) + '</td>' +
                '<td><div class="rsi-bar-cell"><div class="rsi-bar-track"><div class="rsi-bar-fill" style="width:' + barW + '%;background:' + barColor + ';"></div></div><span>' + volFmt + '</span></div></td>' +
                '</tr>';
        }).join('') +
        '</tbody></table>';

    container.querySelectorAll('.rsi-table th[data-sc]').forEach(th => {
        th.addEventListener('click', () => {
            const c = th.dataset.sc;
            if (S.sortCol === c) S.sortDir = S.sortDir === 'asc' ? 'desc' : 'asc';
            else { S.sortCol = c; S.sortDir = 'desc'; }
            renderRSI();
        });
    });
}

// ═════════════════════════════════════════════════════════════════
// MODULE E — QUANT TEAR SHEET (Trading DNA)
// ═════════════════════════════════════════════════════════════════
function renderQuant() {
    const container = document.getElementById('quant-tear-sheet');
    if (!container) return;

    if (!S.user) {
        container.innerHTML =
            '<div class="qt-empty">' +
            '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="1.5"><circle cx="12" cy="7" r="4"/><path d="M5.5 21a7.5 7.5 0 0 1 13 0"/></svg>' +
            '<p>Sign in to see your personal quant analytics.</p>' +
            '<a href="/">Back to Terminal</a>' +
            '</div>';
        return;
    }

    if (!S.trades.length) {
        container.innerHTML =
            '<div class="qt-empty">' +
            '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="1.5"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-6"/></svg>' +
            '<p>No trades yet. Start trading to build your analytics profile.</p>' +
            '<a href="/">Start Trading</a>' +
            '</div>';
        return;
    }

    const trades = S.trades;
    let html = '';

    // Profit Factor
    let grossWins = 0, grossLosses = 0;
    trades.forEach(t => {
        const pnl = Number(t.pnl) || 0;
        if (pnl > 0) grossWins += pnl;
        else if (pnl < 0) grossLosses += Math.abs(pnl);
    });
    const pf = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;
    const pfStr = pf === Infinity ? '\u221E' : pf.toFixed(2);
    const pfCls = pf >= 1.5 ? 'green' : pf < 1 ? 'red' : '';
    const pfDesc = pf >= 2 ? 'Excellent edge' : pf >= 1.5 ? 'Positive expectancy' : pf >= 1 ? 'Break-even zone' : 'Negative expectancy';
    html += '<div class="qt-card"><div class="qt-label">Profit Factor</div><div class="qt-value ' + pfCls + '">' + pfStr + '</div><div class="qt-sub">' + pfDesc + ' | W $' + grossWins.toFixed(0) + ' / L $' + grossLosses.toFixed(0) + '</div></div>';

    // Sharpe Ratio (simplified: mean return / stdev of returns)
    const returns = trades.map(t => Number(t.pnl) || 0);
    const meanRet = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const variance = returns.length > 1 ? returns.reduce((s, r) => s + Math.pow(r - meanRet, 2), 0) / (returns.length - 1) : 0;
    const stdev = Math.sqrt(variance);
    const sharpe = stdev > 0 ? (meanRet / stdev) * Math.sqrt(252) : 0;
    const sharpeCls = sharpe >= 1 ? 'green' : sharpe < 0 ? 'red' : '';
    const sharpeDesc = sharpe >= 2 ? 'Outstanding' : sharpe >= 1 ? 'Good' : sharpe >= 0 ? 'Below average' : 'Negative';
    html += '<div class="qt-card"><div class="qt-label">Sharpe Ratio (Annualized)</div><div class="qt-value ' + sharpeCls + '">' + sharpe.toFixed(2) + '</div><div class="qt-sub">' + sharpeDesc + ' | Avg return: $' + meanRet.toFixed(2) + '</div></div>';

    // Win rate
    const totalTrades = trades.length;
    const wins = trades.filter(t => (Number(t.pnl) || 0) > 0).length;
    const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0.0';
    html += '<div class="qt-card"><div class="qt-label">Win Rate</div><div class="qt-value blue">' + winRate + '%</div><div class="qt-sub">' + wins + 'W / ' + (totalTrades - wins) + 'L from ' + totalTrades + ' trades</div></div>';

    // Asset affinity: highest win-rate grade
    const gradeMap = {};
    trades.forEach(t => {
        const sym = t.index_symbol || '';
        if (!sym) return;
        if (!gradeMap[sym]) gradeMap[sym] = { wins: 0, losses: 0, pnl: 0, count: 0, holdTimes: [] };
        gradeMap[sym].pnl += Number(t.pnl) || 0;
        gradeMap[sym].count++;
        if ((Number(t.pnl) || 0) > 0) gradeMap[sym].wins++;
        else gradeMap[sym].losses++;
        if (t.created_at && t.closed_at) {
            gradeMap[sym].holdTimes.push(new Date(t.closed_at) - new Date(t.created_at));
        }
    });
    const gradeEntries = Object.entries(gradeMap).sort((a, b) => b[1].pnl - a[1].pnl);
    const bestGrade = gradeEntries.length > 0 ? gradeEntries[0] : null;

    // Specialist badge
    if (bestGrade) {
        const [sym, data] = bestGrade;
        const wr = data.count > 0 ? ((data.wins / data.count) * 100).toFixed(0) : 0;
        const gradeType = sym.includes('DUST') || sym.includes('D1') ? 'Dust' :
            sym.includes('BP') ? 'BP' :
                sym.includes('PF') ? 'PF' :
                    sym.includes('FAN') ? 'Fannings' :
                        sym.split('-').pop() || sym;
        html += '<div class="qt-badge">' +
            '<div class="qt-badge-icon">\u03B1</div>' +
            '<div class="qt-badge-info">' +
            '<div class="qt-badge-title">"' + esc(gradeType) + ' Specialist"</div>' +
            '<div class="qt-badge-sub">' + esc(sym) + ' | ' + wr + '% WR | P&L $' + data.pnl.toFixed(2) + '</div>' +
            '</div>' +
            '</div>';
    }

    // Avg hold time
    let allHoldTimes = [];
    Object.values(gradeMap).forEach(g => { allHoldTimes = allHoldTimes.concat(g.holdTimes); });
    if (allHoldTimes.length > 0) {
        const avgMs = allHoldTimes.reduce((a, b) => a + b, 0) / allHoldTimes.length;
        const avgMin = Math.round(avgMs / 60000);
        const holdStr = avgMin >= 60 ? (avgMin / 60).toFixed(1) + 'h' : avgMin + 'm';
        html += '<div class="qt-card"><div class="qt-label">Avg Hold Time</div><div class="qt-value">' + holdStr + '</div><div class="qt-sub">Across ' + allHoldTimes.length + ' closed trades</div></div>';
    }

    // Drawdown
    let equity = 10000, peak = equity, maxDD = 0;
    trades.slice().reverse().forEach(t => {
        equity += Number(t.pnl) || 0;
        peak = Math.max(peak, equity);
        maxDD = Math.max(maxDD, peak > 0 ? ((peak - equity) / peak) * 100 : 0);
    });
    const currentDD = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    const ddLimit = 20;
    const ddPct = Math.min(currentDD / ddLimit * 100, 100);
    const ddColor = currentDD < 10 ? '#00ff88' : currentDD < 15 ? '#f59e0b' : '#ff3344';
    html += '<div class="qt-dd">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<div class="qt-label" style="margin:0;">Drawdown</div>' +
        '<div style="font-family:var(--text-mono);font-size:11px;font-weight:600;color:' + ddColor + ';">' + currentDD.toFixed(1) + '% / ' + ddLimit + '%</div>' +
        '</div>' +
        '<div class="qt-dd-bar-bg"><div class="qt-dd-bar-fill" style="width:' + ddPct + '%;background:' + ddColor + ';"></div></div>' +
        '<div class="qt-dd-ticks"><span>Safe</span><span>Caution</span><span>Danger</span></div>' +
        '</div>';

    // Max DD
    html += '<div class="qt-card"><div class="qt-label">Max Drawdown</div><div class="qt-value ' + (maxDD > 15 ? 'red' : '') + '">' + maxDD.toFixed(1) + '%</div><div class="qt-sub">Peak $' + peak.toFixed(0) + ' | Current $' + equity.toFixed(0) + '</div></div>';

    // Grade P&L breakdown
    if (gradeEntries.length > 0) {
        const maxAbsPnl = Math.max(...gradeEntries.map(([, d]) => Math.abs(d.pnl)), 1);
        html += '<div class="qt-card"><div class="qt-label">Grade P&L Breakdown</div></div><div class="qt-grades">';
        gradeEntries.slice(0, 10).forEach(([sym, data]) => {
            const isProfitable = data.pnl >= 0;
            const barW = (Math.abs(data.pnl) / maxAbsPnl) * 100;
            const barColor = isProfitable ? '#00ff88' : '#ff3344';
            html += '<div class="qt-grade-row">' +
                '<span class="qt-grade-sym">' + esc(sym) + '</span>' +
                '<div class="qt-grade-bar-bg"><div class="qt-grade-bar" style="width:' + barW + '%;background:' + barColor + ';"></div></div>' +
                '<span class="qt-grade-pnl" style="color:' + barColor + ';">' + (isProfitable ? '+' : '') + '$' + data.pnl.toFixed(2) + '</span>' +
                '</div>';
        });
        html += '</div>';
    }

    container.innerHTML = html;
}

// ═════════════════════════════════════════════════════════════════
// CSV EXPORT
// ═════════════════════════════════════════════════════════════════
function exportCSV() {
    const rows = getOriginMetrics();
    if (!rows.length) return;
    const headers = ['Origin', 'Region', 'Avg Price (USD)', '24h %', '7d %', 'Vol Index', 'Trade Volume'];
    const csv = [headers.join(',')];
    rows.forEach(r => {
        csv.push(['"' + r.label + '"', '"' + r.region + '"', r.avgPrice.toFixed(2), r.change24h.toFixed(2), r.change7d.toFixed(2), r.volIdx.toFixed(1), r.totalVol].join(','));
    });
    const blob = new Blob([csv.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'teatrade_rsi_' + new Date().toISOString().split('T')[0] + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
window.exportMatrixCSV = exportCSV;

// ═════════════════════════════════════════════════════════════════
// TICKER TAPE (replicates index.html global ticker)
// ═════════════════════════════════════════════════════════════════
const _ticker = { offset: 0, halfWidth: 0, lastHtml: '', animId: null, speed: 0.5 };

function _startTickerScroll() {
    const track = document.getElementById('global-ticker-track');
    if (!track || _ticker.animId) return;
    _ticker.halfWidth = track.scrollWidth / 2;
    function tick() {
        _ticker.offset += _ticker.speed;
        if (_ticker.halfWidth > 0 && _ticker.offset >= _ticker.halfWidth) _ticker.offset -= _ticker.halfWidth;
        track.style.transform = 'translateX(-' + _ticker.offset + 'px)';
        _ticker.animId = requestAnimationFrame(tick);
    }
    _ticker.animId = requestAnimationFrame(tick);
}

function updateGlobalTicker() {
    const track = document.getElementById('global-ticker-track');
    if (!track) return;
    const DASH = '\u2014';

    const macroItems = [
        { iso: 'ke', label: 'KES', key: 'usd_kes', prefix: '', decimals: 2 },
        { iso: 'in', label: 'INR', key: 'usd_inr', prefix: '', decimals: 2 },
        { iso: 'lk', label: 'LKR', key: 'usd_lkr', prefix: '', decimals: 2 },
        { iso: 'cn', label: 'CNY', key: 'usd_cny', prefix: '', decimals: 4 },
        { iso: null, label: 'OIL', key: 'brent_crude', prefix: '$', decimals: 2, fallback: 'OIL' },
    ];

    const hasData = macroItems.some(t => S.macro[t.key] != null && !isNaN(Number(S.macro[t.key])));
    if (!hasData && !S.teas.length) {
        if (!_ticker.lastHtml) track.innerHTML = '<div class="ticker-item ticker-loading"><span class="ticker-symbol">Waiting for market data...</span></div>';
        return;
    }

    function buildMacro() {
        return macroItems.map(t => {
            const raw = S.macro[t.key];
            const val = Number(raw);
            const baseline = Number(S.macroBaseline[t.key]);
            const tickerFlag = t.iso ? flagImg(t.iso, 14) : (t.fallback || '');
            if (raw == null || isNaN(val)) return '<div class="ticker-item"><span class="ticker-flag">' + tickerFlag + '</span><span class="ticker-symbol">' + t.label + '</span><span class="ticker-price">' + DASH + '</span></div>';
            const priceStr = t.prefix + val.toFixed(t.decimals);
            let changePct = 0;
            if (!isNaN(baseline) && baseline > 0) changePct = ((val - baseline) / baseline) * 100;
            const cc = changePct > 0 ? 'up' : changePct < 0 ? 'down' : '';
            const cs = changePct !== 0 ? (changePct >= 0 ? '+' : '') + changePct.toFixed(1) + '%' : DASH;
            return '<div class="ticker-item"><span class="ticker-flag">' + tickerFlag + '</span><span class="ticker-symbol">' + t.label + '</span><span class="ticker-price ' + cc + '">' + priceStr + '</span><span class="ticker-change ' + cc + '">' + cs + '</span></div>';
        }).join('');
    }

    function buildTeas() {
        if (!S.teas.length) return '';
        return S.teas.map(tea => {
            const price = Number(tea.current_price) || 0;
            const prev = Number(tea.previous_price) || price;
            const changePct = prev > 0 ? ((price - prev) / prev) * 100 : 0;
            const cc = changePct > 0.01 ? 'up' : changePct < -0.01 ? 'down' : '';
            const cs = Math.abs(changePct) > 0.01 ? (changePct >= 0 ? '+' : '') + changePct.toFixed(1) + '%' : '+0.0%';
            return '<div class="ticker-item ticker-tea"><span class="ticker-symbol">' + esc(tea.symbol) + '</span><span class="ticker-price ' + cc + '">$' + price.toFixed(2) + '</span><span class="ticker-change ' + cc + '">' + cs + '</span></div>';
        }).join('');
    }

    const sep = '<div class="ticker-separator">\u2502</div>';
    const onePass = buildMacro() + sep + buildTeas();
    if (onePass === _ticker.lastHtml) return;
    _ticker.lastHtml = onePass;

    const pctDone = _ticker.halfWidth > 0 ? _ticker.offset / _ticker.halfWidth : 0;
    track.innerHTML = onePass + onePass;
    _ticker.halfWidth = track.scrollWidth / 2;
    _ticker.offset = pctDone * _ticker.halfWidth;
    if (!_ticker.animId) _startTickerScroll();
}

// ═════════════════════════════════════════════════════════════════
// STATUS DOT & FOOTER CLOCK
// ═════════════════════════════════════════════════════════════════
function updateStatusDot() {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (!dot || !text) return;
    const source = S.macro.data_source;
    if (S.connected) {
        if (source === 'LIVE_FULL' || source === 'LIVE_FOREX' || source === 'LIVE_API') {
            dot.className = 'status-dot live'; text.textContent = 'Live';
        } else if (source === 'SIMULATED') {
            dot.className = 'status-dot simulated'; text.textContent = 'Simulated';
        } else {
            dot.className = 'status-dot live'; text.textContent = 'Connected';
        }
    } else {
        dot.className = 'status-dot waiting'; text.textContent = 'Connecting...';
    }
}

function updateFooterClock() {
    const el = document.getElementById('footer-last-update');
    if (el) {
        const now = new Date();
        el.textContent = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' }) + ' UTC';
    }
}
