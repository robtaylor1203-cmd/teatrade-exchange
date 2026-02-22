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

    // Trading Mode ('VIRTUAL' | 'REAL')
    tradingMode: 'VIRTUAL',

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

    // Pairs & Watchlist
    teaPairs: [],
    teaWatchlist: [],
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
        usd_idr: null,
        usd_bdt: null,
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
    // Country indexes
    { symbol: 'KENYA', name: 'Kenya Tea Index', teas: ['KEN-BP1', 'KEN-PF1', 'KEN-DUST', 'KEN-PD', 'KEN-BMF', 'KEN-FNGS'], color: 'var(--accent-green)', currency: '$', multiplier: 1, is_market_card: false },
    { symbol: 'INDIA', name: 'India Tea Index', teas: ['IND-ASM','IND-DRJ','KOL-SF','KOL-AUT','KOL-GOLD','GUW-BOP','GUW-BP','GUW-OF','GUW-PF','JAL-BOP','JAL-BP','JAL-DUST','JAL-PF','COC-BOP','COC-OP','COC-DUST','COC-PF','CMB-BOP','CMB-BP','CMB-DUST','CMB-OP','SIL-DRJ','SIL-BOP','SIL-DUST','SIL-FNGS','COO-BOP','COO-OP','COO-DUST','COO-PF'], color: 'var(--accent-orange)', currency: '$', multiplier: 1, is_market_card: false },
    { symbol: 'CEYLON', name: 'Ceylon Tea Index', teas: ['SRI-BOP', 'SRI-PEK', 'SRI-OP', 'SRI-FBOP', 'SRI-DUST', 'SRI-BOP1'], color: 'var(--accent-purple)', currency: '$', multiplier: 1, is_market_card: false },
    { symbol: 'INDONESIA', name: 'Indonesia Tea Index', teas: ['IDN-BOP', 'IDN-PF', 'IDN-DUST', 'IDN-BT'], color: 'var(--accent-teal)', currency: '$', multiplier: 1, is_market_card: false },
    { symbol: 'BANGLADESH', name: 'Bangladesh Tea Index', teas: ['BGD-BOP', 'BGD-BP', 'BGD-DUST', 'BGD-FNGS'], color: 'var(--accent-cyan)', currency: '$', multiplier: 1, is_market_card: false },
    { symbol: 'MALAWI', name: 'Malawi Tea Index', teas: ['MLW-BP1', 'MLW-PF1', 'MLW-DUST', 'MLW-FNGS'], color: 'var(--accent-green)', currency: '$', multiplier: 1, is_market_card: false },
    { symbol: 'AFRICA', name: 'African Tea Index', teas: ['KEN-BP1', 'KEN-PF1', 'KEN-DUST', 'KEN-PD', 'KEN-BMF', 'KEN-FNGS', 'MLW-BP1', 'MLW-PF1', 'MLW-DUST', 'MLW-FNGS', 'RWA-OP'], color: 'var(--accent-green)', currency: '$', multiplier: 1, is_market_card: false },
    { symbol: 'ASIA', name: 'Asian Tea Index', teas: ['IND-ASM','IND-DRJ','SRI-BOP','SRI-PEK','IDN-BOP','BGD-BOP','GUW-BOP','COC-OP','CMB-BOP','COO-BOP','SIL-DRJ','JAL-BOP'], color: 'var(--accent-blue)', currency: '$', multiplier: 1, is_market_card: false },
    // 12 Auction centre indexes
    { symbol: 'MOMBASA', name: 'Mombasa Auction Index', teas: ['KEN-BP1', 'KEN-PF1', 'KEN-DUST', 'KEN-PD', 'KEN-BMF', 'KEN-FNGS'], color: 'var(--accent-green)', currency: '$', multiplier: 1, is_market_card: true },
    { symbol: 'KOLKATA', name: 'Kolkata Auction Index', teas: ['IND-ASM', 'IND-DRJ', 'KOL-SF', 'KOL-AUT', 'KOL-GOLD'], color: 'var(--accent-orange)', currency: '\u20B9', multiplier: 83.5, forexKey: 'usd_inr', is_market_card: true },
    { symbol: 'COLOMBO', name: 'Colombo Auction Index', teas: ['SRI-BOP', 'SRI-PEK', 'SRI-OP', 'SRI-FBOP', 'SRI-DUST', 'SRI-BOP1'], color: 'var(--accent-purple)', currency: '\u20A8', multiplier: 305, forexKey: 'usd_lkr', is_market_card: true },
    { symbol: 'JAKARTA', name: 'Jakarta Auction Index', teas: ['IDN-BOP', 'IDN-PF', 'IDN-DUST', 'IDN-BT'], color: 'var(--accent-teal)', currency: 'Rp', multiplier: 15700, forexKey: 'usd_idr', is_market_card: false },
    { symbol: 'CHITTAGONG', name: 'Chittagong Auction Index', teas: ['BGD-BOP', 'BGD-BP', 'BGD-DUST', 'BGD-FNGS'], color: 'var(--accent-cyan)', currency: '\u09F3', multiplier: 110, forexKey: 'usd_bdt', is_market_card: false },
    { symbol: 'GUWAHATI', name: 'Guwahati Auction Index', teas: ['GUW-BOP', 'GUW-BP', 'GUW-OF', 'GUW-PF'], color: 'var(--accent-orange)', currency: '\u20B9', multiplier: 83.5, forexKey: 'usd_inr', is_market_card: false },
    { symbol: 'JALPAIGURI', name: 'Jalpaiguri Auction Index', teas: ['JAL-BOP', 'JAL-BP', 'JAL-DUST', 'JAL-PF'], color: 'var(--accent-amber)', currency: '\u20B9', multiplier: 83.5, forexKey: 'usd_inr', is_market_card: false },
    { symbol: 'COCHIN', name: 'Cochin Auction Index', teas: ['COC-BOP', 'COC-OP', 'COC-DUST', 'COC-PF'], color: 'var(--accent-lime)', currency: '\u20B9', multiplier: 83.5, forexKey: 'usd_inr', is_market_card: false },
    { symbol: 'COIMBATORE', name: 'Coimbatore Auction Index', teas: ['CMB-BOP', 'CMB-BP', 'CMB-DUST', 'CMB-OP'], color: 'var(--accent-yellow)', currency: '\u20B9', multiplier: 83.5, forexKey: 'usd_inr', is_market_card: false },
    { symbol: 'LIMBE', name: 'Limbe Auction Index', teas: ['MLW-BP1', 'MLW-PF1', 'MLW-DUST', 'MLW-FNGS'], color: 'var(--accent-green)', currency: '$', multiplier: 1, is_market_card: false },
    { symbol: 'SILIGURI', name: 'Siliguri Auction Index', teas: ['SIL-DRJ', 'SIL-BOP', 'SIL-DUST', 'SIL-FNGS'], color: 'var(--accent-pink)', currency: '\u20B9', multiplier: 83.5, forexKey: 'usd_inr', is_market_card: false },
    { symbol: 'COONOOR', name: 'Coonoor Auction Index', teas: ['COO-BOP', 'COO-OP', 'COO-DUST', 'COO-PF'], color: 'var(--accent-indigo)', currency: '\u20B9', multiplier: 83.5, forexKey: 'usd_inr', is_market_card: false },
    // Global composite
    { symbol: 'FUTURES', name: 'Global Tea Futures', teas: ['KEN-BP1', 'IND-ASM', 'SRI-BOP', 'IDN-BOP', 'BGD-BOP', 'MLW-BP1'], color: 'var(--accent-blue)', currency: '$', multiplier: 1000, is_market_card: true }
];

