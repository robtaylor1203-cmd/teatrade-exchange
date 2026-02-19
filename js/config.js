/**
 * TeaTrade Exchange - Configuration & State
 * Supabase client, central state object, and all shared constants.
 * Loaded first. Every other module reads from `state` and `supabaseClient`.
 */

// Supabase
const SUPABASE_URL = 'https://uznxzyuknigzlxecjgtb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6bnh6eXVrbmlnemx4ZWNqZ3RiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA5Mzc5ODUsImV4cCI6MjA4NjUxMzk4NX0.BVOTqZ9kn2KCrNeF5675PNmMi9oJN3F6OoUnTtbpuIg';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Central mutable state (replaces all scattered globals)
const state = {
    // Auth
    currentUser: null,
    userProfile: null,

    // Data
    teas: [],
    positions: [],
    dbIndexes: [],
    indexPairs: [],
    originNames: {},
    indexPositions: {},

    // Chart
    currentTimeframe: '1W',
    chartType: 'line',
    chartData: [],
    teaHistoricalData: {},
    indexHistoricalData: {},
    mainChartData: { name: 'Kenyan Tea Price Index', symbol: 'KENYA', basePrice: 3.42, change: 2.4, currency: '$', volume: '8.2M', isIndex: true, isTea: false },
    chartMetrics: {},
    cachedTimeframe: null,
    activeStudies: { sma10: false, sma20: false, sma50: false, ema10: false, ema20: false, bollinger: false, rsi: false },

    // Trading
    tradeType: 'BUY',
    isTradeFormActive: false,
    pendingSlTpOrders: {},
    selectedQuoteSymbol: null,

    // Price tracking
    priceAlerts: {},
    previousAuctionPrices: {},
    previousQuotePrices: {},

    // Price data cache (unified, database-first)
    priceDataCache: { data: {}, loaded: {}, lastUpdate: {}, loading: {} },

    // Orders / trades
    currentTradesData: [],
    ordersSortColumn: 'time',
    ordersSortDirection: 'desc',
    ordersFilter: 'all',

    // Hub
    maximizedPanel: null,
    hubChartData: [],
    hubRsiHeight: 120,
    hubStudies: { sma10: false, sma20: false, bollinger: false, rsi: false },
    hubTimeframe: '1W',
    hubChartType: 'line',
    hubSelectedSymbol: null,
    hubSelectedSymbolType: null,

    // Quick Quote Modal
    qqCurrentTea: null,
    qqChartData: [],
    qqTimeframe: '1W',
    qqChartType: 'line',
    qqActiveIndicators: { sma: false, ema: false, bollinger: false },
    qqTradeType: 'BUY',

    // Multi-chart
    multiChartPanels: [],
    multiChartNextId: 1,

    // Chat
    chatMessages: [],
    chatSubscription: null,
    onlineUsers: new Set(),
    unreadChatCount: 0,

    // Pairs
    teaPairs: [],
    currentPairTrade: null,
    selectedLeverage: 1,
    pairsSortColumn: 'pair',
    pairsSortDirection: 'asc',

    // Market depth / trade log
    marketDepthBids: 52,
    tradeHistory: [],
    tradeLogInterval: null,

    // Live order-flow aggregates, keyed by symbol.
    // Structure: { 'KEN-BP1': { buy5m, sell5m, buy30m, sell30m,
    //               tradeCount5m, tradeCount30m, lastSide, lastQty, updatedAt } }
    // Populated instantly by market_pressure Realtime subscription.
    marketPressure: {},

    // Realtime subscriptions (replaces simulation intervals)
    tickerSubscription: null,
    macroSubscription: null,
    pressureSubscription: null,

    // Macro indicators (populated by market_state Realtime or initial fetch)
    macroIndicators: {
        usd_kes: null,
        usd_inr: null,
        usd_lkr: null,
        usd_cny: null,
        brent_crude: null
    },
    // Previous macro values for calculating change direction (last tick)
    previousMacro: {},

    // Baseline macro values captured on first live forex fetch.
    // Used to show "change since session opened" in the macro panel
    // (more meaningful than tick-to-tick micro-movements).
    macroBaseline: {},

    // Data source status ('LIVE_API' | 'SIMULATED' | null)
    dataSource: null,
    lastTick: null,

    // Price alert modal
    currentAlertSymbol: null
};

