import { Hono } from 'npm:hono@4'
import { supabase } from '../../_shared/supabase.ts'
import { requireRole } from '../../_shared/rbac.ts'

const finance = new Hono()

const TIER_MONTHLY_PRICE: Record<string, number> = {
  orbit:     0,      // free tier — no MRR contribution
  nova:      18.88,
  supernova: 38.88,
}

type RevenueEventRow = {
  event_type:       string
  tier:             string | null
  from_tier:        string | null
  to_tier:          string | null
  billing_interval: string | null
}

function eventRevenue(e: RevenueEventRow): number {
  if (e.event_type === 'upgraded') {
    return Math.max(0, (TIER_MONTHLY_PRICE[e.to_tier ?? ''] ?? 0) - (TIER_MONTHLY_PRICE[e.from_tier ?? ''] ?? 0))
  }
  if (e.event_type === 'downgraded' || e.event_type === 'cancelled') return 0
  const monthly = TIER_MONTHLY_PRICE[e.tier ?? ''] ?? 0
  if (e.billing_interval === 'weekly') return monthly * (52 / 12)
  if (e.billing_interval === 'annual') return monthly * 0.8
  return monthly
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

// GET /finance/subscriptions/kpis
// KPI cards for the Subscriptions page: total subs, MRR, ARPU, churn — each with a delta
// vs the prior 30-day window (approximated from new/cancelled counts).
finance.get('/subscriptions/kpis', requireRole('viewer'), async (c) => {
  const now      = new Date()
  const day30ago = new Date(now.getTime() - 30 * 86_400_000).toISOString()
  const day60ago = new Date(now.getTime() - 60 * 86_400_000).toISOString()

  const [activeRes, newThisRes, newPriorRes, cancelThisRes, cancelPriorRes] = await Promise.all([
    supabase.from('subscriptions').select('tier, billing_interval').eq('status', 'active'),
    supabase.from('subscriptions').select('tier, billing_interval, status').gte('created_at', day30ago),
    supabase.from('subscriptions').select('tier, billing_interval, status').gte('created_at', day60ago).lt('created_at', day30ago),
    supabase.from('subscriptions').select('tier, billing_interval').eq('status', 'canceled').gte('updated_at', day30ago),
    supabase.from('subscriptions').select('tier, billing_interval').eq('status', 'canceled').gte('updated_at', day60ago).lt('updated_at', day30ago),
  ])

  const active       = (activeRes.data ?? []) as Array<{ tier: string; billing_interval: string }>
  const newThis      = ((newThisRes.data ?? []) as Array<{ tier: string; billing_interval: string; status: string }>).filter(s => s.status === 'active')
  const newPrior     = ((newPriorRes.data ?? []) as Array<{ tier: string; billing_interval: string; status: string }>).filter(s => s.status === 'active')
  const cancelThis   = (cancelThisRes.data ?? []) as Array<{ tier: string; billing_interval: string }>
  const cancelPrior  = (cancelPriorRes.data ?? []) as Array<{ tier: string; billing_interval: string }>

  function subsMRR(subs: Array<{ tier: string; billing_interval: string }>): number {
    return subs.reduce((total, s) => {
      const monthly = TIER_MONTHLY_PRICE[s.tier] ?? 0
      if (s.billing_interval === 'weekly') return total + monthly * (52 / 12)
      if (s.billing_interval === 'annual') return total + monthly * 0.8
      return total + monthly
    }, 0)
  }

  const totalSubs   = active.length
  const currentMRR  = subsMRR(active)
  const arpu        = totalSubs > 0 ? currentMRR / totalSubs : 0

  // Approximate state 30 days ago
  const subs30dAgo  = totalSubs - newThis.length + cancelThis.length
  const mrr30dAgo   = currentMRR - subsMRR(newThis) + subsMRR(cancelThis)
  const subs60dAgo  = subs30dAgo - newPrior.length + cancelPrior.length
  const mrr60dAgo   = mrr30dAgo - subsMRR(newPrior) + subsMRR(cancelPrior)
  const arpu30dAgo  = subs30dAgo > 0 ? mrr30dAgo / subs30dAgo : 0

  const churnThis   = subs30dAgo > 0 ? cancelThis.length / subs30dAgo * 100 : 0
  const churnPrior  = subs60dAgo > 0 ? cancelPrior.length / subs60dAgo * 100 : 0

  function pctDelta(cur: number, prev: number): number {
    if (prev === 0) return 0
    return +((cur - prev) / Math.abs(prev) * 100).toFixed(1)
  }

  return c.json({
    total_subscribers:       totalSubs,
    total_subscribers_delta: pctDelta(totalSubs, subs30dAgo),
    mrr:                     Math.round(currentMRR * 100) / 100,
    mrr_delta:               pctDelta(currentMRR, mrr30dAgo),
    arpu:                    Math.round(arpu * 100) / 100,
    arpu_delta:              pctDelta(arpu, arpu30dAgo),
    monthly_churn:           Math.round(churnThis * 10) / 10,
    monthly_churn_delta:     Math.round((churnThis - churnPrior) * 10) / 10,
  })
})

// GET /finance/subscriptions/plan-distribution
// Per-tier subscriber counts + MRR breakdown for the donut chart.
// free_users: profiles with no paid subscription (null or orbit tier) — sourced
// directly from profiles since they have no subscriptions row.
finance.get('/subscriptions/plan-distribution', requireRole('viewer'), async (c) => {
  const [subsRes, freeRes] = await Promise.all([
    supabase.from('subscriptions').select('tier, billing_interval').eq('status', 'active'),
    supabase.from('profiles').select('id', { count: 'exact', head: true })
      .eq('subscription_tier', 'orbit'),
  ])

  if (subsRes.error) return c.json({ error: subsRes.error.message }, 500)

  const buckets: Record<string, { subs: number; mrr: number }> = {
    orbit:     { subs: 0, mrr: 0 },
    nova:      { subs: 0, mrr: 0 },
    supernova: { subs: 0, mrr: 0 },
  }

  for (const s of (subsRes.data ?? []) as Array<{ tier: string; billing_interval: string }>) {
    if (!buckets[s.tier]) continue
    buckets[s.tier].subs++
    const monthly = TIER_MONTHLY_PRICE[s.tier] ?? 0
    if      (s.billing_interval === 'weekly') buckets[s.tier].mrr += monthly * (52 / 12)
    else if (s.billing_interval === 'annual') buckets[s.tier].mrr += monthly * 0.8
    else                                      buckets[s.tier].mrr += monthly
  }

  const totalSubs = Object.values(buckets).reduce((a, b) => a + b.subs, 0)
  const totalMRR  = Object.values(buckets).reduce((a, b) => a + b.mrr, 0)

  return c.json({
    plans: Object.entries(buckets).map(([tier, d]) => ({
      tier,
      price: TIER_MONTHLY_PRICE[tier] ?? 0,
      subs:  d.subs,
      mrr:   Math.round(d.mrr * 100) / 100,
    })),
    total_subs: totalSubs,
    total_mrr:  Math.round(totalMRR * 100) / 100,
    free_users: freeRes.count ?? 0,
  })
})

// GET /finance/subscriptions/trend?period=week|month|year
// New subscriptions and cancellations bucketed by period.
finance.get('/subscriptions/trend', requireRole('viewer'), async (c) => {
  const period = (c.req.query('period') ?? 'week') as 'week' | 'month' | 'year'
  const now    = new Date()

  type Bucket = { label: string; start: number; end: number }
  let buckets: Bucket[]

  if (period === 'week') {
    buckets = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now); d.setDate(d.getDate() - (6 - i)); d.setHours(0, 0, 0, 0)
      const next = new Date(d); next.setDate(next.getDate() + 1)
      return { label: d.toLocaleDateString('en-US', { weekday: 'short' }), start: d.getTime(), end: next.getTime() }
    })
  } else if (period === 'month') {
    buckets = Array.from({ length: 4 }, (_, i) => {
      const end   = new Date(now); end.setDate(end.getDate() - (3 - i) * 7)
      const start = new Date(end); start.setDate(start.getDate() - 7)
      return { label: start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), start: start.getTime(), end: end.getTime() }
    })
  } else {
    buckets = Array.from({ length: 12 }, (_, i) => {
      const offset = 11 - i
      const start  = new Date(now.getFullYear(), now.getMonth() - offset, 1)
      const end    = new Date(now.getFullYear(), now.getMonth() - offset + 1, 1)
      return { label: start.toLocaleDateString('en-US', { month: 'short' }), start: start.getTime(), end: end.getTime() }
    })
  }

  const since = new Date(buckets[0].start).toISOString()

  const [newRes, cancelRes] = await Promise.all([
    supabase.from('subscriptions').select('created_at').gte('created_at', since),
    supabase.from('subscriptions').select('updated_at').eq('status', 'canceled').gte('updated_at', since),
  ])

  const newSubs = (newRes.data ?? []) as Array<{ created_at: string }>
  const cancels = (cancelRes.data ?? []) as Array<{ updated_at: string }>

  return c.json({
    labels:  buckets.map(b => b.label),
    newSubs: buckets.map(b => newSubs.filter(s => { const t = new Date(s.created_at).getTime(); return t >= b.start && t < b.end }).length),
    cancels: buckets.map(b => cancels.filter(s => { const t = new Date(s.updated_at).getTime(); return t >= b.start && t < b.end }).length),
  })
})