// Tea display data for auction table
const teaDisplayData = {
    // Kenya (Mombasa)
    'KEN-BP1':  { grade: 'BP1',   estate: 'Kenya BP1',                   origin: 'Kenya',      lot: 24604, qty: 22000, buyer: '\u2014', status: 'BIDDING' },
    'KEN-PF1':  { grade: 'PF1',   estate: 'Kenya PF1',                   origin: 'Kenya',      lot: 24606, qty: 18900, buyer: '\u2014', status: 'BIDDING' },
    'KEN-DUST': { grade: 'DUST1', estate: 'Kenya Dust 1',                origin: 'Kenya',      lot: 24605, qty: 5400,  buyer: '\u2014', status: 'BIDDING' },
    'KEN-PD':   { grade: 'PD',    estate: 'Kenya Pekoe Dust',            origin: 'Kenya',      lot: 24618, qty: 30000, buyer: '\u2014', status: 'BIDDING' },
    'KEN-BMF':  { grade: 'BMF',   estate: 'Kenya Broken Mixed Fanning',  origin: 'Kenya',      lot: 24619, qty: 8000,  buyer: '\u2014', status: 'BIDDING' },
    'KEN-FNGS': { grade: 'FNGS1', estate: 'Kenya Fannings',              origin: 'Kenya',      lot: 24620, qty: 6000,  buyer: '\u2014', status: 'BIDDING' },
    // Indonesia (Jakarta)
    'IDN-BOP':  { grade: 'BOP',  estate: 'Indonesia BOP',            origin: 'Indonesia',   lot: 24700, qty: 14000, buyer: '\u2014', status: 'BIDDING' },
    'IDN-PF':   { grade: 'PF',   estate: 'Indonesia Pekoe Fannings', origin: 'Indonesia',   lot: 24701, qty: 10500, buyer: '\u2014', status: 'BIDDING' },
    'IDN-DUST': { grade: 'DUST', estate: 'Indonesia Dust',           origin: 'Indonesia',   lot: 24702, qty: 8200,  buyer: '\u2014', status: 'BIDDING' },
    'IDN-BT':   { grade: 'BT',   estate: 'Indonesia Broken Tea',    origin: 'Indonesia',   lot: 24703, qty: 11300, buyer: '\u2014', status: 'BIDDING' },
    // Bangladesh (Chittagong)
    'BGD-BOP':  { grade: 'BOP',  estate: 'Bangladesh BOP',           origin: 'Bangladesh',  lot: 24710, qty: 12000, buyer: '\u2014', status: 'BIDDING' },
    'BGD-BP':   { grade: 'BP',   estate: 'Bangladesh Broken Pekoe',  origin: 'Bangladesh',  lot: 24711, qty: 9500,  buyer: '\u2014', status: 'BIDDING' },
    'BGD-DUST': { grade: 'DUST', estate: 'Bangladesh Dust',          origin: 'Bangladesh',  lot: 24712, qty: 7000,  buyer: '\u2014', status: 'BIDDING' },
    'BGD-FNGS': { grade: 'FNGS', estate: 'Bangladesh Fannings',      origin: 'Bangladesh',  lot: 24713, qty: 8800,  buyer: '\u2014', status: 'BIDDING' },
    // India — Guwahati (Assam CTC)
    'GUW-BOP':  { grade: 'BOP', estate: 'Assam CTC BOP',         origin: 'India',  lot: 24720, qty: 16000, buyer: '\u2014', status: 'BIDDING' },
    'GUW-BP':   { grade: 'BP',  estate: 'Assam CTC BP',          origin: 'India',  lot: 24721, qty: 13500, buyer: '\u2014', status: 'BIDDING' },
    'GUW-OF':   { grade: 'OF',  estate: 'Assam Orthodox Flowery', origin: 'India',  lot: 24722, qty: 7200,  buyer: '\u2014', status: 'BIDDING' },
    'GUW-PF':   { grade: 'PF',  estate: 'Assam CTC PF',          origin: 'India',  lot: 24723, qty: 11000, buyer: '\u2014', status: 'BIDDING' },
    // India — Jalpaiguri (Dooars/Terai)
    'JAL-BOP':  { grade: 'BOP',  estate: 'Dooars CTC BOP', origin: 'India',  lot: 24730, qty: 14500, buyer: '\u2014', status: 'BIDDING' },
    'JAL-BP':   { grade: 'BP',   estate: 'Dooars CTC BP',  origin: 'India',  lot: 24731, qty: 12000, buyer: '\u2014', status: 'BIDDING' },
    'JAL-DUST': { grade: 'DUST', estate: 'Terai CTC Dust', origin: 'India',  lot: 24732, qty: 9000,  buyer: '\u2014', status: 'BIDDING' },
    'JAL-PF':   { grade: 'PF',   estate: 'Terai CTC PF',  origin: 'India',  lot: 24733, qty: 10500, buyer: '\u2014', status: 'BIDDING' },
    // India — Kolkata (Darjeeling specialty)
    'IND-ASM':  { grade: 'ASM',  estate: 'Assam Orthodox',          origin: 'India',  lot: 24602, qty: 8200,  buyer: '\u2014', status: 'BIDDING' },
    'IND-DRJ':  { grade: 'DRJ',  estate: 'Darjeeling First Flush',  origin: 'India',  lot: 24603, qty: 15600, buyer: '\u2014', status: 'BIDDING' },
    'KOL-SF':   { grade: 'SF',   estate: 'Darjeeling Second Flush', origin: 'India',  lot: 24740, qty: 6800,  buyer: '\u2014', status: 'BIDDING' },
    'KOL-AUT':  { grade: 'AUT',  estate: 'Darjeeling Autumnal',     origin: 'India',  lot: 24741, qty: 9200,  buyer: '\u2014', status: 'BIDDING' },
    'KOL-GOLD': { grade: 'GOLD', estate: 'Darjeeling Gold Tip',     origin: 'India',  lot: 24742, qty: 3500,  buyer: '\u2014', status: 'BIDDING' },
    // Sri Lanka (Colombo)
    'SRI-BOP':  { grade: 'BOP',  estate: 'Ceylon BOP',          origin: 'Sri Lanka',  lot: 24609, qty: 14500, buyer: '\u2014', status: 'BIDDING' },
    'SRI-PEK':  { grade: 'PEK',  estate: 'Ceylon Pekoe',        origin: 'Sri Lanka',  lot: 24610, qty: 8700,  buyer: '\u2014', status: 'BIDDING' },
    'SRI-OP':   { grade: 'OP',   estate: 'Ceylon Orange Pekoe', origin: 'Sri Lanka',  lot: 24750, qty: 10200, buyer: '\u2014', status: 'BIDDING' },
    'SRI-FBOP': { grade: 'FBOP', estate: 'Ceylon Flowery BOP',  origin: 'Sri Lanka',  lot: 24751, qty: 7600,  buyer: '\u2014', status: 'BIDDING' },
    'SRI-DUST': { grade: 'DUST', estate: 'Ceylon Dust',          origin: 'Sri Lanka',  lot: 24752, qty: 6400,  buyer: '\u2014', status: 'BIDDING' },
    'SRI-BOP1': { grade: 'BOP1', estate: 'Ceylon BOP1',          origin: 'Sri Lanka',  lot: 24753, qty: 11800, buyer: '\u2014', status: 'BIDDING' },
    // India — Cochin (Kerala)
    'COC-BOP':  { grade: 'BOP',  estate: 'Kerala Orthodox BOP', origin: 'India',  lot: 24760, qty: 13000, buyer: '\u2014', status: 'BIDDING' },
    'COC-OP':   { grade: 'OP',   estate: 'Kerala Orange Pekoe', origin: 'India',  lot: 24761, qty: 9500,  buyer: '\u2014', status: 'BIDDING' },
    'COC-DUST': { grade: 'DUST', estate: 'Kerala CTC Dust',     origin: 'India',  lot: 24762, qty: 7800,  buyer: '\u2014', status: 'BIDDING' },
    'COC-PF':   { grade: 'PF',   estate: 'Kerala CTC PF',       origin: 'India',  lot: 24763, qty: 8600,  buyer: '\u2014', status: 'BIDDING' },
    // India — Coimbatore (Tamil Nadu)
    'CMB-BOP':  { grade: 'BOP',  estate: 'Tamil Nadu CTC BOP',     origin: 'India',  lot: 24770, qty: 15000, buyer: '\u2014', status: 'BIDDING' },
    'CMB-BP':   { grade: 'BP',   estate: 'Tamil Nadu CTC BP',      origin: 'India',  lot: 24771, qty: 12500, buyer: '\u2014', status: 'BIDDING' },
    'CMB-DUST': { grade: 'DUST', estate: 'Tamil Nadu CTC Dust',    origin: 'India',  lot: 24772, qty: 8000,  buyer: '\u2014', status: 'BIDDING' },
    'CMB-OP':   { grade: 'OP',   estate: 'Tamil Nadu Orthodox OP', origin: 'India',  lot: 24773, qty: 6500,  buyer: '\u2014', status: 'BIDDING' },
    // India — Siliguri (Darjeeling/Terai)
    'SIL-DRJ':  { grade: 'DRJ',  estate: 'Darjeeling Whole Leaf', origin: 'India',  lot: 24780, qty: 4500,  buyer: '\u2014', status: 'BIDDING' },
    'SIL-BOP':  { grade: 'BOP',  estate: 'Darjeeling BOP',        origin: 'India',  lot: 24781, qty: 7200,  buyer: '\u2014', status: 'BIDDING' },
    'SIL-DUST': { grade: 'DUST', estate: 'Terai Dust',            origin: 'India',  lot: 24782, qty: 9800,  buyer: '\u2014', status: 'BIDDING' },
    'SIL-FNGS': { grade: 'FNGS', estate: 'Terai Fannings',        origin: 'India',  lot: 24783, qty: 8500,  buyer: '\u2014', status: 'BIDDING' },
    // India — Coonoor (Nilgiris)
    'COO-BOP':  { grade: 'BOP',  estate: 'Nilgiri CTC BOP',     origin: 'India',  lot: 24790, qty: 14000, buyer: '\u2014', status: 'BIDDING' },
    'COO-OP':   { grade: 'OP',   estate: 'Nilgiri Orthodox OP',  origin: 'India',  lot: 24791, qty: 8800,  buyer: '\u2014', status: 'BIDDING' },
    'COO-DUST': { grade: 'DUST', estate: 'Nilgiri CTC Dust',    origin: 'India',  lot: 24792, qty: 7500,  buyer: '\u2014', status: 'BIDDING' },
    'COO-PF':   { grade: 'PF',   estate: 'Nilgiri CTC PF',      origin: 'India',  lot: 24793, qty: 9200,  buyer: '\u2014', status: 'BIDDING' },
    // Malawi (Limbe)
    'MLW-BP1':  { grade: 'BP1',  estate: 'Malawi BP1',      origin: 'Malawi',  lot: 24607, qty: 9800,  buyer: '\u2014', status: 'BIDDING' },
    'MLW-PF1':  { grade: 'PF1',  estate: 'Malawi PF1',      origin: 'Malawi',  lot: 24800, qty: 7600,  buyer: '\u2014', status: 'BIDDING' },
    'MLW-DUST': { grade: 'DUST', estate: 'Malawi Dust',     origin: 'Malawi',  lot: 24801, qty: 5500,  buyer: '\u2014', status: 'BIDDING' },
    'MLW-FNGS': { grade: 'FNGS', estate: 'Malawi Fannings', origin: 'Malawi',  lot: 24802, qty: 6200,  buyer: '\u2014', status: 'BIDDING' },
    // Rwanda
    'RWA-OP':   { grade: 'OP',   estate: 'Rwanda OP',       origin: 'Rwanda',  lot: 24608, qty: 6200,  buyer: '\u2014', status: 'BIDDING' },
    // Auction display variants
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
    '1D':  { points: 288, labels: ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00', '24:00'], labelFormat: 'time',  baseDate: new Date() },
    '1W':  { points: 168, labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],               labelFormat: 'day',   baseDate: new Date() },
    '1M':  { points: 180, labels: ['W1', 'W2', 'W3', 'W4'],                                        labelFormat: 'week',  baseDate: new Date() },
    '3M':  { points: 130, labels: ['M1', 'M2', 'M3'],                                              labelFormat: 'month', baseDate: new Date() },
    '1Y':  { points: 365, labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], labelFormat: 'month', baseDate: new Date() },
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
const _TRADE_TO_CARD = { 'KENYA': 'MOMBASA', 'INDIA': 'KOLKATA', 'CEYLON': 'COLOMBO', 'INDONESIA': 'JAKARTA', 'BANGLADESH': 'CHITTAGONG', 'MALAWI': 'LIMBE', 'ASIA': 'FUTURES' };
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

