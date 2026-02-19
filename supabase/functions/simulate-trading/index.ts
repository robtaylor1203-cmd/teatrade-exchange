// TeaTrade Exchange — Autonomous Market Maker Bots
// =================================================
// Self-sustaining trading bots that run entirely server-side via pg_cron.
// Creates realistic trader accounts on first run, then trades every minute.
//
// Actions:
//   - "tick"    (default) — create missing bots + place trades (called by pg_cron)
//   - "cleanup" — remove ALL bot users, trades, positions, profiles
//
// All bots use @teatrade.sim emails for complete isolation from real users.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-ticker-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ── REALISTIC TRADER PROFILES ────────────────────────────────────────────────
// Diverse international names appropriate for a global tea exchange.
// Each has a trading personality that governs their behaviour.

interface BotDef {
  name: string
  archetype: 'momentum' | 'contrarian' | 'scalper' | 'whale' | 'passive'
  preferredRegion?: string  // bias toward teas from this region
}

const BOT_TRADERS: BotDef[] = [
  // East African market specialists
  { name: 'James Okafor',      archetype: 'whale',      preferredRegion: 'KEN' },
  { name: 'Grace Muthoni',     archetype: 'momentum',   preferredRegion: 'KEN' },
  { name: 'Daniel Njoroge',    archetype: 'scalper',     preferredRegion: 'KEN' },
  { name: 'Amara Traore',      archetype: 'passive',     preferredRegion: 'MLW' },
  { name: 'Hassan Diallo',     archetype: 'contrarian',  preferredRegion: 'RWA' },
  { name: 'Nadia Osei',        archetype: 'scalper',     preferredRegion: 'KEN' },
  // South Asian tea traders
  { name: 'Priya Sharma',      archetype: 'momentum',   preferredRegion: 'IND' },
  { name: 'Raj Malhotra',      archetype: 'whale',      preferredRegion: 'IND' },
  { name: 'Ananya Reddy',      archetype: 'scalper',     preferredRegion: 'IND' },
  { name: 'David Singh',       archetype: 'passive',     preferredRegion: 'IND' },
  { name: 'Zara Hussain',      archetype: 'contrarian',  preferredRegion: 'SRI' },
  { name: 'Arjun Fernando',    archetype: 'momentum',   preferredRegion: 'SRI' },
  // East Asian traders
  { name: 'Marcus Chen',       archetype: 'whale',      preferredRegion: 'CHN' },
  { name: 'Mei Lin Wu',        archetype: 'scalper',     preferredRegion: 'CHN' },
  { name: 'Ayumi Tanaka',      archetype: 'contrarian' },
  { name: 'Yuki Watanabe',     archetype: 'scalper' },
  { name: 'Stephen Kwon',      archetype: 'momentum' },
  { name: 'Victoria Chang',    archetype: 'passive',     preferredRegion: 'CHN' },
  // European / Western institutional traders
  { name: 'Oliver Bennett',    archetype: 'whale' },
  { name: 'Elena Volkov',      archetype: 'momentum' },
  { name: 'Thomas Wright',     archetype: 'passive' },
  { name: 'Anna Kowalski',     archetype: 'scalper' },
  { name: 'Carlos Mendez',     archetype: 'contrarian' },
  { name: 'Lucas Andersen',    archetype: 'whale' },
  { name: 'Patrick O\'Brien',  archetype: 'scalper' },
  { name: 'Emily Watson',      archetype: 'passive' },
  // Global / multi-region traders
  { name: 'Sarah Patel',       archetype: 'scalper' },
  { name: 'Ryan Campbell',     archetype: 'momentum' },
  { name: 'Benjamin Scott',    archetype: 'contrarian' },
  { name: 'Robert Kim',        archetype: 'passive' },
]

const ARCHETYPES = {
  momentum:   { buyBias: 0.65, qtyRange: [500, 4000] },
  contrarian: { buyBias: 0.38, qtyRange: [300, 2500] },
  scalper:    { buyBias: 0.52, qtyRange: [100, 800] },
  whale:      { buyBias: 0.55, qtyRange: [3000, 10000] },
  passive:    { buyBias: 0.50, qtyRange: [200, 1500] },
}