// GET /finance/subscriptions/recent-events?limit=20
// Latest subscription lifecycle events from the subscription_events log.
finance.get('/subscriptions/recent-events', requireRole('viewer'), async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 50)

  const { data: events } = await supabase
    .from('subscription_events')
    .select('id, user_id, event_type, tier, from_tier, to_tier, billing_interval, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (!events || events.length === 0) return c.json([])

  const userIds = [...new Set((events as Array<{ user_id: string }>).map(e => e.user_id))]

  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, first_name, last_name')
    .in('id', userIds)

  const profileMap = new Map((profiles ?? []).map((p: { id: string; first_name: string; last_name: string | null }) => [p.id, p]))

  return c.json((events as Array<{
    id: string; user_id: string; event_type: string; tier: string | null
    from_tier: string | null; to_tier: string | null; billing_interval: string | null; created_at: string
  }>).map(e => {
    const p = profileMap.get(e.user_id) as { first_name: string; last_name: string | null } | undefined
    return {
      id:         e.id,
      name:       p ? (p.last_name ? `${p.first_name} ${p.last_name}` : p.first_name) : 'Unknown',
      event_type: e.event_type,
      tier:       e.tier,
      from_tier:  e.from_tier,
      to_tier:    e.to_tier,
      created_at: e.created_at,
    }
  }))
})

