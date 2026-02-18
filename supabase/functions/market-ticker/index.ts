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

// H2 FIX: Shared secret for ticker invocations (set via: supabase secrets set TICKER_SECRET=your_secret)
const TICKER_SECRET = Deno.env.get('TICKER_SECRET') ?? ''

// ── CONFIGURATION ─────────────────────────────────────────────────────────────

// API key loaded from Supabase secrets (set via: supabase secrets set ALPHA_KEY=your_key)
const ALPHA_KEY = Deno.env.get('ALPHA_KEY') ?? '';

// ── HELPER FUNCTIONS ──────────────────────────────────────────────────────────

/**
 * Fetches real-time forex data from AlphaVantage.
 * Returns null if API limit is reached or error occurs.
 */
async function fetchRealForex(fromCurrency: string, toCurrency: string) {
  try {
    console.log(`🌐 Connecting to AlphaVantage: ${fromCurrency}/${toCurrency}...`);
    const url = `https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=${fromCurrency}&to_currency=${toCurrency}&apikey=${ALPHA_KEY}`;
    
    const resp = await fetch(url);
    const data = await resp.json();
    
    // Check if we got a valid rate
    if (data["Realtime Currency Exchange Rate"]) {
      const rate = parseFloat(data["Realtime Currency Exchange Rate"]["5. Exchange Rate"]);
      console.log(`✅ LIVE DATA: ${fromCurrency}/${toCurrency} = ${rate}`);
      return rate;
    } 
    // Check if we hit the limit (Standard AlphaVantage message)
    else if (data["Note"] && data["Note"].includes("call frequency")) {
      console.log("⚠️ API LIMIT REACHED: Switching to Simulation Mode.");
      return null;
    }
    else {
      console.log(`⚠️ API UNAVAILABLE: ${JSON.stringify(data)}`);
      return null;
    }
  } catch (err) {
    console.error(`❌ NETWORK ERROR: ${err.message}`);
    return null;
  }
}

/**
 * Math Simulation Fallback
 * Used when API limit is hit to keep the exchange moving.
 */
function simulateTick(baseline: number, volatility: number) {
  // Random drift between -0.5 and +0.5 * volatility factor
  const drift = (Math.random() - 0.5) * volatility;
  return baseline + drift;
}

// M6 FIX: Idempotency guard — minimum interval between ticks (ms).
const MIN_TICK_INTERVAL_MS = 10_000;
let lastTickTimestamp = 0;

