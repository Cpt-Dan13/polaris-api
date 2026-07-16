import { Hono } from 'hono'
import { supabase } from '../../_shared/supabase.ts'
import { requireRole } from '../../_shared/rbac.ts'

const analytics = new Hono()

// GET /analytics/swipe
// Returns swipe decision counts grouped by date, plus aggregate rates
analytics.get('/swipe', requireRole('viewer'), async (c) => {
  const { data, error } = await supabase
    .from('swipe_events')
    .select('decision, user_type, timestamp')
    .order('timestamp', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// GET /analytics/swipe/hourly
// Returns swipe volume bucketed by hour-of-day
analytics.get('/swipe/hourly', requireRole('viewer'), async (c) => {
  const { data, error } = await supabase.rpc('swipe_volume_by_hour')

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// GET /analytics/growth
// Returns new user registrations grouped by day
analytics.get('/growth', requireRole('viewer'), async (c) => {
  const days = Number(c.req.query('days') ?? 30)

  const { data, error } = await supabase
    .from('profiles')
    .select('created_at')
    .gte('created_at', new Date(Date.now() - days * 86_400_000).toISOString())

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// GET /analytics/active-users
// Returns DAU/WAU/MAU counts
analytics.get('/active-users', requireRole('viewer'), async (c) => {
  const now     = new Date()
  const day1ago = new Date(now.getTime() - 1 * 86_400_000).toISOString()
  const day7ago = new Date(now.getTime() - 7 * 86_400_000).toISOString()
  const day30ago = new Date(now.getTime() - 30 * 86_400_000).toISOString()

  const [dau, wau, mau] = await Promise.all([
    supabase.from('swipe_events').select('user_id', { count: 'exact', head: true }).gte('timestamp', day1ago),
    supabase.from('swipe_events').select('user_id', { count: 'exact', head: true }).gte('timestamp', day7ago),
    supabase.from('swipe_events').select('user_id', { count: 'exact', head: true }).gte('timestamp', day30ago),
  ])

  return c.json({
    dau: dau.count ?? 0,
    wau: wau.count ?? 0,
    mau: mau.count ?? 0,
  })
})

// GET /analytics/match-funnel
// Returns staged funnel counts: swipes → likes → matches → conversations → (future: dates)
analytics.get('/match-funnel', requireRole('viewer'), async (c) => {
  const [swipes, likes, matches] = await Promise.all([
    supabase.from('swipe_events').select('*', { count: 'exact', head: true }),
    supabase.from('swipe_events').select('*', { count: 'exact', head: true }).in('decision', ['like', 'super_like']),
    supabase.from('matches').select('*', { count: 'exact', head: true }),
  ])

  const conversations = await supabase
    .from('messages')
    .select('match_id', { count: 'exact', head: true })

  return c.json({
    swipes:        swipes.count        ?? 0,
    likes:         likes.count         ?? 0,
    matches:       matches.count       ?? 0,
    conversations: conversations.count ?? 0,
  })
})

export default analytics