/**
 * Returns the active balance for the current trading mode.
 */
function getActiveBalance() {
    if (!state.userProfile) return 0;
    if (state.tradingMode === 'REAL') {
        return parseFloat(state.userProfile.real_balance ?? 0);
    }
    return parseFloat(state.userProfile.virtual_balance ?? state.userProfile.cash_balance ?? 0);
}

/**
 * Sets the active balance after a trade completes.
 */
function setActiveBalance(newBalance) {
    if (!state.userProfile) return;
    if (state.tradingMode === 'REAL') {
        state.userProfile.real_balance = newBalance;
    } else {
        state.userProfile.virtual_balance = newBalance;
        state.userProfile.cash_balance = newBalance;
    }
    updateBalanceDisplay();
    if (typeof updatePortfolioDisplay === 'function') updatePortfolioDisplay();
}

/**
 * Switch trading mode and refresh all mode-dependent data.
 */
function switchTradingMode(mode) {
    if (mode !== 'VIRTUAL' && mode !== 'REAL') return;
    state.tradingMode = mode;
    localStorage.setItem('teatrade_trading_mode', mode);

    const toggle = document.getElementById('mode-toggle');
    if (toggle) toggle.checked = (mode === 'REAL');

    const label = document.getElementById('mode-label');
    if (label) label.textContent = mode === 'REAL' ? 'REAL' : 'VIRTUAL';

    const indicator = document.getElementById('mode-indicator');
    if (indicator) {
        indicator.classList.toggle('mode-real', mode === 'REAL');
        indicator.classList.toggle('mode-virtual', mode !== 'REAL');
    }

    updateBalanceDisplay();
    if (state.currentUser) {
        loadPositions();
        loadIndexPositions();
        loadUserTrades();
    }
}