// Card data for market index cards
const cardData = [
    { name: 'Mombasa Auction Index', symbol: 'MOMBASA', basePrice: 2.87, change: 1.8, currency: '$', volume: '6.8M' },
    { name: 'Kolkata Tea Index', symbol: 'KOLKATA', basePrice: 267.45, change: 3.2, currency: '\u20B9', volume: '4.2M', forexKey: 'usd_inr' },
    { name: 'Colombo Index', symbol: 'COLOMBO', basePrice: 988.00, change: -1.8, currency: '\u20A8', volume: '5.1M', forexKey: 'usd_lkr' },
    { name: 'Global Tea Futures', symbol: 'FUTURES', basePrice: 3847, change: 0.7, currency: '$', volume: '12.4M' }
];

// Default index definitions (fallback if DB table empty)
const defaultDbIndexes = [
    { symbol: 'KENYA', name: 'Kenya Tea Index', teas: ['KEN-BP1', 'KEN-PF1', 'KEN-DUST', 'KEN-PD', 'KEN-BMF', 'KEN-FNGS'], color: 'var(--accent-green)', currency: '$', multiplier: 1, is_market_card: false },
    { symbol: 'INDIA', name: 'India Tea Index', teas: ['IND-ASM', 'IND-DRJ'], color: 'var(--accent-orange)', currency: '$', multiplier: 1, forexKey: null, is_market_card: false },
    { symbol: 'CEYLON', name: 'Ceylon Tea Index', teas: ['SRI-BOP', 'SRI-PEK'], color: 'var(--accent-purple)', currency: '$', multiplier: 1, forexKey: null, is_market_card: false },
    { symbol: 'CHINA', name: 'China Tea Index', teas: ['CHN-YUN'], color: 'var(--accent-red)', currency: '$', multiplier: 1, is_market_card: false },
    { symbol: 'AFRICA', name: 'African Tea Index', teas: ['KEN-BP1', 'KEN-PF1', 'KEN-DUST', 'KEN-PD', 'KEN-BMF', 'KEN-FNGS', 'MLW-BP1', 'RWA-OP'], color: 'var(--accent-green)', currency: '$', multiplier: 1, is_market_card: false },
    { symbol: 'ASIA', name: 'Asian Tea Index', teas: ['IND-ASM', 'IND-DRJ', 'SRI-BOP', 'SRI-PEK', 'CHN-YUN'], color: 'var(--accent-blue)', currency: '$', multiplier: 1, is_market_card: false },
    { symbol: 'MOMBASA', name: 'Mombasa Auction Index', teas: ['KEN-BP1', 'KEN-PF1', 'KEN-DUST', 'KEN-PD', 'KEN-BMF', 'KEN-FNGS'], color: 'var(--accent-green)', currency: '$', multiplier: 1, is_market_card: true },
    { symbol: 'KOLKATA', name: 'Kolkata Tea Index', teas: ['IND-ASM', 'IND-DRJ'], color: 'var(--accent-orange)', currency: '\u20B9', multiplier: 87.5, forexKey: 'usd_inr', is_market_card: true },
    { symbol: 'COLOMBO', name: 'Colombo Index', teas: ['SRI-BOP', 'SRI-PEK'], color: 'var(--accent-purple)', currency: '\u20A8', multiplier: 305, forexKey: 'usd_lkr', is_market_card: true },
    { symbol: 'FUTURES', name: 'Global Tea Futures', teas: ['KEN-BP1', 'IND-ASM', 'SRI-BOP', 'CHN-YUN', 'IND-DRJ'], color: 'var(--accent-blue)', currency: '$', multiplier: 1000, is_market_card: true }
];

