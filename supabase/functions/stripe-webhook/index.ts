// TeaTrade Exchange — Stripe Webhook Handler
// ============================================
// Receives events from Stripe and provisions accounts:
//   - checkout.session.completed → reset account / start combine / upgrade to PRO
//   - customer.subscription.deleted → downgrade from PRO to FREE
//
// Auth: webhook signature verification (no JWT — Stripe calls this directly).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@14.14.0?target=deno"

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, stripe-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  try {
    // ── 1. VERIFY WEBHOOK SIGNATURE ────────────────────────────────
    const body = await req.text()
    const signature = req.headers.get('stripe-signature')

    if (!signature) {
      return new Response(JSON.stringify({ error: 'Missing stripe-signature header' }), {
        headers: { 'Content-Type': 'application/json' }, status: 400,
      })
    }

    let event: Stripe.Event
    try {
      event = await stripe.webhooks.constructEventAsync(body, signature, STRIPE_WEBHOOK_SECRET)
    } catch (err) {
      console.error('Webhook signature verification failed:', (err as Error).message)
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        headers: { 'Content-Type': 'application/json' }, status: 400,
      })
    }

    // ── 2. HANDLE EVENTS ───────────────────────────────────────────

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session
      const userId = session.metadata?.user_id
      const product = session.metadata?.product

      if (!userId || !product) {
        console.error('Webhook: missing metadata', { userId, product })
        return new Response(JSON.stringify({ received: true }), {
          headers: { 'Content-Type': 'application/json' }, status: 200,
        })
      }

      // Log payment
      await supabaseAdmin.from('payments').insert({
        user_id: userId,
        stripe_session_id: session.id,
        product,
        amount_pence: session.amount_total ?? 0,
        currency: session.currency ?? 'gbp',
        status: 'completed',
      })

      // Provision based on product type
      switch (product) {
        case 'ACCOUNT_RESET': {
          const { error } = await supabaseAdmin.rpc('reset_account', {
            p_user_id: userId,
            p_default_balance: 2500,
            p_mode: 'VIRTUAL',
            p_source: 'PAID_RESET',
          })
          if (error) console.error('reset_account (PAID_RESET) error:', error.message)
          break
        }

        case 'COMBINE_ENTRY': {
          // Cancel any existing active combine so we don't get duplicates
          await supabaseAdmin
            .from('combine_challenges')
            .update({ status: 'FAILED', completed_at: new Date().toISOString() })
            .eq('user_id', userId)
            .eq('status', 'ACTIVE')

          const { error: resetErr } = await supabaseAdmin.rpc('reset_account', {
            p_user_id: userId,
            p_default_balance: 50000,
            p_mode: 'VIRTUAL',
            p_source: 'COMBINE_START',
          })
          if (resetErr) {
            console.error('reset_account (COMBINE_START) error:', resetErr.message)
            break
          }

          const { error: insertErr } = await supabaseAdmin
            .from('combine_challenges')
            .insert({
              user_id: userId,
              start_balance: 50000,
              target_profit_pct: 50.0,
              daily_start_equity: 50000,
              peak_equity: 50000,
              last_equity_reset_date: new Date().toISOString().slice(0, 10),
              status: 'ACTIVE',
            })
          if (insertErr) {
            console.error('combine_challenges insert error:', insertErr.message)
            // Roll back to standard account since challenge creation failed
            await supabaseAdmin.rpc('reset_account', {
              p_user_id: userId,
              p_default_balance: 10000,
              p_mode: 'VIRTUAL',
              p_source: 'PAID_RESET',
            })
          }
          break
        }

        case 'PRO_SUBSCRIPTION': {
          const stripeCustomerId = session.customer as string
          await supabaseAdmin
            .from('profiles')
            .update({
              tier: 'PRO',
              pro_expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
              stripe_customer_id: stripeCustomerId || undefined,
            })
            .eq('id', userId)
          break
        }

        case 'EVALUATION_ENTRY':
        case 'EVAL_10K':
        case 'EVAL_25K':
        case 'EVAL_50K': {
          // Start prop trading evaluation — paid entry
          // Map product to initial balance
          const evalBalanceMap: Record<string, number> = {
            'EVAL_10K': 10000,
            'EVAL_25K': 25000,
            'EVAL_50K': 50000,
            'EVALUATION_ENTRY': 10000,
          }
          const evalBalance = evalBalanceMap[product] || Number(session.metadata?.initial_balance) || 10000
          const { data: evalResult, error: evalErr } = await supabaseAdmin.rpc('start_evaluation', {
            p_user_id: userId,
            p_initial_balance: evalBalance,
          })
          if (evalErr) {
            console.error('start_evaluation error:', evalErr.message)
          } else {
            console.log('Evaluation started:', evalResult, 'balance:', evalBalance)
          }
          break
        }

        default:
          console.warn('Unknown product in webhook:', product)
      }

      console.log(`Webhook processed: ${product} for user ${userId}`)
    }

    else if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object as Stripe.Subscription
      const userId = subscription.metadata?.user_id

      if (userId) {
        await supabaseAdmin
          .from('profiles')
          .update({ tier: 'FREE', pro_expires_at: null })
          .eq('id', userId)
        console.log(`PRO subscription cancelled for user ${userId}`)
      }
    }

    // Always return 200 to acknowledge receipt
    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' }, status: 200,
    })

  } catch (err) {
    console.error('stripe-webhook error:', (err as Error).message)
    return new Response(JSON.stringify({ error: 'Webhook handler failed' }), {
      headers: { 'Content-Type': 'application/json' }, status: 500,
    })
  }
})
