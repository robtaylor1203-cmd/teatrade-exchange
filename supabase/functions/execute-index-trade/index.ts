// TeaTrade Exchange — Atomic Index/Pair Trade Execution (Server-Side)
// ====================================================================
// Handles ALL index trades, index position closes, and pair trade closes.
// Routes to the appropriate Postgres SECURITY DEFINER function.
//
// Endpoints (determined by `action` in body):
//   - "trade"      -> execute_index_trade() for BUY/SELL index instruments
//   - "close_pair" -> close_pair_trade() for closing pair trade positions
//   - "reset"      -> reset_account() for wiping virtual account

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') || '*'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
    // 1. AUTHENTICATE
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

    // 2. PARSE REQUEST
    const body = await req.json()
    const { action } = body

    // ── ACTION: INDEX TRADE ────────────────────────────────────────
    if (action === 'trade') {
      const { symbol, side, quantity, price } = body

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
      const px = Number(price)
      if (!px || px <= 0 || !isFinite(px)) {
        return new Response(JSON.stringify({ success: false, error: 'Price must be a positive number' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        })
      }

      // Server-side price validation: fetch the latest index price from price_history
      const { data: latestPrice } = await supabaseAdmin
        .from('price_history')
        .select('price')
        .eq('symbol', symbol)
        .order('recorded_at', { ascending: false })
        .limit(1)
        .single()

      // If we have a server-side reference price, reject if client price deviates >5%
      if (latestPrice && latestPrice.price > 0) {
        const deviation = Math.abs(px - latestPrice.price) / latestPrice.price
        if (deviation > 0.05) {
          return new Response(JSON.stringify({
            success: false,
            error: `Price rejected: $${px.toFixed(2)} deviates >5% from server price $${latestPrice.price.toFixed(2)}`
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 400,
          })
        }
      }

      const { data, error } = await supabaseAdmin.rpc('execute_index_trade', {
        p_user_id: user.id,
        p_index_symbol: symbol,
        p_side: side,
        p_quantity: qty,
        p_price: px,
      })

      if (error) {
        console.error('execute_index_trade RPC error:', error.message)
        return new Response(JSON.stringify({ success: false, error: error.message }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 500,
        })
      }

      const result = data as Record<string, unknown>
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: result.success ? 200 : 400,
      })
    }

    // ── ACTION: CLOSE PAIR TRADE ───────────────────────────────────
    if (action === 'close_pair') {
      const { trade_id, exit_ratio } = body

      if (!trade_id) {
        return new Response(JSON.stringify({ success: false, error: 'Missing trade_id' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        })
      }
      const ratio = Number(exit_ratio)
      if (!ratio || ratio <= 0 || !isFinite(ratio)) {
        return new Response(JSON.stringify({ success: false, error: 'Invalid exit ratio' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        })
      }

      const { data, error } = await supabaseAdmin.rpc('close_pair_trade', {
        p_user_id: user.id,
        p_trade_id: trade_id,
        p_exit_ratio: ratio,
      })

      if (error) {
        console.error('close_pair_trade RPC error:', error.message)
        return new Response(JSON.stringify({ success: false, error: error.message }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 500,
        })
      }

      const result = data as Record<string, unknown>
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: result.success ? 200 : 400,
      })
    }

    // ── ACTION: OPEN PAIR TRADE ──────────────────────────────────
    if (action === 'open_pair') {
      const { side, amount, ratio, leverage, pair_id, tea_id, index_symbol } = body

      if (!side || !['LONG', 'SHORT'].includes(side)) {
        return new Response(JSON.stringify({ success: false, error: 'Side must be LONG or SHORT' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        })
      }
      const amt = Number(amount)
      if (!amt || amt < 10 || !isFinite(amt)) {
        return new Response(JSON.stringify({ success: false, error: 'Minimum position size is $10' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        })
      }
      const r = Number(ratio)
      if (!r || r <= 0 || !isFinite(r)) {
        return new Response(JSON.stringify({ success: false, error: 'Invalid ratio' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        })
      }
      const lev = Number(leverage) || 1
      if (lev < 1 || lev > 100) {
        return new Response(JSON.stringify({ success: false, error: 'Leverage must be between 1x and 100x' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        })
      }

      const { data, error } = await supabaseAdmin.rpc('open_pair_trade', {
        p_user_id: user.id,
        p_side: side,
        p_amount: amt,
        p_ratio: r,
        p_leverage: lev,
        p_pair_id: pair_id || null,
        p_tea_id: tea_id || null,
        p_index_symbol: index_symbol || null,
      })

      if (error) {
        console.error('open_pair_trade RPC error:', error.message)
        return new Response(JSON.stringify({ success: false, error: error.message }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 500,
        })
      }

      const result = data as Record<string, unknown>
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: result.success ? 200 : 400,
      })
    }

    // ── ACTION: RESET ACCOUNT ──────────────────────────────────────
    if (action === 'reset') {
      const { data, error } = await supabaseAdmin.rpc('reset_account', {
        p_user_id: user.id,
        p_default_balance: 10000,
      })

      if (error) {
        console.error('reset_account RPC error:', error.message)
        return new Response(JSON.stringify({ success: false, error: error.message }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 500,
        })
      }

      const result = data as Record<string, unknown>
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: result.success ? 200 : 400,
      })
    }

    // ── ACTION: PLACE LIMIT/STOP ORDER ──────────────────────────────
    if (action === 'place_order') {
      const { symbol, is_index, side, order_type, quantity, target_price, expires_hours } = body

      if (!symbol || typeof symbol !== 'string') {
        return new Response(JSON.stringify({ success: false, error: 'Missing symbol' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 })
      }
      if (!side || !['BUY', 'SELL'].includes(side)) {
        return new Response(JSON.stringify({ success: false, error: 'Side must be BUY or SELL' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 })
      }
      if (!order_type || !['LIMIT', 'STOP'].includes(order_type)) {
        return new Response(JSON.stringify({ success: false, error: 'Order type must be LIMIT or STOP' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 })
      }
      const qty = Number(quantity)
      if (!qty || qty <= 0 || !isFinite(qty)) {
        return new Response(JSON.stringify({ success: false, error: 'Quantity must be a positive number' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 })
      }
      const tp = Number(target_price)
      if (!tp || tp <= 0 || !isFinite(tp)) {
        return new Response(JSON.stringify({ success: false, error: 'Target price must be a positive number' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 })
      }

      const { data, error } = await supabaseAdmin.rpc('place_order', {
        p_user_id: user.id,
        p_symbol: symbol,
        p_is_index: !!is_index,
        p_side: side,
        p_order_type: order_type,
        p_quantity: qty,
        p_target_price: tp,
        p_expires_hours: expires_hours ? Number(expires_hours) : null,
      })

      if (error) {
        console.error('place_order RPC error:', error.message)
        return new Response(JSON.stringify({ success: false, error: error.message }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 })
      }
      const result = data as Record<string, unknown>
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: result.success ? 200 : 400,
      })
    }

    // ── ACTION: CANCEL ORDER ────────────────────────────────────────
    if (action === 'cancel_order') {
      const { order_id } = body
      if (!order_id) {
        return new Response(JSON.stringify({ success: false, error: 'Missing order_id' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 })
      }

      const { data, error } = await supabaseAdmin.rpc('cancel_order', {
        p_user_id: user.id,
        p_order_id: order_id,
      })

      if (error) {
        console.error('cancel_order RPC error:', error.message)
        return new Response(JSON.stringify({ success: false, error: error.message }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 })
      }
      const result = data as Record<string, unknown>
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: result.success ? 200 : 400,
      })
    }

    return new Response(JSON.stringify({ success: false, error: 'Unknown action: ' + action }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })

  } catch (err) {
    console.error('execute-index-trade error:', err.message)
    return new Response(JSON.stringify({ success: false, error: 'Internal server error' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