// GET /finance/revenue/kpis
// Gross and Net revenue month-to-date, approximated from subscription_events × tier price.
// Payment Success and Refund Rate require a payment processor — not returned here (frontend mocks them).
finance.get('/revenue/kpis', requireRole('viewer'), async (c) => {
  const now           = new Date()
  const monthStart    = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString()

  const REVENUE_TYPES = ['subscribed', 'renewed', 'reactivated', 'upgraded']

  const [thisRes, prevRes] = await Promise.all([
    supabase.from('subscription_events')
      .select('event_type, tier, from_tier, to_tier, billing_interval')
      .in('event_type', REVENUE_TYPES)
      .gte('created_at', monthStart),
    supabase.from('subscription_events')
      .select('event_type, tier, from_tier, to_tier, billing_interval')
      .in('event_type', REVENUE_TYPES)
      .gte('created_at', prevMonthStart)
      .lt('created_at', monthStart),
  ])

  const grossThis = (thisRes.data as RevenueEventRow[] ?? []).reduce((s, e) => s + eventRevenue(e), 0)
  const grossPrev = (prevRes.data as RevenueEventRow[] ?? []).reduce((s, e) => s + eventRevenue(e), 0)
  const netThis   = grossThis * 0.971
  const netPrev   = grossPrev * 0.971

  function pctDelta(cur: number, prev: number): number {
    if (prev === 0) return 0
    return +((cur - prev) / Math.abs(prev) * 100).toFixed(1)
  }

  return c.json({
    gross_mtd:   Math.round(grossThis * 100) / 100,
    gross_delta: pctDelta(grossThis, grossPrev),
    net_mtd:     Math.round(netThis * 100) / 100,
    net_delta:   pctDelta(netThis, netPrev),
  })
})

// GET /finance/revenue/trend?period=week|month|year
// Gross and net revenue bucketed by period, derived from subscription_events.
// Net = gross × 0.971 (approximate 2.9% processing fee).
finance.get('/revenue/trend', requireRole('viewer'), async (c) => {
  const period = (c.req.query('period') ?? 'week') as 'week' | 'month' | 'year'
  const now    = new Date()

  type Bucket = { label: string; start: number; end: number }
  let buckets: Bucket[]

  if (period === 'week') {
    buckets = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now); d.setDate(d.getDate() - (6 - i)); d.setHours(0, 0, 0, 0)
      const next = new Date(d); next.setDate(next.getDate() + 1)
      return { label: d.toLocaleDateString('en-US', { weekday: 'short' }), start: d.getTime(), end: next.getTime() }
    })
  } else if (period === 'month') {
    buckets = Array.from({ length: 4 }, (_, i) => {
      const end   = new Date(now); end.setDate(end.getDate() - (3 - i) * 7)
      const start = new Date(end); start.setDate(start.getDate() - 7)
      return { label: start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), start: start.getTime(), end: end.getTime() }
    })
  } else {
    buckets = Array.from({ length: 12 }, (_, i) => {
      const offset = 11 - i
      const start  = new Date(now.getFullYear(), now.getMonth() - offset, 1)
      const end    = new Date(now.getFullYear(), now.getMonth() - offset + 1, 1)
      return { label: start.toLocaleDateString('en-US', { month: 'short' }), start: start.getTime(), end: end.getTime() }
    })
  }

  const since = new Date(buckets[0].start).toISOString()

  const { data: events } = await supabase
    .from('subscription_events')
    .select('event_type, tier, from_tier, to_tier, billing_interval, created_at')
    .in('event_type', ['subscribed', 'renewed', 'reactivated', 'upgraded'])
    .gte('created_at', since)

  type EventWithDate = RevenueEventRow & { created_at: string }
  const eventsArr = (events ?? []) as EventWithDate[]

  const gross = buckets.map(b => {
    const inRange = eventsArr.filter(e => {
      const t = new Date(e.created_at).getTime()
      return t >= b.start && t < b.end
    })
    return Math.round(inRange.reduce((s, e) => s + eventRevenue(e), 0) * 100) / 100
  })

  return c.json({
    labels: buckets.map(b => b.label),
    gross,
    net: gross.map(g => Math.round(g * 0.971 * 100) / 100),
  })
})