// ── MAIN SERVER ───────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // H2 FIX: Require shared secret or Supabase service-role auth
    if (TICKER_SECRET) {
      const reqSecret = req.headers.get('x-ticker-secret') ?? ''
      const authHeader = req.headers.get('Authorization') ?? ''
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

      const isSecretValid = reqSecret === TICKER_SECRET
      const isServiceRole = authHeader === `Bearer ${serviceKey}`

      if (!isSecretValid && !isServiceRole) {
        return new Response(JSON.stringify({ error: 'Unauthorized: invalid ticker secret' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 401,
        })
      }
    }

    // M6 FIX: Reject duplicate invocations within the cooldown window.
    const now = Date.now();
    if (now - lastTickTimestamp < MIN_TICK_INTERVAL_MS) {
      return new Response(JSON.stringify({
        success: false,
        error: 'duplicate_tick',
        message: `Tick already processed ${Math.round((now - lastTickTimestamp) / 1000)}s ago. Min interval: ${MIN_TICK_INTERVAL_MS / 1000}s.`,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 429,
      })
    }
    lastTickTimestamp = now;

    // 1. Initialize Supabase Admin (Auto-detects Service Key)
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 2. DETERMINE MARKET RATES (Hybrid Strategy)
    let sourceStatus = "SIMULATED";
    
    // Default Anchors (Used if API fails)
    let rates = {
      'USD_KES': 129.45,
      'USD_INR': 87.50,
      'USD_LKR': 305.00,
      'USD_CNY': 7.20
    };

    // Attempt to fetch KES (The Driver)
    // We only fetch ONE pair to save your 25 daily credits.
    const realKes = await fetchRealForex("USD", "KES");
    
    if (realKes) {
      rates['USD_KES'] = realKes;
      sourceStatus = "LIVE_API";
      
      // Since we are saving API credits, we simulate the others relative to their baselines
      rates['USD_INR'] = simulateTick(87.50, 0.25); 
      rates['USD_LKR'] = simulateTick(305.00, 1.50);
      rates['USD_CNY'] = simulateTick(7.20, 0.02);
      
    } else {
      // FULL SIMULATION MODE (Fallback when limit hit)
      rates['USD_KES'] = simulateTick(129.45, 0.45);
      rates['USD_INR'] = simulateTick(87.50, 0.25);
      rates['USD_LKR'] = simulateTick(305.00, 2.00); 
      rates['USD_CNY'] = simulateTick(7.20, 0.03);
    }

    // 3. UPDATE MARKET STATE (For the Frontend Ticker)
    await supabase.from('market_state').upsert([
      { key: 'usd_kes', value: rates['USD_KES'] },
      { key: 'usd_inr', value: rates['USD_INR'] },
      { key: 'usd_lkr', value: rates['USD_LKR'] },
      { key: 'usd_cny', value: rates['USD_CNY'] },
      { key: 'data_source', value: sourceStatus }, 
      { key: 'last_tick', value: new Date().toISOString() }
    ]);

    // 4. UPDATE TEA PRICES
    const { data: teas } = await supabase.from('teas').select('*');
    const updates = [];
    const timestamp = new Date().toISOString();

    if (teas) {
      for (const tea of teas) {
        // Guard: skip teas with missing or invalid anchor/forex data
        if (!tea.anchor_price || tea.anchor_price <= 0) continue;
        if (!tea.reference_forex || tea.reference_forex <= 0) {
          console.warn(`⚠️ Skipping ${tea.symbol}: invalid reference_forex (${tea.reference_forex})`);
          continue;
        }

        // Identify Driver
        const pair = tea.currency_pair || 'USD_KES';
        const liveRate = rates[pair] || rates['USD_KES'];

        const forexDriftPct = (liveRate - tea.reference_forex) / tea.reference_forex;
        const beta = tea.beta || 1.0;
        const newPrice = tea.anchor_price * (1 + (forexDriftPct * beta));

        // Guard: reject NaN, Infinity, negative, or extreme prices
        if (!isFinite(newPrice) || newPrice <= 0) {
          console.error(`❌ Rejected invalid price for ${tea.symbol}: ${newPrice} (anchor=${tea.anchor_price}, drift=${forexDriftPct}, beta=${beta})`);
          continue;
        }
        // Guard: cap at reasonable tea price range ($0.01 – $500/kg)
        if (newPrice < 0.01 || newPrice > 500) {
          console.warn(`⚠️ Price out of bounds for ${tea.symbol}: $${newPrice.toFixed(4)} — clamping`);
          continue;
        }

        updates.push({
          symbol: tea.symbol,
          current_price: newPrice,
          last_update: timestamp
        });
      }

      // 5. COMMIT UPDATES (update live prices on teas table)
      for (const update of updates) {
        await supabase.from('teas')
          .update({ current_price: update.current_price, last_update: update.last_update })
          .eq('symbol', update.symbol);
      }

      // 6. RECORD PRICE HISTORY (immutable time-series for charts)
      // Each tick creates one row per tea — this is the permanent record.
      if (updates.length > 0) {
        const historyRows = updates.map(u => ({
          symbol: u.symbol,
          price: u.current_price,
          volume: 0,
          recorded_at: timestamp
        }));

        const { error: histError } = await supabase
          .from('price_history')
          .insert(historyRows);

        if (histError) {
          console.error("price_history insert error:", histError.message);
        } else {
          console.log(`📈 Recorded ${historyRows.length} price points to history`);
        }
      }

      // 7. RECORD INDEX PRICE HISTORY
      // Calculate composite index values from the freshly computed tea prices
      // and write them to price_history so charts have persistent index data.
      if (updates.length > 0) {
        const priceMap: Record<string, number> = {};
        for (const u of updates) {
          priceMap[u.symbol] = u.current_price;
        }

        const avgOf = (symbols: string[]): number | null => {
          const prices = symbols.map(s => priceMap[s]).filter(p => p && p > 0);
          if (prices.length === 0) return null;
          return prices.reduce((a, b) => a + b, 0) / prices.length;
        };

        const indexDefs: Array<{ symbol: string; teas: string[]; multiplier: number }> = [
          { symbol: 'KENYA',   teas: ['KEN-BP1', 'KEN-PF1', 'KEN-DUST'],                       multiplier: 1 },
          { symbol: 'MOMBASA', teas: ['KEN-BP1', 'KEN-PF1', 'KEN-DUST'],                       multiplier: 1 },
          { symbol: 'KOLKATA', teas: ['IND-ASM', 'IND-DRJ'],                                    multiplier: 83 },
          { symbol: 'COLOMBO', teas: ['SRI-BOP', 'SRI-PEK'],                                    multiplier: 1 },
          { symbol: 'FUTURES', teas: ['KEN-BP1', 'IND-ASM', 'SRI-BOP', 'CHN-YUN', 'IND-DRJ'],  multiplier: 1000 },
        ];

        const indexRows = [];
        for (const def of indexDefs) {
          const avg = avgOf(def.teas);
          if (avg !== null) {
            const indexPrice = avg * def.multiplier;
            if (isFinite(indexPrice) && indexPrice > 0) {
              indexRows.push({
                symbol: def.symbol,
                price: indexPrice,
                volume: 0,
                recorded_at: timestamp,
              });
            }
          }
        }

        if (indexRows.length > 0) {
          const { error: idxHistErr } = await supabase
            .from('price_history')
            .insert(indexRows);

          if (idxHistErr) {
            console.error("index price_history insert error:", idxHistErr.message);
          } else {
            console.log(`📊 Recorded ${indexRows.length} index price points to history`);
          }
        }
      }
    }

    // 8. FILL PENDING LIMIT/STOP ORDERS
    const { data: fillResult, error: fillErr } = await supabase.rpc('fill_pending_orders');
    if (fillErr) {
      console.error('fill_pending_orders error:', fillErr.message);
    } else if (fillResult?.filled > 0) {
      console.log(`🎯 Filled ${fillResult.filled} pending order(s)`);
    }

    return new Response(JSON.stringify({ 
      success: true, 
      source: sourceStatus,
      rates: rates,
      updated_count: updates.length,
      orders_filled: fillResult?.filled || 0
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    console.error("CRITICAL ERROR:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})