// Tea display data for auction table
const teaDisplayData = {
    'CHN-YUN': { grade: 'YUN', estate: 'Yunnan Gold', origin: 'China', lot: 24601, qty: 12400, buyer: '\u2014', status: 'BIDDING' },
    'IND-ASM': { grade: 'ASM', estate: 'Assam Orthodox', origin: 'India', lot: 24602, qty: 8200, buyer: '\u2014', status: 'BIDDING' },
    'IND-DRJ': { grade: 'DRJ', estate: 'Darjeeling First Flush', origin: 'India', lot: 24603, qty: 15600, buyer: '\u2014', status: 'BIDDING' },
    'KEN-BP1':  { grade: 'BP1',   estate: 'Kenya BP1',                   origin: 'Kenya', lot: 24604, qty: 22000, buyer: '\u2014', status: 'BIDDING' },
    'KEN-DUST': { grade: 'DUST1', estate: 'Kenya Dust 1',                 origin: 'Kenya', lot: 24605, qty: 5400,  buyer: '\u2014', status: 'BIDDING' },
    'KEN-PF1':  { grade: 'PF1',   estate: 'Kenya PF1',                   origin: 'Kenya', lot: 24606, qty: 18900, buyer: '\u2014', status: 'BIDDING' },
    'KEN-PD':   { grade: 'PD',    estate: 'Kenya Pekoe Dust',            origin: 'Kenya', lot: 24618, qty: 30000, buyer: '\u2014', status: 'BIDDING' },
    'KEN-BMF':  { grade: 'BMF',   estate: 'Kenya Broken Mixed Fanning',  origin: 'Kenya', lot: 24619, qty: 8000,  buyer: '\u2014', status: 'BIDDING' },
    'KEN-FNGS': { grade: 'FNGS1', estate: 'Kenya Fannings',              origin: 'Kenya', lot: 24620, qty: 6000,  buyer: '\u2014', status: 'BIDDING' },
    'MLW-BP1': { grade: 'BP1', estate: 'Malawi BP1', origin: 'Malawi', lot: 24607, qty: 9800, buyer: '\u2014', status: 'BIDDING' },
    'RWA-OP': { grade: 'OP', estate: 'Rwanda OP', origin: 'Rwanda', lot: 24608, qty: 6200, buyer: '\u2014', status: 'BIDDING' },
    'SRI-BOP': { grade: 'BOP', estate: 'Ceylon BOP', origin: 'Sri Lanka', lot: 24609, qty: 14500, buyer: '\u2014', status: 'BIDDING' },
    'SRI-PEK': { grade: 'PEK', estate: 'Ceylon Pekoe', origin: 'Sri Lanka', lot: 24610, qty: 8700, buyer: '\u2014', status: 'BIDDING' },
    'CHN-YUN-2': { grade: 'YUN', estate: 'Yunnan Special Reserve', origin: 'China', lot: 24611, qty: 6300, buyer: '\u2014', status: 'BIDDING', priceFrom: 'CHN-YUN' },
    'IND-DRJ-2': { grade: 'DRJ', estate: 'Darjeeling Second Flush', origin: 'India', lot: 24612, qty: 11200, buyer: '\u2014', status: 'BIDDING', priceFrom: 'IND-DRJ' },
    'KEN-BP1-2': { grade: 'BP1', estate: 'Kenya Premium BP1', origin: 'Kenya', lot: 24613, qty: 19500, buyer: '\u2014', status: 'BIDDING', priceFrom: 'KEN-BP1' },
    'IND-ASM-2': { grade: 'ASM', estate: 'Assam Golden Tips', origin: 'India', lot: 24614, qty: 4800, buyer: '\u2014', status: 'BIDDING', priceFrom: 'IND-ASM' },
    'SRI-PEK-2': { grade: 'PEK', estate: 'Ceylon Highland Pekoe', origin: 'Sri Lanka', lot: 24615, qty: 9200, buyer: '\u2014', status: 'BIDDING', priceFrom: 'SRI-PEK' },
    'KEN-PF1-2': { grade: 'PF1', estate: 'Kenya Estate PF1', origin: 'Kenya', lot: 24616, qty: 16400, buyer: '\u2014', status: 'BIDDING', priceFrom: 'KEN-PF1' },
    'MLW-BP1-2': { grade: 'BP1', estate: 'Malawi Estate BP1', origin: 'Malawi', lot: 24617, qty: 7600, buyer: '\u2014', status: 'BIDDING', priceFrom: 'MLW-BP1' },
    'SRI-BOP-SOLD': { grade: 'BOP', estate: 'Ceylon Vintage BOP', origin: 'Sri Lanka', lot: 24500, qty: 7800, buyer: 'Tata Global', status: 'SOLD', soldPrice: 4.65, soldTime: 3, priceFrom: 'SRI-BOP' },
    'KEN-BP1-SOLD': { grade: 'BP1', estate: 'Kenya Select BP1', origin: 'Kenya', lot: 24501, qty: 11200, buyer: 'Unilever Tea', status: 'SOLD', soldPrice: 2.94, soldTime: 2, priceFrom: 'KEN-BP1' },
    'IND-DRJ-SOLD': { grade: 'DRJ', estate: 'Darjeeling Reserve', origin: 'India', lot: 24502, qty: 5400, buyer: 'Harrods Ltd', status: 'SOLD', soldPrice: 8.72, soldTime: 1, priceFrom: 'IND-DRJ' }
};