function updateBalanceDisplay() {
    const bal = getActiveBalance();
    const formatted = '$' + bal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const el = document.getElementById('user-balance');
    if (el) el.textContent = formatted;
    const tradeBal = document.getElementById('trade-balance');
    if (tradeBal) tradeBal.textContent = formatted;
}

// Stripe publishable key (safe for client-side)
const STRIPE_PUBLIC_KEY = 'pk_live_51T3irl4HRHSKpIgeZU3YMgZZW7RhueKvuQe1i49QVnDI2LXIlAbvg4brtursEJ0MkFxQOgyL4qqg1jVcISrmEZmq00g13ycKfH';

// =============================================
// ACCOUNT LOCKED / MONETIZATION HELPERS
// =============================================

function checkAccountStatus() {
    if (!state.userProfile) return;
    const status = state.userProfile.account_status;
    if (status === 'LOCKED') {
        showAccountLockedModal();
    }
}

function showAccountLockedModal() {
    const modal = document.getElementById('account-locked-modal');
    if (!modal) return;
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    const resetAt = state.userProfile?.next_free_reset_at;
    const timerEl = document.getElementById('locked-bailout-timer');
    const btnEl   = document.getElementById('locked-bailout-btn');

    if (resetAt && new Date(resetAt) <= new Date()) {
        if (timerEl) timerEl.textContent = 'Available now!';
        if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Claim $1,000 Bailout'; }
    } else if (resetAt) {
        const d = new Date(resetAt);
        const label = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
        if (timerEl) timerEl.textContent = `Available ${label}`;
        if (btnEl) { btnEl.disabled = true; btnEl.textContent = `Wait until ${label}`; }
    }
}

