// TeaTrade Exchange — Stripe Checkout Session Creator
// ===================================================
// Creates Stripe Checkout Sessions for:
//   - ACCOUNT_RESET  (£4.99 one-time)
//   - COMBINE_ENTRY  (£49.00 one-time)
//   - PRO_SUBSCRIPTION (£14.99/month recurring)
//
// The frontend redirects the user to session.url.
// On payment, Stripe fires a webhook to stripe-webhook/.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@14.14.0?target=deno"

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') || '*'
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
const SITE_URL = Deno.env.get('SITE_URL') || 'https://exchange.teatrade.co.uk'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })

const PRODUCTS: Record<string, { name: string; pence: number; mode: 'payment' | 'subscription'; recurring?: boolean }> = {
  ACCOUNT_RESET:    { name: 'TeaTrade Account Reset ($10,000)',   pence: 499,  mode: 'payment' },
  COMBINE_ENTRY:    { name: 'TeaTrade Combine Challenge ($50,000)', pence: 4900, mode: 'payment' },
  EVAL_10K:         { name: 'TeaTrade Evaluation – £10,000 Simulated', pence: 4900, mode: 'payment' },
  EVAL_25K:         { name: 'TeaTrade Evaluation – £25,000 Simulated', pence: 11900, mode: 'payment' },
  EVAL_50K:         { name: 'TeaTrade Evaluation – £50,000 Simulated', pence: 19900, mode: 'payment' },
  EVALUATION_ENTRY: { name: 'TeaTrade Evaluation Challenge ($10,000 Simulated)', pence: 4900, mode: 'payment' },
  PRO_SUBSCRIPTION: { name: 'TeaTrade PRO',                        pence: 1499, mode: 'subscription', recurring: true },
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
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401,
      })
    }

    const jwt = authHeader.replace('Bearer ', '')
    const payload = decodeJWTPayload(jwt)
    if (!payload?.sub) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid token' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401,
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
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401,
      })
    }

    // ── 2. PARSE REQUEST ───────────────────────────────────────────
    const body = await req.json()
    const { product, initial_balance } = body

    const productConfig = PRODUCTS[product]
    if (!productConfig) {
      return new Response(JSON.stringify({ success: false, error: `Invalid product: ${product}` }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
      })
    }

    // ── 3. UPSERT STRIPE CUSTOMER ──────────────────────────────────
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('stripe_customer_id, username, email')
      .eq('id', userId)
      .single()

    let customerId = profile?.stripe_customer_id

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: userId, username: profile?.username || '' },
      })
      customerId = customer.id

      await supabaseAdmin
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', userId)
    }

    // ── 4. CREATE CHECKOUT SESSION ─────────────────────────────────
    const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = {
      price_data: {
        currency: 'gbp',
        product_data: { name: productConfig.name },
        unit_amount: productConfig.pence,
        ...(productConfig.recurring ? { recurring: { interval: 'month' } } : {}),
      },
      quantity: 1,
    }

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      customer: customerId,
      mode: productConfig.mode,
      line_items: [lineItem],
      metadata: { user_id: userId, product, ...(initial_balance ? { initial_balance: String(initial_balance) } : {}) },
      success_url: `${SITE_URL}/terminal.html?checkout=success&product=${product}`,
      cancel_url: `${SITE_URL}/terminal.html?checkout=cancelled`,
    }

    // For subscriptions, also store metadata on the subscription itself
    if (productConfig.mode === 'subscription') {
      sessionParams.subscription_data = {
        metadata: { user_id: userId, product },
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams)

    // ── 5. RETURN CHECKOUT URL ─────────────────────────────────────
    return new Response(JSON.stringify({ success: true, url: session.url }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    })

  } catch (err) {
    console.error('stripe-checkout error:', (err as Error).message)
    return new Response(JSON.stringify({ success: false, error: 'Internal server error' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500,
    })
  }
})
