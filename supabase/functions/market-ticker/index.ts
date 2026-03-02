// TeaTrade Exchange — Global Market Engine (Hybrid: Live API + Simulation)
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// H1 FIX: Restrict CORS to production domain
const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') || '*'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// H2 FIX: Shared secret for ticker invocations
const TICKER_SECRET = Deno.env.get('TICKER_SECRET') ?? ''

// ── CONFIGURATION ─────────────────────────────────────────────────────────────

const FOREX_BASELINES: Record<string, number> = {
  USD_KES: 129.45,
  USD_INR: 87.50,
  USD_LKR: 305.00,
  USD_CNY: 7.20,
  USD_IDR: 15700,
  USD_BDT: 110.00,
};
const BRENT_BASELINE = 82.50;

// ── ORDER FLOW MARKET IMPACT MODEL ───────────────────────────────────────────
//
// Model: Kyle's Lambda with tanh bounding
//
// Background:
//   In a real exchange, buy/sell imbalance moves prices. If more traders are
//   buying than selling, dealers must raise their ask to attract more sellers;
//   if more are selling, bids are lowered to attract buyers. This is called
//   "market impact" or "price discovery from order flow".
//
// Our implementation:
//   1. Look back FLOW_WINDOW_MS (30 min) at all trades on the platform.
//   2. For each symbol: net_flow_kg = Σ buy_qty − Σ sell_qty
//   3. Normalise by FLOW_REFERENCE_VOL (5,000 kg = "a typical active 30 min").
//      raw_impact = net_flow_kg / FLOW_REFERENCE_VOL
//   4. Smooth & bound with tanh():
//      tanh(1.0) ≈ 0.76  → moderate pressure
//      tanh(3.0) ≈ 0.995 → near-maximum pressure
//      This prevents coordinated large orders from creating extreme spikes.
//   5. Scale to MAX_FLOW_IMPACT (±2% per tick at full pressure).
//   6. Multiply into the existing price as a final adjustment layer.
//
// Self-correcting property (no extra code needed):
//   Because we only look at the last 30 minutes, flow pressure fades
//   automatically. If buying stops, the effect decays to zero within
//   the window — built-in mean reversion without any explicit reversion code.
//
// ─────────────────────────────────────────────────────────────────────────────

// "Normal" trade volume per symbol within the look-back window.
// If net 5,000 kg of buy orders arrive in 30 minutes, that represents
// full buying pressure (~tanh input of 1.0 → ~76% of max impact).
const FLOW_REFERENCE_VOL = 5_000;   // kg

// How far back to look at trades
const FLOW_WINDOW_MS = 30 * 60_000; // 30 minutes

// Maximum price move per tick attributable to order flow (on top of
// forex/seasonal/noise effects). ±2% is aggressive for tea; keeps the
// market responsive to large user activity without being gameable.
const MAX_FLOW_IMPACT = 0.02;

// Weight blended between order flow and the external-factor price.
// 1.0 = full order flow influence; 0.0 = order flow disabled.
const FLOW_WEIGHT = 1.0;

/**
 * Hyperbolic tangent — smooth S-curve mapping any real number to (-1, +1).
 * Used to bound raw order flow impact regardless of trade volume magnitude.
 * Native Math.tanh exists in modern JS; this is a safe polyfill.
 */
function tanh(x: number): number {
  if (x > 20) return 1;
  if (x < -20) return -1;
  const e2x = Math.exp(2 * x);
  return (e2x - 1) / (e2x + 1);
}

/**
 * Fetch net order flow (buy_kg − sell_kg) per symbol for the last
 * FLOW_WINDOW_MS. Returns a map: { symbol → net_volume_kg }.
 * Positive values = net buying pressure; negative = net selling pressure.
 *
 * Covers both tea trades (looked up via tea_id → symbol) and direct
 * index trades (stored as index_symbol text).
 */