// Study indicator colors
const studyColors = {
    sma10: '#facc15', sma20: '#f59e0b', sma50: '#8b5cf6',
    ema10: '#34d399', ema20: '#10b981',
    bollinger: '#60a5fa', rsi: '#ec4899'
};

// Chart layout constants
const leftMargin = 60;
const rightMargin = 20;
const bottomMargin = 25;

// Timeframe configurations
const timeframeConfig = {
    '1D':  { points: 96,  labels: ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00', '24:00'], labelFormat: 'time',  baseDate: new Date() },
    '1W':  { points: 168, labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],               labelFormat: 'day',   baseDate: new Date() },
    '1M':  { points: 120, labels: ['W1', 'W2', 'W3', 'W4'],                                        labelFormat: 'week',  baseDate: new Date() },
    '3M':  { points: 130, labels: ['M1', 'M2', 'M3'],                                              labelFormat: 'month', baseDate: new Date() },
    '1Y':  { points: 280, labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], labelFormat: 'month', baseDate: new Date() },
    'ALL': { points: 800, labels: ['2022', '2023', '2024', '2025', '2026'],                        labelFormat: 'year',  baseDate: new Date() }
};

// Debounce delay for batching Realtime ticker updates into a single UI refresh (ms)
const TICKER_DEBOUNCE_MS = 200;

// Helper: get all index symbols from dbIndexes
function getIndexSymbols() {
    return (state.dbIndexes || []).map(idx => idx.symbol);
}

function isIndexSymbol(sym) {
    return getIndexSymbols().includes(sym);
}

/**
 * Resolve the display currency symbol for any trading symbol.
 * Checks market card mappings and dbIndexes for forex-converted indexes.
 * Returns '$' for USD, '₹' for INR, '₨' for LKR, etc.
 */
const _TRADE_TO_CARD = { 'KENYA': 'MOMBASA', 'INDIA': 'KOLKATA', 'CEYLON': 'COLOMBO', 'ASIA': 'FUTURES' };
function getCurrencyForSymbol(sym) {
    const cardSym = _TRADE_TO_CARD[sym] || sym;
    const idx = (state.dbIndexes || []).find(i => i.symbol === cardSym) ||
                (state.dbIndexes || []).find(i => i.symbol === sym);
    return idx?.currency || '$';
}

/**
 * Format a price with the correct currency for a given symbol.
 */
function formatSymbolPrice(price, sym) {
    const c = getCurrencyForSymbol(sym);
    if (!price || isNaN(price)) return c + '0.00';
    if (price >= 10000) return c + price.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    if (price >= 100) return c + price.toFixed(1);
    return c + price.toFixed(2);
}
