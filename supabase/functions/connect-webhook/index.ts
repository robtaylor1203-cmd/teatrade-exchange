// TeaTrade Exchange — Stripe Connect Webhook Handler
// ===================================================
// Receives Connect-related webhook events from Stripe:
//   - account.updated  → KYC status changes
//   - transfer.created → payout completed (funds sent to connected account)
//   - transfer.reversed → payout clawed back
//   - transfer.updated → payout metadata/status change
//
// This needs its own webhook endpoint in Stripe Dashboard
// configured to receive Connect events.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@14.14.0?target=deno"

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
const CONNECT_WEBHOOK_SECRET = Deno.env.get('STRIPE_CONNECT_WEBHOOK_SECRET') ?? ''

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
      event = await stripe.webhooks.constructEventAsync(body, signature, CONNECT_WEBHOOK_SECRET)
    } catch (err) {
      console.error('Connect webhook signature verification failed:', (err as Error).message)
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        headers: { 'Content-Type': 'application/json' }, status: 400,
      })
    }

    // ── 2. HANDLE EVENTS ───────────────────────────────────────────

    if (event.type === 'account.updated') {
      const account = event.data.object as Stripe.Account
      const connectId = account.id
      const userId = account.metadata?.teatrade_user_id

      if (!userId) {
        console.warn('Connect webhook: account.updated without teatrade_user_id metadata', connectId)
        return new Response(JSON.stringify({ received: true }), {
          headers: { 'Content-Type': 'application/json' }, status: 200,
        })
      }

      // Determine KYC status from account state
      let kycStatus = 'pending'
      const chargesEnabled = account.charges_enabled
      const payoutsEnabled = account.payouts_enabled
      const requirements = account.requirements

      if (chargesEnabled && payoutsEnabled) {
        // Fully verified — can receive transfers and pay out
        kycStatus = 'verified'
      } else if (requirements?.disabled_reason === 'rejected.fraud' ||
                 requirements?.disabled_reason === 'rejected.terms_of_service' ||
                 requirements?.disabled_reason === 'rejected.listed' ||
                 requirements?.disabled_reason === 'rejected.other') {
        kycStatus = 'rejected'
      } else if (requirements?.currently_due && requirements.currently_due.length > 0) {
        kycStatus = 'requires_info'
      } else {
        kycStatus = 'pending'
      }

      const updateData: Record<string, unknown> = { kyc_status: kycStatus }
      if (kycStatus === 'verified') {
        updateData.kyc_completed_at = new Date().toISOString()
      }

      const { error: updateErr } = await supabaseAdmin
        .from('profiles')
        .update(updateData)
        .eq('id', userId)

      if (updateErr) {
        console.error('Failed to update KYC status:', updateErr.message)
      } else {
        console.log(`KYC status updated: user=${userId} connect=${connectId} status=${kycStatus}`)
      }
    }

    else if (event.type === 'transfer.created') {
      // A transfer to a connected account was created (funds sent)
      const transfer = event.data.object as Stripe.Transfer
      const payoutRequestId = transfer.metadata?.payout_request_id

      if (payoutRequestId) {
        await supabaseAdmin
          .from('payout_requests')
          .update({
            status: 'completed',
            stripe_transfer_id: transfer.id,
            completed_at: new Date().toISOString(),
          })
          .eq('id', payoutRequestId)

        console.log(`Payout completed: request=${payoutRequestId} transfer=${transfer.id}`)
      }
    }

    else if (event.type === 'transfer.reversed') {
      // A transfer was reversed (clawback)
      const transfer = event.data.object as Stripe.Transfer
      const payoutRequestId = transfer.metadata?.payout_request_id

      if (payoutRequestId) {
        await supabaseAdmin
          .from('payout_requests')
          .update({
            status: 'failed',
            rejection_reason: 'Transfer reversed by Stripe',
          })
          .eq('id', payoutRequestId)

        console.log(`Payout reversed: request=${payoutRequestId} transfer=${transfer.id}`)
      }
    }

    else if (event.type === 'transfer.updated') {
      // Transfer metadata or description updated — log only
      const transfer = event.data.object as Stripe.Transfer
      console.log(`Transfer updated: ${transfer.id}`, transfer.metadata)
    }

    // Always return 200 to acknowledge receipt
    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' }, status: 200,
    })

  } catch (err) {
    console.error('connect-webhook error:', (err as Error).message)
    return new Response(JSON.stringify({ error: 'Webhook handler failed' }), {
      headers: { 'Content-Type': 'application/json' }, status: 500,
    })
  }
})