function closeAccountLockedModal() {
    const modal = document.getElementById('account-locked-modal');
    if (modal) { modal.classList.remove('active'); document.body.style.overflow = ''; }
}

async function purchaseAccountReset() {
    try {
        const result = await apiCreateCheckout('ACCOUNT_RESET');
        if (result?.url) {
            window.location.href = result.url;
        } else if (result?.error) {
            showToast('Checkout Error', result.error, true);
        }
    } catch (e) {
        showToast('Error', 'Could not start checkout', true);
    }
}

async function claimFreeBailout() {
    const resetAt = state.userProfile?.next_free_reset_at;
    if (resetAt && new Date(resetAt) > new Date()) {
        showToast('Not yet', 'Free bailout is not available yet', true);
        return;
    }
    try {
        const { data, error } = await apiClaimFreeBailout();
        if (error) { showToast('Error', error.message, true); return; }
        if (data?.success) {
            setActiveBalance(data.new_balance);
            state.userProfile.account_status = 'ACTIVE';
            closeAccountLockedModal();
            showToast('Bailout Claimed', 'You received $1,000. Trade wisely this time!');
        }
    } catch (e) {
        showToast('Error', 'Bailout failed', true);
    }
}

async function purchaseCombineEntry() {
    try {
        const result = await apiCreateCheckout('COMBINE_ENTRY');
        if (result?.url) {
            window.location.href = result.url;
        } else if (result?.error) {
            showToast('Checkout Error', result.error, true);
        }
    } catch (e) {
        showToast('Error', 'Could not start checkout', true);
    }
}

async function purchaseProSubscription() {
    try {
        const result = await apiCreateCheckout('PRO_SUBSCRIPTION');
        if (result?.url) {
            window.location.href = result.url;
        } else if (result?.error) {
            showToast('Checkout Error', result.error, true);
        }
    } catch (e) {
        showToast('Error', 'Could not start checkout', true);
    }
}

function handleCheckoutReturn() {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get('checkout');
    const product = params.get('product');
    if (!checkout) return;

    window.history.replaceState({}, '', window.location.pathname);

    if (checkout === 'success') {
        const msgs = {
            ACCOUNT_RESET: ['Account Reset!', 'Your balance has been restored to $10,000'],
            COMBINE_ENTRY: ['Combine Started!', 'Your $50,000 challenge account is live. Good luck!'],
            PRO_SUBSCRIPTION: ['Welcome to PRO!', 'You now have access to all premium features'],
        };
        const [title, msg] = msgs[product] || ['Payment Complete', 'Thank you!'];
        showToast(title, msg);
        setTimeout(() => location.reload(), 1500);
    } else if (checkout === 'cancelled') {
        showToast('Cancelled', 'Checkout was cancelled', true);
    }
}
