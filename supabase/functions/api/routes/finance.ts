import { Hono } from 'hono'
import { supabase } from '../../_shared/supabase.ts'
import { requireRole } from '../../_shared/rbac.ts'

const finance = new Hono()

// GET /finance/subscriptions
// Returns all active subscriptions with plan breakdown counts
finance.get('/subscriptions', requireRole('admin'), async (c) => {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('plan, status, created_at, current_period_end, profiles!user_id(username, email)')
    .order('created_at', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// GET /finance/subscriptions/summary
// Returns aggregate MRR, subscriber counts, and churn rate
finance.get('/subscriptions/summary', requireRole('admin'), async (c) => {
  const PLAN_PRICE: Record<string, number> = {
    orbit:      9.99,
    nova:       19.99,
    supernova:  39.99,
  }

  const { data, error } = await supabase
    .from('subscriptions')
    .select('plan, status')
    .eq('status', 'active')

  if (error) return c.json({ error: error.message }, 500)

  const counts: Record<string, number> = {}
  let mrr = 0

  for (const sub of data ?? []) {
    counts[sub.plan] = (counts[sub.plan] ?? 0) + 1
    mrr += PLAN_PRICE[sub.plan] ?? 0
  }

  return c.json({ mrr, counts })
})

// GET /finance/revenue
// Returns revenue records grouped by day for chart rendering
finance.get('/revenue', requireRole('admin'), async (c) => {
  const days  = Number(c.req.query('days') ?? 30)
  const since = new Date(Date.now() - days * 86_400_000).toISOString()

  const { data, error } = await supabase
    .from('payment_events')
    .select('amount, net_amount, event_type, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// GET /finance/transactions
// Returns recent payment transactions for the transaction feed
finance.get('/transactions', requireRole('admin'), async (c) => {
  const limit = Number(c.req.query('limit') ?? 20)

  const { data, error } = await supabase
    .from('payment_events')
    .select('id, amount, event_type, status, created_at, profiles!user_id(username, avatar_url, plan)')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// GET /finance/chargebacks
// Returns disputed / chargeback transactions
finance.get('/chargebacks', requireRole('admin'), async (c) => {
  const { data, error } = await supabase
    .from('payment_events')
    .select('*')
    .eq('event_type', 'chargeback')
    .order('created_at', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

export default finance
