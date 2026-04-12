// TeaTrade Exchange — Stripe Connect Account Creator
// ===================================================
// Creates a Stripe Connect Express account for KYC + payouts.
// Returns the Stripe-hosted onboarding URL so the user can
// complete identity verification and add bank details.

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

    // ── 2. CHECK EXISTING CONNECT ACCOUNT ──────────────────────────
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('profiles')
      .select('email, username, stripe_connect_id, kyc_status, account_status')
      .eq('id', userId)
      .single()

    if (profileErr || !profile) {
      return new Response(JSON.stringify({ error: 'Profile not found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404,
      })
    }

    // Only funded accounts can set up payouts
    if (profile.account_status !== 'FUNDED') {
      return new Response(JSON.stringify({ error: 'Only funded accounts can set up verification. Complete your evaluation first.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
      })
    }

    let connectAccountId = profile.stripe_connect_id

    // ── 3. CREATE OR REUSE CONNECT ACCOUNT ─────────────────────────
    if (!connectAccountId) {
      // Get user email from auth
      const { data: { user }, error: authErr } = await supabaseAdmin.auth.admin.getUserById(userId)
      if (authErr || !user) {
        return new Response(JSON.stringify({ error: 'User not found' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404,
        })
      }

      const account = await stripe.accounts.create({
        type: 'express',
        country: 'GB',
        email: user.email,
        capabilities: {
          transfers: { requested: true },
        },
        business_type: 'individual',
        metadata: {
          teatrade_user_id: userId,
          username: profile.username || '',
        },
        settings: {
          payouts: {
            schedule: { interval: 'manual' },
          },
        },
      })

      connectAccountId = account.id

      // Save to profile
      await supabaseAdmin
        .from('profiles')
        .update({
          stripe_connect_id: connectAccountId,
          kyc_status: 'pending',
        })
        .eq('id', userId)

      console.log(`Created Connect account ${connectAccountId} for user ${userId}`)
    }

    // ── 4. CREATE ONBOARDING LINK ──────────────────────────────────
    const accountLink = await stripe.accountLinks.create({
      account: connectAccountId,
      refresh_url: `${SITE_URL}/terminal.html?connect_refresh=1`,
      return_url: `${SITE_URL}/terminal.html?connect_return=1`,
      type: 'account_onboarding',
    })

    return new Response(JSON.stringify({
      url: accountLink.url,
      connect_account_id: connectAccountId,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (err) {
    console.error('create-connect-account error:', (err as Error).message)
    return new Response(JSON.stringify({ error: 'Failed to create verification session' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500,
    })
  }
})