async function fetchOrderFlow(
  supabase: ReturnType<typeof createClient>,
  teas: Array<{ id: string; symbol: string }>
): Promise<Record<string, number>> {
  const since = new Date(Date.now() - FLOW_WINDOW_MS).toISOString();

  // Build reverse map: tea UUID → symbol string
  const teaIdToSymbol: Record<string, string> = {};
  for (const tea of teas) {
    teaIdToSymbol[tea.id] = tea.symbol;
  }

  const { data: recentTrades, error } = await supabase
    .from('trades')
    .select('tea_id, index_symbol, side, quantity')
    .gte('created_at', since)
    .not('side', 'is', null);

  if (error || !recentTrades) {
    console.warn('⚠️  Order flow fetch failed:', error?.message);
    return {};
  }

  const flowMap: Record<string, number> = {};

  for (const trade of recentTrades) {
    const symbol = trade.tea_id
      ? teaIdToSymbol[trade.tea_id]
      : trade.index_symbol;
    if (!symbol) continue;

    const qty = Number(trade.quantity) || 0;
    if (qty <= 0) continue;

    flowMap[symbol] = (flowMap[symbol] ?? 0) + (trade.side === 'BUY' ? qty : -qty);
  }

  const active = Object.entries(flowMap).filter(([, v]) => v !== 0);
  if (active.length > 0) {
    const summary = active
      .map(([s, v]) => `${s}:${v >= 0 ? '+' : ''}${v.toFixed(0)}kg`)
      .join('  ');
    console.log(`🔄 Order flow (30m): ${summary}`);
  } else {
    console.log('🔄 Order flow (30m): no user activity — external model only');
  }

  return flowMap;
}

// ── VOLATILITY & SEASONALITY MODEL ───────────────────────────────────────────

function gaussianRandom(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Per-tick volatility (σ_tick) — intentionally small.
 * Tea is not an equity; realistic weekly move target is ±1–3%.
 */
const TICK_VOL: Record<string, number> = {
  USD_KES: 0.0008,
  USD_INR: 0.0007,
  USD_LKR: 0.0010,
  USD_CNY: 0.0005,
  USD_IDR: 0.0006,
  USD_BDT: 0.0007,
};
const DEFAULT_TICK_VOL = 0.0008;

function getSeasonalFactor(currencyPair: string, symbol: string): number {
  const month = new Date().getUTCMonth() + 1;

  if (symbol === 'IND-DRJ') {
    if (month >= 3 && month <= 5) return 1.18;
    if (month >= 6 && month <= 8) return 1.07;
    if (month >= 9 && month <= 11) return 1.03;
    return 0.95;
  }
  if (symbol === 'IND-ASM') {
    if (month >= 4 && month <= 5) return 1.04;
    if (month >= 6 && month <= 9) return 0.96;
    return 1.0;
  }
  if (currencyPair === 'USD_KES') {
    if (month >= 1 && month <= 4) return 1.04;
    if (month >= 7 && month <= 11) return 0.96;
    return 1.01;
  }
  if (currencyPair === 'USD_LKR') {
    if (month >= 1 && month <= 3) return 1.06;
    if (month >= 7 && month <= 9) return 0.97;
    return 1.01;
  }
  if (currencyPair === 'USD_CNY') {
    if (month === 12 || month === 1) return 1.07;
    if (month >= 4 && month <= 6) return 1.03;
    return 1.0;
  }
  if (currencyPair === 'USD_IDR') {
    if (month >= 5 && month <= 9) return 1.03;
    if (month >= 11 || month <= 1) return 0.97;
    return 1.0;
  }
  if (currencyPair === 'USD_BDT') {
    if (month >= 6 && month <= 9) return 1.05;
    if (month >= 1 && month <= 3) return 0.97;
    return 1.0;
  }
  return 1.0;
}

function getBrentImpact(brentPrice: number): number {
  const deviation = (brentPrice - BRENT_BASELINE) / BRENT_BASELINE;
  return -(deviation * 0.12);
}

// ── LIVE DATA HELPERS ─────────────────────────────────────────────────────────

async function fetchAllForexRates(): Promise<Record<string, number> | null> {
  try {
    const resp = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.result !== 'success' || !data.rates) throw new Error('Bad response shape');
    console.log(`✅ LIVE FOREX: fetched ${Object.keys(data.rates).length} pairs`);
    return data.rates;
  } catch (err) {
    console.warn(`⚠️  Forex API unavailable: ${err.message} — using simulation`);
    return null;
  }
}

