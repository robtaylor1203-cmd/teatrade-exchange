import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const ADMIN_EMAIL = 'contact@teatrade.co.uk'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401,
      })
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: authErr } = await userClient.auth.getUser()
    if (authErr || !user || user.email !== ADMIN_EMAIL) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 403,
      })
    }

    // Fetch all auth users (paginate if needed)
    const allUsers: Array<{ id: string; email: string; created_at: string }> = []
    let page = 1
    const perPage = 1000
    while (true) {
      const { data: { users }, error } = await supabaseAdmin.auth.admin.listUsers({
        page, perPage,
      })
      if (error) throw error
      if (!users || users.length === 0) break
      users.forEach(u => {
        allUsers.push({
          id: u.id,
          email: u.email ?? '',
          created_at: u.created_at ?? '',
        })
      })
      if (users.length < perPage) break
      page++
    }

    // Fetch profiles to join username, tier, status, balance
    const { data: profiles } = await supabaseAdmin
      .from('profiles')
      .select('id, username, tier, account_status, virtual_balance')

    const profileMap: Record<string, { username: string; tier: string; status: string; balance: number }> = {}
    ;(profiles || []).forEach((p: { id: string; username: string; tier: string; account_status: string; virtual_balance: number }) => {
      profileMap[p.id] = {
        username: p.username || '',
        tier: p.tier || 'FREE',
        status: p.account_status || 'ACTIVE',
        balance: p.virtual_balance || 0,
      }
    })

    const merged = allUsers.map(u => ({
      email: u.email,
      username: profileMap[u.id]?.username ?? '',
      tier: profileMap[u.id]?.tier ?? 'FREE',
      status: profileMap[u.id]?.status ?? 'ACTIVE',
      balance: profileMap[u.id]?.balance ?? 0,
      created_at: u.created_at,
    }))

    const url = new URL(req.url)
    const format = url.searchParams.get('format')

    if (format === 'csv') {
      const header = 'email,username,tier,status,balance,created_at'
      const rows = merged.map(r =>
        `${r.email},${r.username},${r.tier},${r.status},${r.balance},${r.created_at}`
      )
      const csv = [header, ...rows].join('\n')
      return new Response(csv, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="teatrade_users.csv"',
        },
      })
    }

    return new Response(JSON.stringify({ users: merged, total: merged.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('admin-emails error:', (err as Error).message)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500,
    })
  }
})