const TEA_SYMBOLS = [
  'KEN-BP1', 'KEN-PF1', 'KEN-DUST', 'KEN-PD', 'KEN-BMF', 'KEN-FNGS',
  'IND-ASM', 'IND-DRJ',
  'SRI-BOP', 'SRI-PEK',
  'CHN-YUN',
  'MLW-BP1', 'RWA-OP',
]

const INDEX_SYMBOLS = ['KENYA', 'INDIA', 'CEYLON', 'CHINA', 'AFRICA', 'ASIA']

const SIM_EMAIL_DOMAIN = '@teatrade.sim'
const BOTS_PER_TICK = 3   // max new bots created per invocation (rate-limit safe)

// ── HELPERS ──────────────────────────────────────────────────────────────────

function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function nameToEmail(name: string): string {
  return name.toLowerCase().replace(/['']/g, '').replace(/\s+/g, '.') + SIM_EMAIL_DOMAIN
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Authenticate via ticker secret or service role key
    const tickerSecret = req.headers.get('x-ticker-secret')
    const authHeader = req.headers.get('Authorization')?.replace('Bearer ', '')
    const expectedSecret = Deno.env.get('TICKER_SECRET')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    const isAuthed =
      (tickerSecret && tickerSecret === expectedSecret) ||
      (authHeader && authHeader === serviceRoleKey)

    if (!isAuthed) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      serviceRoleKey
    )

    const body = await req.json().catch(() => ({}))
    const action = body.action || 'tick'

    // ── CLEANUP ACTION ──────────────────────────────────────────────────
    if (action === 'cleanup') {
      return await handleCleanup(supabase)
    }

    // ── TICK ACTION (default) ───────────────────────────────────────────

    // 1. Find existing bot profiles by matching known names
    const botNames = BOT_TRADERS.map(b => b.name)
    const { data: existingProfiles } = await supabase
      .from('profiles')
      .select('id, username, cash_balance')
      .in('username', botNames)

    const profileMap = new Map<string, { id: string; username: string }>()
    ;(existingProfiles || []).forEach(p => profileMap.set(p.username, p))

    // 2. Create missing bots (up to BOTS_PER_TICK per invocation)
    const missingBots = BOT_TRADERS.filter(b => !profileMap.has(b.name))
    const toCreate = missingBots.slice(0, BOTS_PER_TICK)
    let botsCreated = 0

    for (const bot of toCreate) {
      try {
        const email = nameToEmail(bot.name)
        const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
          email,
          password: `TT_${crypto.randomUUID().slice(0, 12)}!`,
          email_confirm: true,
          user_metadata: { username: bot.name, is_sim_bot: true },
        })

        if (authErr || !authData?.user) {
          console.warn(`Bot create failed (${bot.name}):`, authErr?.message)
          continue
        }

        const startBalance = Math.round(randBetween(50_000, 200_000) * 100) / 100
        await supabase.from('profiles').upsert({
          id: authData.user.id,
          username: bot.name,
          cash_balance: startBalance,
        }, { onConflict: 'id' })

        profileMap.set(bot.name, { id: authData.user.id, username: bot.name })
        botsCreated++
      } catch (e) {
        console.warn(`Bot create error (${bot.name}):`, (e as Error).message)
      }
    }

    // 3. Fetch current tea prices and index compositions
    const { data: teas } = await supabase.from('teas').select('id, symbol, current_price')
    if (!teas?.length) {
      return new Response(JSON.stringify({ success: true, message: 'No tea data yet', botsCreated }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const priceMap: Record<string, number> = {}
    const teaIdMap: Record<string, number> = {}
    teas.forEach(t => {
      priceMap[t.symbol] = Number(t.current_price)
      teaIdMap[t.symbol] = Number(t.id)
    })

    const { data: indexes } = await supabase.from('indexes').select('symbol, teas')
    const indexPriceMap: Record<string, number> = {}
    ;(indexes || []).forEach(idx => {
      const prices = (idx.teas || [])
        .map((s: string) => priceMap[s])
        .filter((p: number) => p > 0)
      if (prices.length > 0) {
        indexPriceMap[idx.symbol] = prices.reduce((a: number, b: number) => a + b, 0) / prices.length
      }
    })

    // 4. Pick random bots to trade this tick
    const activeBots = Array.from(profileMap.values())
    if (activeBots.length === 0) {
      return new Response(JSON.stringify({
        success: true, message: 'Creating bots, trading starts next tick',
        bots_created: botsCreated, bots_total: 0, bots_target: BOT_TRADERS.length,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const numTraders = Math.min(activeBots.length, Math.floor(randBetween(5, 16)))
    const tradingBots = shuffle(activeBots).slice(0, numTraders)

    let tradesPlaced = 0
    const tradeLog: string[] = []

    for (const bot of tradingBots) {
      const botDef = BOT_TRADERS.find(b => b.name === bot.username)
      const arch = ARCHETYPES[botDef?.archetype || 'passive']

      // Decide: tea (60%) or index (40%)
      let symbol: string
      let teaId: number | null = null
      let indexSymbol: string | null = null
      let price: number

      if (Math.random() < 0.60) {
        // Tea trade — bias toward preferred region if the bot has one
        if (botDef?.preferredRegion && Math.random() < 0.7) {
          const regional = TEA_SYMBOLS.filter(s => s.startsWith(botDef.preferredRegion!))
          symbol = regional.length > 0 ? pickRandom(regional) : pickRandom(TEA_SYMBOLS)
        } else {
          symbol = pickRandom(TEA_SYMBOLS)
        }
        price = priceMap[symbol]
        teaId = teaIdMap[symbol]
        if (!price || !teaId) continue
      } else {
        indexSymbol = pickRandom(INDEX_SYMBOLS)
        price = indexPriceMap[indexSymbol]
        if (!price) continue
        symbol = indexSymbol
      }

      const side = Math.random() < arch.buyBias ? 'BUY' : 'SELL'
      const qty = Math.round(randBetween(arch.qtyRange[0], arch.qtyRange[1]))
      const slippage = price * randBetween(-0.005, 0.005)
      const execPrice = Math.round((price + slippage) * 10000) / 10000
      const total = Math.round(execPrice * qty * 100) / 100

      const { error } = await supabase.from('trades').insert({
        user_id: bot.id,
        tea_id: teaId,
        index_symbol: indexSymbol,
        side,
        quantity: qty,
        price: execPrice,
        total_value: total,
        status: 'FILLED',
        notes: 'market_maker',
      })

      if (!error) {
        tradesPlaced++
        tradeLog.push(`${bot.username} ${side} ${qty}kg ${symbol} @$${execPrice.toFixed(4)}`)
      }
    }

    return new Response(JSON.stringify({
      success: true,
      bots_total: profileMap.size,
      bots_target: BOT_TRADERS.length,
      bots_created_this_tick: botsCreated,
      trades_placed: tradesPlaced,
      trades: tradeLog,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('simulate-trading error:', (err as Error).message)
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})

// ── CLEANUP ──────────────────────────────────────────────────────────────────
// Removes ALL @teatrade.sim bot accounts and their data.
// Safe to run multiple times.

async function handleCleanup(supabase: ReturnType<typeof createClient>) {
  const perPage = 1000
  let page = 1
  const simUserIds: string[] = []

  // Page through all auth users to find sim bots
  while (true) {
    const { data: { users }, error } = await supabase.auth.admin.listUsers({ page, perPage })
    if (error || !users?.length) break
    users
      .filter(u => u.email?.endsWith(SIM_EMAIL_DOMAIN))
      .forEach(u => simUserIds.push(u.id))
    if (users.length < perPage) break
    page++
  }

  if (simUserIds.length === 0) {
    return new Response(JSON.stringify({ success: true, message: 'No simulation bots found' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Delete data in chunks of 50
  for (let i = 0; i < simUserIds.length; i += 50) {
    const chunk = simUserIds.slice(i, i + 50)
    await supabase.from('trades').delete().in('user_id', chunk)
    await supabase.from('positions').delete().in('user_id', chunk)
    await supabase.from('profiles').delete().in('id', chunk)
  }

  // Delete auth users
  let deleted = 0
  for (const uid of simUserIds) {
    const { error } = await supabase.auth.admin.deleteUser(uid)
    if (!error) deleted++
  }

  return new Response(JSON.stringify({
    success: true,
    message: `Cleaned up ${deleted} simulation bot(s)`,
    deleted_users: deleted,
    found_users: simUserIds.length,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
