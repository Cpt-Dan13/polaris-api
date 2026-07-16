import { Hono } from 'hono'
import { supabase } from '../../_shared/supabase.ts'
import { requireRole } from '../../_shared/rbac.ts'

const finance = new Hono()

// Tiers: nova ($19.99/mo) | supernova ($39.99/mo)
// Orbit does not exist in this schema.
const TIER_MONTHLY_PRICE: Record<string, number> = {
  nova:      19.99,
  supernova: 39.99,
}

// GET /finance/subscriptions
// Returns paginated subscriptions with joined profile info (two-query merge,
// since subscriptions.user_id → auth.users and profiles.id → auth.users with no direct FK)
finance.get('/subscriptions', requireRole('admin'), async (c) => {
  const status = c.req.query('status')
  const tier   = c.req.query('tier')
  const limit  = Number(c.req.query('limit') ?? 50)
  const offset = Number(c.req.query('offset') ?? 0)

  let query = supabase
    .from('subscriptions')
    .select('id, user_id, tier, billing_interval, status, current_period_start, current_period_end, cancel_at_period_end, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (status) query = query.eq('status', status)
  if (tier)   query = query.eq('tier', tier)

  const { data: subs, count, error } = await query
  if (error) return c.json({ error: error.message }, 500)

  const userIds = (subs ?? []).map((s) => s.user_id)

  const { data: profiles } = userIds.length
    ? await supabase
        .from('profiles')
        .select('id, first_name, last_name, email, gender')
        .in('id', userIds)
    : { data: [] }

  const profileMap = Object.fromEntries((profiles ?? []).map((p) => [p.id, p]))
  const data       = (subs ?? []).map((s) => ({ ...s, profile: profileMap[s.user_id] ?? null }))

  return c.json({ data, count })
})

// GET /finance/subscriptions/summary
// Returns MRR and subscriber counts by tier
finance.get('/subscriptions/summary', requireRole('admin'), async (c) => {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('tier, billing_interval, status')
    .eq('status', 'active')

  if (error) return c.json({ error: error.message }, 500)

  const counts: Record<string, number> = { nova: 0, supernova: 0 }
  let mrr = 0

  for (const sub of data ?? []) {
    counts[sub.tier] = (counts[sub.tier] ?? 0) + 1

    // Normalise all billing intervals to monthly equivalent
    const monthly = TIER_MONTHLY_PRICE[sub.tier] ?? 0
    if      (sub.billing_interval === 'weekly')  mrr += monthly * (52 / 12)
    else if (sub.billing_interval === 'annual')  mrr += monthly * 0.8   // assume ~20% annual discount
    else                                          mrr += monthly
  }

  return c.json({ mrr: Math.round(mrr * 100) / 100, counts })
})

// GET /finance/subscriptions/growth
// Returns new subscriptions per day over the last N days
finance.get('/subscriptions/growth', requireRole('admin'), async (c) => {
  const days  = Number(c.req.query('days') ?? 30)
  const since = new Date(Date.now() - days * 86_400_000).toISOString()

  const { data, error } = await supabase
    .from('subscriptions')
    .select('tier, status, billing_interval, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// GET /finance/subscriptions/churn
// Returns canceled subscriptions over the last N days
finance.get('/subscriptions/churn', requireRole('admin'), async (c) => {
  const days  = Number(c.req.query('days') ?? 30)
  const since = new Date(Date.now() - days * 86_400_000).toISOString()

  const { data, count, error } = await supabase
    .from('subscriptions')
    .select('tier, billing_interval, updated_at', { count: 'exact' })
    .eq('status', 'canceled')
    .gte('updated_at', since)
    .order('updated_at', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data, count })
})

// GET /finance/subscriptions/expiring
// Returns subscriptions whose current period ends within N days
finance.get('/subscriptions/expiring', requireRole('admin'), async (c) => {
  const days  = Number(c.req.query('days') ?? 7)
  const until = new Date(Date.now() + days * 86_400_000).toISOString()

  const { data, error } = await supabase
    .from('subscriptions')
    .select('id, user_id, tier, billing_interval, current_period_end, cancel_at_period_end')
    .eq('status', 'active')
    .lte('current_period_end', until)
    .order('current_period_end', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

export default finance
