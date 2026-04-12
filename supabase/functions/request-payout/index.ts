// TeaTrade Exchange — Request Payout (Performance Reward)
// =======================================================
// Called by funded traders to claim their performance reward.
// Validates eligibility, calculates the 80% trader share,
// creates a Stripe Transfer to their connected account,
// records the payout request, and resets the account balance.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@14.14.0?target=deno"

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') || '*'
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })

// Performance reward split: 80% trader / 20% platform
const TRADER_SHARE = 0.80

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
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401,
      })
    }

    const jwt = authHeader.replace('Bearer ', '')
    const payload = decodeJWTPayload(jwt)
    if (!payload?.sub) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401,
      })
    }

    const userId = payload.sub as string

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // ── 2. FETCH PROFILE & VALIDATE ────────────────────────────────
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('profiles')
      .select('stripe_connect_id, kyc_status, account_status, virtual_balance')
      .eq('id', userId)
      .single()

    if (profileErr || !profile) {
      return new Response(JSON.stringify({ error: 'Profile not found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404,
      })
    }

    // Must be funded
    if (profile.account_status !== 'FUNDED') {
      return new Response(JSON.stringify({ error: 'Only funded accounts can request payouts.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
      })
    }

    // Must have completed KYC
    if (profile.kyc_status !== 'verified') {
      return new Response(JSON.stringify({ error: 'Please complete identity verification before requesting a payout.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
      })
    }

    // Must have a Connect account
    if (!profile.stripe_connect_id) {
      return new Response(JSON.stringify({ error: 'No payment account found. Please complete verification setup.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
      })
    }

    // ── 3. CHECK FUNDED ACCOUNT STATUS ─────────────────────────────
    const { data: fundedStatus, error: fundedErr } = await supabaseAdmin.rpc('get_funded_account_status', {
      p_user_id: userId,
    })

    if (fundedErr || !fundedStatus?.has_account) {
      return new Response(JSON.stringify({ error: 'No funded account found.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
      })
    }

    if (!fundedStatus.can_request_payout) {
      return new Response(JSON.stringify({ error: 'Not eligible for payout. Ensure: profitable, 5+ trading days, no open positions, consistency rule met.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
      })
    }

    // ── 4. CHECK FOR PENDING PAYOUTS ───────────────────────────────
    const { data: pendingPayouts } = await supabaseAdmin
      .from('payout_requests')
      .select('id')
      .eq('user_id', userId)
      .in('status', ['pending', 'approved', 'processing'])
      .limit(1)

    if (pendingPayouts && pendingPayouts.length > 0) {
      return new Response(JSON.stringify({ error: 'You already have a pending payout request.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
      })
    }

    // ── 5. CALCULATE PAYOUT ────────────────────────────────────────
    const initialBalance = fundedStatus.initial_balance || 10000
    const currentBalance = Number(profile.virtual_balance)
    const grossProfit = currentBalance - initialBalance

    if (grossProfit <= 0) {
      return new Response(JSON.stringify({ error: 'No profit to withdraw.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
      })
    }

    const traderReward = Math.floor(grossProfit * TRADER_SHARE * 100) // in pence
    if (traderReward < 100) { // minimum £1.00
      return new Response(JSON.stringify({ error: 'Payout amount too small. Minimum reward is £1.00.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
      })
    }

    // ── 6. CREATE STRIPE TRANSFER ──────────────────────────────────
    // First, create the payout request record
    const { data: payoutReq, error: insertErr } = await supabaseAdmin
      .from('payout_requests')
      .insert({
        user_id: userId,
        amount_pence: traderReward,
        currency: 'gbp',
        status: 'processing',
      })
      .select('id')
      .single()

    if (insertErr || !payoutReq) {
      console.error('Failed to create payout request:', insertErr?.message)
      return new Response(JSON.stringify({ error: 'Failed to create payout request.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500,
      })
    }

    try {
      const transfer = await stripe.transfers.create({
        amount: traderReward,
        currency: 'gbp',
        destination: profile.stripe_connect_id,
        description: `TeaTrade performance reward – ${(traderReward / 100).toFixed(2)} GBP`,
        metadata: {
          teatrade_user_id: userId,
          payout_request_id: payoutReq.id,
          gross_profit: grossProfit.toFixed(2),
          trader_share: TRADER_SHARE.toString(),
        },
      })

      // Update payout request with transfer ID
      await supabaseAdmin
        .from('payout_requests')
        .update({
          stripe_transfer_id: transfer.id,
          status: 'completed',
          processed_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        })
        .eq('id', payoutReq.id)

      // ── 7. RESET BALANCE TO INITIAL ────────────────────────────────
      // Use the existing reward payout RPC to reset balance and trading days
      const { error: resetErr } = await supabaseAdmin.rpc('request_reward_payout', {
        p_user_id: userId,
      })

      if (resetErr) {
        console.error('Balance reset after payout failed:', resetErr.message)
        // Don't fail the request — the money was already sent
      }

      console.log(`Payout completed: user=${userId} amount=${traderReward}p transfer=${transfer.id}`)

      return new Response(JSON.stringify({
        success: true,
        payout_amount: (traderReward / 100).toFixed(2),
        gross_profit: grossProfit.toFixed(2),
        trader_share: (TRADER_SHARE * 100) + '%',
        transfer_id: transfer.id,
        new_balance: initialBalance.toFixed(2),
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })

    } catch (stripeErr) {
      // Stripe transfer failed — mark payout as failed
      console.error('Stripe transfer failed:', (stripeErr as Error).message)

      await supabaseAdmin
        .from('payout_requests')
        .update({
          status: 'failed',
          admin_notes: `Stripe error: ${(stripeErr as Error).message}`,
          processed_at: new Date().toISOString(),
        })
        .eq('id', payoutReq.id)

      return new Response(JSON.stringify({ error: 'Payment transfer failed. Please try again or contact support.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500,
      })
    }

  } catch (err) {
    console.error('request-payout error:', (err as Error).message)
    return new Response(JSON.stringify({ error: 'Payout request failed' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500,
    })
  }
})
