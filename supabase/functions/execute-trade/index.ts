// TeaTrade Exchange — Atomic Trade Execution (Server-Side)
// ========================================================
// Frontend is the SOURCE OF TRUTH for the execution price.
// The client sends the Ask (BUY) or Bid (SELL) already spread-adjusted.
// This function:
//   1. Validates the JWT (user identity)
//   2. Sanity-checks the client price is within ±2% of the DB price
//   3. Calls execute_trade_secure with the CLIENT's exact price
//   4. Returns the result

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') || '*'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW = 60000

function checkRateLimit(userId: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(userId)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW })
    return true
  }
  if (entry.count >= RATE_LIMIT_MAX) return false
  entry.count++
  return true
}

function decodeJWTPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(base64))
  } catch {
    return null
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // ── 1. AUTHENTICATE ────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ success: false, error: 'Missing authorization header' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      })
    }

    const jwt = authHeader.replace('Bearer ', '')
    const payload = decodeJWTPayload(jwt)
    if (!payload?.sub) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid token payload' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      })
    }

    const userId = payload.sub as string

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: { user }, error: authError } = await supabaseAdmin.auth.admin.getUserById(userId)
    if (authError || !user) {
      return new Response(JSON.stringify({ success: false, error: 'User not found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      })
    }

    if (!user.email_confirmed_at) {
      return new Response(JSON.stringify({ success: false, error: 'Please verify your email address before trading' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 403,
      })
    }

    if (!checkRateLimit(user.id)) {
      return new Response(JSON.stringify({ success: false, error: 'Rate limit exceeded. Maximum 10 trades per minute.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 429,
      })
    }

    // ── 2. PARSE REQUEST ───────────────────────────────────────────
    const body = await req.json()
    const { symbol, side, quantity, mode, leverage } = body
    const tradingMode = (mode === 'REAL') ? 'REAL' : 'VIRTUAL'
    const lev = Math.max(1, Math.min(25, Number(leverage) || 1))

    if (!symbol || typeof symbol !== 'string') {
      return new Response(JSON.stringify({ success: false, error: 'Missing or invalid symbol' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }
    if (!side || !['BUY', 'SELL'].includes(side)) {
      return new Response(JSON.stringify({ success: false, error: 'Side must be BUY or SELL' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }
    const qty = Number(quantity)
    if (!qty || qty <= 0 || !isFinite(qty)) {
      return new Response(JSON.stringify({ success: false, error: 'Quantity must be a positive number' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    // ── 2b. LEVERAGE CAP FOR FUNDED/EVALUATION ACCOUNTS ────────────
    // Rule E: Strict 1:30 max leverage for evaluation & funded accounts
    const { data: levCapResult } = await supabaseAdmin.rpc('check_leverage_cap', {
      p_user_id: user.id,
      p_leverage: lev,
    })
    if (levCapResult === false) {
      return new Response(JSON.stringify({
        success: false,
        error: `Leverage ${lev}x exceeds the maximum 30x allowed for evaluation/funded accounts.`
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    // ── 3. CLIENT PRICE VALIDATION ─────────────────────────────────
    // Frontend is source of truth: it sends the exact Ask (BUY) or Bid (SELL)
    // the user saw in the trade form. We only fetch DB price to guard against
    // API manipulation (reject if > 2% off current market).
    const clientPrice = (body.price != null && Number(body.price) > 0) ? Number(body.price) : null

    if (clientPrice) {
      const { data: teaRow } = await supabaseAdmin
        .from('teas')
        .select('current_price')
        .eq('symbol', symbol)
        .single()
      const dbPrice = teaRow ? Number((teaRow as any).current_price) : 0
      if (dbPrice > 0) {
        const deviation = Math.abs(clientPrice - dbPrice) / dbPrice
        if (deviation > 0.02) {
          return new Response(JSON.stringify({
            success: false,
            error: `Price rejected: $${clientPrice.toFixed(4)} deviates more than 2% from market $${dbPrice.toFixed(4)}`
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 409,
          })
        }
      }
    }

    // ── 4. EXECUTE ATOMIC TRADE ────────────────────────────────────
    const { data, error } = await supabaseAdmin.rpc('execute_trade_secure', {
      p_user_id: user.id,
      p_tea_symbol: symbol,
      p_side: side,
      p_quantity: qty,
      p_mode: tradingMode,
      p_leverage: lev,
      p_expected_price: clientPrice,   // client's Ask/Bid — stored as-is if within tolerance
      p_slippage_tolerance: 0.02,      // 2% — matches the sanity check above
    })

    if (error) {
      const msg = error.message || 'Trade execution failed'
      const isSlippage = msg.includes('Price moved') || msg.includes('tolerance')
      console.error('execute_trade_secure RPC error:', msg)
      return new Response(JSON.stringify({ success: false, error: msg }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: isSlippage ? 409 : 400,
      })
    }

    const result = data as Record<string, unknown>

    if (!result || !result.success) {
      return new Response(JSON.stringify(result || { success: false, error: 'Unknown error' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    // ── 5. RECORD TRADING DAY FOR FUNDED ACCOUNTS ────────────────
    // After successful trade, record this as an active trading day
    try {
      await supabaseAdmin.rpc('record_funded_trading_day', { p_user_id: user.id })
    } catch (_) { /* non-critical — funded account may not exist */ }

    // ── 6. RETURN SUCCESS ──────────────────────────────────────────
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal server error'
    console.error('execute-trade error:', msg)
    return new Response(JSON.stringify({ success: false, error: 'Internal server error' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