async function fetchBrentCrude(): Promise<number | null> {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?interval=1d&range=1d';
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!price || isNaN(price)) throw new Error('No price in response');
    console.log(`✅ LIVE BRENT: $${price}/bbl`);
    return price;
  } catch (err) {
    console.warn(`⚠️  Brent API unavailable: ${err.message} — using simulation`);
    return null;
  }
}

function simulateTick(baseline: number, volatility: number) {
  return parseFloat((baseline + (Math.random() - 0.5) * volatility).toFixed(4));
}

// M6 FIX: Idempotency guard
const MIN_TICK_INTERVAL_MS = 10_000;
let lastTickTimestamp = 0;

// ── MAIN SERVER ───────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // H2 FIX: Auth check
    if (TICKER_SECRET) {
      const reqSecret = req.headers.get('x-ticker-secret') ?? ''
      const authHeader = req.headers.get('Authorization') ?? ''
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      if (reqSecret !== TICKER_SECRET && authHeader !== `Bearer ${serviceKey}`) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401,
        })
      }
    }

    // Duplicate-tick guard
    const now = Date.now();
    if (now - lastTickTimestamp < MIN_TICK_INTERVAL_MS) {
      return new Response(JSON.stringify({
        success: false, error: 'duplicate_tick',
        message: `Too soon. Min interval: ${MIN_TICK_INTERVAL_MS / 1000}s.`,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 429 })
    }
    lastTickTimestamp = now;

    // 1. Supabase admin client
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 2. Fetch market data + order flow in parallel to minimise latency
    const [liveRates, liveBrent, teasResult] = await Promise.all([
      fetchAllForexRates(),
      fetchBrentCrude(),
      supabase.from('teas').select('*'),
    ]);

    const teas = teasResult.data ?? [];

    // 2.5 Generate background bot volume to drive prices naturally
    try {
      const { data: bot } = await supabase.from('profiles').select('id').eq('is_sim_bot', true).limit(1).single();
      if (bot && bot.id && teas.length > 0) {
        const newTrades = [];
        const getSide = () => Math.random() > 0.5 ? 'BUY' : 'SELL';

        // Pick 4 random teas
        const shuffledTeas = [...teas].sort(() => 0.5 - Math.random()).slice(0, 4);
        for (const tea of shuffledTeas) {
          if (!tea.current_price || tea.current_price <= 0) continue;
          const qty = Math.floor(Math.random() * 2000) + 100; // 100 to 2100 kg
          const slippage = tea.current_price * (Math.random() * 0.005 - 0.0025);
          const price = tea.current_price + slippage;
          newTrades.push({
            user_id: bot.id, tea_id: tea.id, symbol: tea.symbol, side: getSide(),
            quantity: qty, price: price, execution_price: price, total_value: qty * price,
            status: 'FILLED', trading_mode: 'REAL', notes: 'bot_ticker_inject'
          });
        }

        // Pick 2 random indexes
        const { data: indices } = await supabase.from('indexes').select('symbol, current_price');
        if (indices && indices.length > 0) {
          const shuffledIdx = [...indices].sort(() => 0.5 - Math.random()).slice(0, 2);
          for (const idx of shuffledIdx) {
            if (!idx.current_price || idx.current_price <= 0) continue;
            const qty = Math.floor(Math.random() * 50) + 10;
            const slippage = idx.current_price * (Math.random() * 0.005 - 0.0025);
            const price = idx.current_price + slippage;
            newTrades.push({
              user_id: bot.id, index_symbol: idx.symbol, symbol: idx.symbol, side: getSide(),
              quantity: qty, price: price, execution_price: price, total_value: qty * price,
              status: 'FILLED', trading_mode: 'REAL', notes: 'bot_ticker_inject'
            });
          }
        }

        if (newTrades.length > 0) {
          await supabase.from('trades').insert(newTrades);
          console.log(`🤖 Bot inserted ${newTrades.length} background trades`);
        }
      }
    } catch (botErr) {
      console.error('Bot injection error:', (botErr as Error).message);
    }

    // 3. Fetch order flow (needs teas for id→symbol map, so slightly after)
    const orderFlow = await fetchOrderFlow(supabase, teas);

    let sourceStatus = 'SIMULATED';

    const pick = (liveKey: string, fallback: number, vol: number): number =>
      liveRates?.[liveKey] != null ? liveRates[liveKey] : simulateTick(fallback, vol);

    const rates = {
      USD_KES: pick('KES', FOREX_BASELINES.USD_KES, 0.45),
      USD_INR: pick('INR', FOREX_BASELINES.USD_INR, 0.25),
      USD_LKR: pick('LKR', FOREX_BASELINES.USD_LKR, 2.00),
      USD_CNY: pick('CNY', FOREX_BASELINES.USD_CNY, 0.03),
      USD_IDR: pick('IDR', FOREX_BASELINES.USD_IDR, 15.0),
      USD_BDT: pick('BDT', FOREX_BASELINES.USD_BDT, 0.30),
    };

    const brentPrice = liveBrent ?? simulateTick(BRENT_BASELINE, 0.35);

    if (liveRates) sourceStatus = liveBrent ? 'LIVE_FULL' : 'LIVE_FOREX';

    console.log(`📊 Rates — KES:${rates.USD_KES.toFixed(2)} INR:${rates.USD_INR.toFixed(2)} BRENT:${brentPrice.toFixed(2)}`);

    // 4. Update market_state for the frontend ticker
    await supabase.from('market_state').upsert([
      { key: 'usd_kes', value: rates.USD_KES },
      { key: 'usd_inr', value: rates.USD_INR },
      { key: 'usd_lkr', value: rates.USD_LKR },
      { key: 'usd_cny', value: rates.USD_CNY },
      { key: 'usd_idr', value: rates.USD_IDR },
      { key: 'usd_bdt', value: rates.USD_BDT },
      { key: 'brent_crude', value: brentPrice },
      { key: 'data_source', value: sourceStatus },
      { key: 'last_tick', value: new Date().toISOString() },
    ]);

    // 5. Compute new prices for all teas
    const updates: Array<{
      symbol: string; current_price: number; last_update: string;
      trading_mode?: string; halt_until?: string | null; volatility_multiplier?: number;
    }> = [];
    const timestamp = new Date().toISOString();

    for (const tea of teas) {
      if (!tea.anchor_price || tea.anchor_price <= 0) continue;
      if (!tea.reference_forex || tea.reference_forex <= 0) {
        console.warn(`⚠️  Skipping ${tea.symbol}: invalid reference_forex`);
        continue;
      }

      const rawPair = (tea.currency_pair || 'usd_kes').toUpperCase();
      const liveRate = rates[rawPair] ?? rates['USD_KES'];

      // ── Layer 1: Macro / external factors ──────────────────────────────
      // Forex drift: how much has the currency moved from reference?
      // Capped at ±3% total forex contribution regardless of drift magnitude.
      const rawForexDrift = (liveRate - tea.reference_forex) / tea.reference_forex;
      const beta = Math.min(tea.beta || 1.0, 2.0);
      const forexEffect = Math.max(-0.03, Math.min(0.03, rawForexDrift * beta));
      const forexAdjusted = tea.anchor_price * (1 + forexEffect);

      // Seasonal harvest calendar
      const seasonal = getSeasonalFactor(rawPair, tea.symbol);

      // Brent crude shipping-cost pass-through (inverse, dampened)
      const brentEffect = getBrentImpact(brentPrice);

      // PHASE 6: Disable Gaussian noise generation for the Live Scraped Market Transition.
      // const σ = TICK_VOL[rawPair] ?? DEFAULT_TICK_VOL;
      // const noise = gaussianRandom() * σ;
      const noise = 0;

      // Combined external-factor price (same formula as before adding flow)
      const externalPrice = forexAdjusted * seasonal * (1 + noise) * (1 + brentEffect);

      // ── Layer 2: Order Flow Market Impact ──────────────────────────────
      //
      // This is the new ecosystem layer.
      //
      // net_flow_kg: positive = more buying than selling in the last 30 min.
      //              negative = more selling than buying.
      //
      // raw_impact: raw_impact = net_flow_kg / FLOW_REFERENCE_VOL
      //   FLOW_REFERENCE_VOL = 5,000 kg.
      //   Buying 5,000 kg net → raw_impact = 1.0
      //   Buying 500 kg net  → raw_impact = 0.1 (small nudge)
      //
      // tanh(raw_impact): S-curve bounding to (-1, +1).
      //   Ensures that a sudden surge of e.g. 100,000 kg buy orders
      //   creates the same maximum impact as 15,000 kg — not a 20×
      //   spike. This mirrors how real liquidity providers defend prices.
      //
      // flowEffect: the final price adjustment factor (bounded to ±2%).
      //   Positive = price nudged up.   Negative = price nudged down.
      //
      const netFlowKg = (orderFlow[tea.symbol] ?? 0) * FLOW_WEIGHT;
      const rawImpact = netFlowKg / FLOW_REFERENCE_VOL;
      const boundedImpact = tanh(rawImpact);
      const flowEffect = boundedImpact * MAX_FLOW_IMPACT;

      // Final price: external model × (1 + order flow adjustment)
      const newPrice = externalPrice * (1 + flowEffect);

      // ── Validity guards ─────────────────────────────────────────────────
      if (!isFinite(newPrice) || newPrice <= 0) {
        console.error(`❌ Rejected invalid price for ${tea.symbol}: ${newPrice}`);
        continue;
      }
      // Sanity: CLAMP to ±15% of anchor rather than skipping.
      // Skipping caused charts to go permanently flat when stress tests or
      // large trades pushed prices outside the band — the cron would then
      // never update those symbols again. Clamping ensures prices always
      // drift back toward anchor over subsequent ticks.
      let clampedPrice = newPrice;
      if (newPrice < tea.anchor_price * 0.85) {
        clampedPrice = tea.anchor_price * 0.85;
      } else if (newPrice > tea.anchor_price * 1.15) {
        clampedPrice = tea.anchor_price * 1.15;
      }
      if (clampedPrice !== newPrice) {
        console.warn(`⚠️  ${tea.symbol} clamped $${newPrice.toFixed(4)} → $${clampedPrice.toFixed(4)} (±15% anchor)`);
      }
      const finalPrice = clampedPrice;

      if (flowEffect !== 0) {
        console.log(`   ${tea.symbol}: flow ${netFlowKg >= 0 ? '+' : ''}${netFlowKg.toFixed(0)}kg → impact ${(flowEffect * 100).toFixed(3)}%`);
      }

      // ── RISK ENGINE: Circuit Breaker, Dynamic Spread, Close-Only ──────
      const prevPrice = Number(tea.current_price) || finalPrice;
      const tickChange = prevPrice > 0 ? Math.abs(finalPrice - prevPrice) / prevPrice : 0;
      const currentMode: string = tea.trading_mode || 'FULL';
      const currentMult: number = Number(tea.volatility_multiplier) || 1.0;
      const maxExp: number = Number(tea.max_exposure) || 500_000;
      const longVol: number = Number(tea.current_long_volume) || 0;
      const shortVol: number = Number(tea.current_short_volume) || 0;

      const updateObj: typeof updates[number] = {
        symbol: tea.symbol,
        current_price: tea.anchor_price, // PHASE 6: Force static prices until Scraper updates Anchor Price
        last_update: timestamp,
      };

      // --- Circuit breaker: >10% single-tick move → HALT for 5 minutes ---
      if (tickChange > 0.10 && currentMode !== 'HALTED') {
        updateObj.trading_mode = 'HALTED';
        updateObj.halt_until = new Date(Date.now() + 5 * 60_000).toISOString();
        updateObj.volatility_multiplier = 3.0;
        console.log(`🛑 CIRCUIT BREAKER: ${tea.symbol} halted (${(tickChange * 100).toFixed(1)}% move)`);

      } else if (currentMode === 'HALTED') {
        // Check if halt period expired → restore to FULL
        const haltUntil = tea.halt_until ? new Date(tea.halt_until).getTime() : 0;
        if (haltUntil > 0 && Date.now() >= haltUntil) {
          updateObj.trading_mode = 'FULL';
          updateObj.halt_until = null;
          updateObj.volatility_multiplier = Math.max(1.0, currentMult * 0.7);
          console.log(`✅ UN-HALT: ${tea.symbol} restored to FULL trading`);
        }
        // While halted, keep existing mode (don't overwrite)

      } else {
        // --- Dynamic symmetric spread via volatility_multiplier ---
        if (tickChange > 0.03) {
          // High volatility (3-10%) → widen spread up to 3x
          updateObj.volatility_multiplier = Math.min(3.0, 1.0 + (tickChange / 0.03));
        } else if (currentMult > 1.0) {
          // Low volatility → decay multiplier back toward 1.0
          updateObj.volatility_multiplier = Math.max(1.0, currentMult * 0.95);
        }

        // --- Close-Only trigger at 95% exposure ---
        if (longVol >= maxExp * 0.95 || shortVol >= maxExp * 0.95) {
          if (currentMode !== 'CLOSE_ONLY') {
            updateObj.trading_mode = 'CLOSE_ONLY';
            console.log(`⚠️  CLOSE_ONLY: ${tea.symbol} (long:${longVol.toFixed(0)} short:${shortVol.toFixed(0)} / max:${maxExp})`);
          }
        } else if (currentMode === 'CLOSE_ONLY' && longVol < maxExp * 0.90 && shortVol < maxExp * 0.90) {
          // Exposure dropped below 90% → restore full trading
          updateObj.trading_mode = 'FULL';
          console.log(`✅ FULL restored: ${tea.symbol} (exposure eased)`);
        }
      }

      updates.push(updateObj);
    }

    // 6. Commit price + risk updates
    for (const update of updates) {
      const payload: Record<string, unknown> = {
        current_price: update.current_price,
        last_update: update.last_update,
      };
      if (update.trading_mode !== undefined) payload.trading_mode = update.trading_mode;
      if (update.halt_until !== undefined) payload.halt_until = update.halt_until;
      if (update.volatility_multiplier !== undefined) payload.volatility_multiplier = update.volatility_multiplier;

      await supabase.from('teas')
        .update(payload)
        .eq('symbol', update.symbol);
    }

    // 7. Record price history (immutable time-series) — only every 5 minutes.
    //
    // The cron runs every 60 s.  Writing price_history on every tick produces
    // ~2,880 rows/day per symbol.  The 1D chart uses 5-minute candles and only
    // needs 288 rows/day — fetching thousands of sub-minute rows saturates the
    // query LIMIT and leaves most of the chart X-axis blank.
    //
    // By gating the write to minutes that are divisible by 5 we write exactly
    // 288 rows/day, which is the perfect density for a 5-minute candle chart and
    // still well within the capacity of the longer timeframes.
    const tickMinute = new Date(timestamp).getMinutes();
    const writeHistory = (tickMinute % 5) === 0;

    if (writeHistory && updates.length > 0) {
      const historyRows = updates.map(u => ({
        symbol: u.symbol,
        price: u.current_price,
        volume: 0,
        recorded_at: timestamp,
        is_simulated: false,
      }));

      const { error: histError } = await supabase
        .from('price_history')
        .insert(historyRows);

      if (histError) console.error('price_history insert error:', histError.message);
      else console.log(`📈 Recorded ${historyRows.length} price points`);
    }

    // 8. Record composite index price history for ALL indexes in the DB.
    // We load compositions from the `indexes` table (single source of truth)
    // so every index that clients can trade also gets a price_history row each
    // tick — including INDIA, CEYLON, CHINA, AFRICA, ASIA which were previously
    // missing and left those charts with no historical data.
    // Same 5-minute gate as the tea price history above.
    if (writeHistory && updates.length > 0) {
      const priceMap: Record<string, number> = {};
      for (const u of updates) priceMap[u.symbol] = u.current_price;

      const avgOf = (symbols: string[]): number | null => {
        const prices = symbols.map(s => priceMap[s]).filter(p => p != null && p > 0);
        if (!prices.length) return null;
        return prices.reduce((a: number, b: number) => a + b, 0) / prices.length;
      };

      // Fetch all index definitions from DB — same source the client uses
      const { data: allIndexes } = await supabase
        .from('indexes')
        .select('symbol, teas, multiplier');

      const indexRows: Array<{ symbol: string; price: number; volume: number; recorded_at: string; is_simulated: boolean }> = [];
      for (const idx of (allIndexes || [])) {
        const avg = avgOf(idx.teas || []);
        if (avg !== null && isFinite(avg) && avg > 0) {
          indexRows.push({ symbol: idx.symbol, price: avg, volume: 0, recorded_at: timestamp, is_simulated: false });
        }
      }

      if (indexRows.length > 0) {
        const { error: idxErr } = await supabase.from('price_history').insert(indexRows);
        if (idxErr) console.error('index history error:', idxErr.message);
        else console.log(`📊 Recorded ${indexRows.length} index price points (${indexRows.map(r => r.symbol).join(', ')})`);
      }
    }

    // 9. Fill any triggered pending limit / stop orders
    const { data: fillResult, error: fillErr } = await supabase.rpc('fill_pending_orders');
    if (fillErr) console.error('fill_pending_orders error:', fillErr.message);
    else if (fillResult?.filled > 0) console.log(`🎯 Filled ${fillResult.filled} pending order(s)`);

    // 10. Stop-out check — liquidate users whose equity < 50% of used margin
    const { data: stopOutResult, error: stopOutErr } = await supabase.rpc('check_stop_outs');
    if (stopOutErr) console.error('check_stop_outs error:', stopOutErr.message);
    else if (stopOutResult?.users_liquidated > 0) console.log(`🛑 Stop-out: liquidated ${stopOutResult.users_liquidated} user(s)`);

    // 11. Process server-side Stop Loss / Take Profit
    const { data: slTpResult, error: slTpErr } = await supabase.rpc('process_sl_tp');
    if (slTpErr) console.error('process_sl_tp error:', slTpErr.message);
    else if (slTpResult?.closed > 0) console.log(`🎯 SL/TP: auto-closed ${slTpResult.closed} position(s)`);

    // 12. Update rolling 24h trade volumes
    const { error: volErr } = await supabase.rpc('update_volume_24h');
    if (volErr) console.error('update_volume_24h error:', volErr.message);

    // 13. Combine challenge monitoring — check active combines for drawdown/victory/expiry
    try {
      const { data: activeCombines } = await supabase
        .from('combine_challenges')
        .select('id, user_id')
        .eq('status', 'ACTIVE');

      if (activeCombines && activeCombines.length > 0) {
        let passed = 0, failed = 0;
        for (const c of activeCombines) {
          const { data: result } = await supabase.rpc('check_combine_rules', { p_user_id: c.user_id });
          if (result && !result.active) {
            if (result.result === 'PASSED') passed++;
            else if (result.result === 'FAILED' || result.result === 'EXPIRED') failed++;
          }
        }
        if (passed > 0 || failed > 0) {
          console.log(`🏆 Combines: ${passed} passed, ${failed} failed/expired`);
        }
        // Daily equity reset is handled inside check_combine_rules() via last_equity_reset_date
      }
    } catch (combineErr) {
      console.error('Combine monitoring error:', (combineErr as Error).message);
    }

    return new Response(JSON.stringify({
      success: true,
      source: sourceStatus,
      rates: { ...rates, brent_crude: brentPrice },
      updated_count: updates.length,
      orders_filled: fillResult?.filled || 0,
      flow_active_symbols: Object.keys(orderFlow).filter(k => orderFlow[k] !== 0).length,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    console.error('CRITICAL ERROR:', error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500,
    })
  }
})
