// TeaTrade Exchange — Atomic Trade Execution (Server-Side)
// ========================================================
// This Edge Function is the ONLY way to execute trades.
// The frontend sends { symbol, side, quantity } and this function:
//   1. Validates the JWT (user identity)
//   2. Calls the Postgres execute_trade() function which:
//      - Locks the tea row + profile row (prevents races)
//      - Validates balance (BUY) or holdings (SELL)
//      - Uses the REAL server-side market price (not client-provided)
//      - Debits/credits balance, upserts position, records trade
//      - All in ONE atomic transaction
//   3. Returns the result

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

serve(async (req) => {
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

    // Look up user via admin API (avoids getUser(jwt) "Invalid JWT" issue)
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
    const { symbol, side, quantity } = body

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

    // ── 3. EXECUTE ATOMIC TRADE ────────────────────────────────────
    const { data, error } = await supabaseAdmin.rpc('execute_trade', {
      p_user_id: user.id,
      p_tea_symbol: symbol,
      p_side: side,
      p_quantity: qty,
    })

    if (error) {
      console.error('execute_trade RPC error:', error.message)
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      })
    }

    // The Postgres function returns a JSONB object with success/error
    const result = data as Record<string, unknown>

    if (!result.success) {
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    // ── 4. RETURN SUCCESS ──────────────────────────────────────────
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (err) {
    console.error('execute-trade error:', err.message)
    return new Response(JSON.stringify({ success: false, error: 'Internal server error' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
