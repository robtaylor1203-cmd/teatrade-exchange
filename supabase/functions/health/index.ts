// TeaTrade Exchange — Health Check Endpoint
// ==========================================
// Returns system health status including:
// - Database connectivity
// - Price freshness (is price_history being updated?)
// - Market state freshness (is market-ticker running?)
// - Tea count and pricing status
//
// Use with external monitoring (BetterUptime, Checkly, UptimeRobot)
// to get alerts when any component fails.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

interface HealthCheck {
  status: 'healthy' | 'degraded' | 'unhealthy'
  timestamp: string
  checks: {
    database: { status: string; latency_ms: number }
    price_feed: { status: string; last_price_at: string | null; age_seconds: number | null }
    market_state: { status: string; data_source: string | null; last_tick: string | null; age_seconds: number | null }
    teas: { status: string; count: number; priced_count: number }
  }
  version: string
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const startTime = Date.now()

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const now = new Date()
    const health: HealthCheck = {
      status: 'healthy',
      timestamp: now.toISOString(),
      checks: {
        database: { status: 'unknown', latency_ms: 0 },
        price_feed: { status: 'unknown', last_price_at: null, age_seconds: null },
        market_state: { status: 'unknown', data_source: null, last_tick: null, age_seconds: null },
        teas: { status: 'unknown', count: 0, priced_count: 0 },
      },
      version: '1.0.0',
    }

    // 1. DATABASE CONNECTIVITY
    const dbStart = Date.now()
    const { data: dbTest, error: dbError } = await supabase
      .from('market_state')
      .select('key')
      .limit(1)

    health.checks.database.latency_ms = Date.now() - dbStart

    if (dbError) {
      health.checks.database.status = 'error: ' + dbError.message
      health.status = 'unhealthy'
    } else {
      health.checks.database.status = 'ok'
    }

    // 2. PRICE FEED FRESHNESS
    const { data: latestPrice } = await supabase
      .from('price_history')
      .select('recorded_at')
      .order('recorded_at', { ascending: false })
      .limit(1)
      .single()

    if (latestPrice?.recorded_at) {
      const priceAge = (now.getTime() - new Date(latestPrice.recorded_at).getTime()) / 1000
      health.checks.price_feed.last_price_at = latestPrice.recorded_at
      health.checks.price_feed.age_seconds = Math.round(priceAge)

      if (priceAge > 300) {
        health.checks.price_feed.status = 'stale (>5 min)'
        health.status = health.status === 'unhealthy' ? 'unhealthy' : 'degraded'
      } else {
        health.checks.price_feed.status = 'ok'
      }
    } else {
      health.checks.price_feed.status = 'no data'
      health.status = health.status === 'unhealthy' ? 'unhealthy' : 'degraded'
    }

    // 3. MARKET STATE
    const { data: marketRows } = await supabase
      .from('market_state')
      .select('key, value')

    if (marketRows) {
      const stateMap: Record<string, string> = {}
      for (const row of marketRows) {
        stateMap[row.key] = row.value
      }

      health.checks.market_state.data_source = stateMap['data_source'] || null
      health.checks.market_state.last_tick = stateMap['last_tick'] || null

      if (stateMap['last_tick']) {
        const tickAge = (now.getTime() - new Date(stateMap['last_tick']).getTime()) / 1000
        health.checks.market_state.age_seconds = Math.round(tickAge)

        if (tickAge > 300) {
          health.checks.market_state.status = 'stale (>5 min)'
          health.status = health.status === 'unhealthy' ? 'unhealthy' : 'degraded'
        } else {
          health.checks.market_state.status = 'ok'
        }
      } else {
        health.checks.market_state.status = 'no tick data'
        health.status = health.status === 'unhealthy' ? 'unhealthy' : 'degraded'
      }
    }

    // 4. TEAS STATUS
    const { data: teas } = await supabase
      .from('teas')
      .select('symbol, current_price')

    if (teas) {
      health.checks.teas.count = teas.length
      health.checks.teas.priced_count = teas.filter(t => t.current_price && t.current_price > 0).length

      if (teas.length === 0) {
        health.checks.teas.status = 'no teas configured'
        health.status = 'unhealthy'
      } else if (health.checks.teas.priced_count < teas.length) {
        health.checks.teas.status = `${health.checks.teas.priced_count}/${teas.length} priced`
        health.status = health.status === 'unhealthy' ? 'unhealthy' : 'degraded'
      } else {
        health.checks.teas.status = 'ok'
      }
    }

    const httpStatus = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503

    return new Response(JSON.stringify(health, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: httpStatus,
    })

  } catch (err) {
    return new Response(JSON.stringify({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: err.message,
      latency_ms: Date.now() - startTime,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 503,
    })
  }
})