// GET /finance/revenue/plan-mrr
// MRR breakdown by paid tier (Nova, Supernova), current vs approx 30 days ago.
// Orbit is excluded — $0 MRR.
finance.get('/revenue/plan-mrr', requireRole('viewer'), async (c) => {
  const day30ago = new Date(Date.now() - 30 * 86_400_000).toISOString()

  type SubRow = { tier: string; billing_interval: string }

  const [activeRes, newRes, cancelRes] = await Promise.all([
    supabase.from('subscriptions').select('tier, billing_interval').eq('status', 'active').in('tier', ['nova', 'supernova']),
    supabase.from('subscriptions').select('tier, billing_interval').in('tier', ['nova', 'supernova']).gte('created_at', day30ago),
    supabase.from('subscriptions').select('tier, billing_interval').in('tier', ['nova', 'supernova']).eq('status', 'canceled').gte('updated_at', day30ago),
  ])

  function mrrByTier(subs: SubRow[]): Record<string, number> {
    const result: Record<string, number> = { nova: 0, supernova: 0 }
    for (const s of subs) {
      const monthly = TIER_MONTHLY_PRICE[s.tier] ?? 0
      const contrib = s.billing_interval === 'weekly' ? monthly * (52 / 12)
                    : s.billing_interval === 'annual'  ? monthly * 0.8
                    : monthly
      if (s.tier in result) result[s.tier] += contrib
    }
    return result
  }

  const currentMRR = mrrByTier((activeRes.data  as SubRow[]) ?? [])
  const newMRR     = mrrByTier((newRes.data     as SubRow[]) ?? [])
  const cancelMRR  = mrrByTier((cancelRes.data  as SubRow[]) ?? [])

  const plans = ['nova', 'supernova'].map(tier => {
    const current = Math.round((currentMRR[tier] ?? 0) * 100) / 100
    const prev    = Math.max(0, Math.round(((currentMRR[tier] ?? 0) - (newMRR[tier] ?? 0) + (cancelMRR[tier] ?? 0)) * 100) / 100)
    return { tier, current, prev }
  })

  return c.json({
    plans,
    total_mrr: Math.round(plans.reduce((s, p) => s + p.current, 0) * 100) / 100,
  })
})

// GET /finance/revenue/recent-transactions?limit=20
// Revenue-generating subscription events repurposed as a transaction feed.
// Amounts are calculated from tier prices. Orbit (free) and cancelled events are excluded.
finance.get('/revenue/recent-transactions', requireRole('viewer'), async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 50)

  type FullEventRow = RevenueEventRow & { id: string; user_id: string; created_at: string }

  const { data: events } = await supabase
    .from('subscription_events')
    .select('id, user_id, event_type, tier, from_tier, to_tier, billing_interval, created_at')
    .not('event_type', 'eq', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(limit * 3) // fetch extra; we filter orbit-free events below

  const raw = (events ?? []) as FullEventRow[]

  const filtered = raw
    .filter(e => eventRevenue(e) > 0)
    .slice(0, limit)

  if (filtered.length === 0) return c.json([])

  const userIds = [...new Set(filtered.map(e => e.user_id))]
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, first_name, last_name')
    .in('id', userIds)

  const profileMap = new Map(
    (profiles ?? []).map((p: { id: string; first_name: string; last_name: string | null }) => [p.id, p])
  )

  return c.json(filtered.map(e => {
    const p = profileMap.get(e.user_id) as { first_name: string; last_name: string | null } | undefined
    return {
      id:         e.id,
      name:       p ? (p.last_name ? `${p.first_name} ${p.last_name}` : p.first_name) : 'Unknown',
      event_type: e.event_type,
      tier:       e.tier,
      from_tier:  e.from_tier,
      to_tier:    e.to_tier,
      amount:     Math.round(eventRevenue(e) * 100) / 100,
      created_at: e.created_at,
    }
  }))
})

export default finance
