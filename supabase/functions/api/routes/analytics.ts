import { Hono } from 'hono'
import { supabase } from '../../_shared/supabase.ts'
import { requireRole } from '../../_shared/rbac.ts'

const analytics = new Hono()

// GET /analytics/engagement
// Returns aggregate like/star/match/message counts
analytics.get('/engagement', requireRole('viewer'), async (c) => {
  const [likes, stars, matches, messages, constLikes] = await Promise.all([
    supabase.from('likes').select('*', { count: 'exact', head: true }),
    supabase.from('profile_stars').select('*', { count: 'exact', head: true }),
    supabase.from('matches').select('*', { count: 'exact', head: true }),
    supabase.from('messages').select('*', { count: 'exact', head: true }).eq('is_deleted', false),
    supabase.from('constellation_group_interactions').select('*', { count: 'exact', head: true }).eq('action', 'like'),
  ])

  return c.json({
    total_likes:               likes.count       ?? 0,
    total_stars:               stars.count       ?? 0,
    total_matches:             matches.count     ?? 0,
    total_messages:            messages.count    ?? 0,
    total_constellation_likes: constLikes.count  ?? 0,
  })
})

// GET /analytics/match-funnel
// Returns staged funnel: likes → matches → conversations
analytics.get('/match-funnel', requireRole('viewer'), async (c) => {
  const [likes, matches, conversations] = await Promise.all([
    supabase.from('likes').select('*', { count: 'exact', head: true }),
    supabase.from('matches').select('*', { count: 'exact', head: true }),
    supabase
      .from('messages')
      .select('match_id', { count: 'exact', head: true })
      .not('match_id', 'is', null)
      .eq('is_deleted', false),
  ])

  return c.json({
    likes:         likes.count         ?? 0,
    matches:       matches.count       ?? 0,
    conversations: conversations.count ?? 0,
  })
})

// GET /analytics/growth
// Returns new profile registrations over the last N days
analytics.get('/growth', requireRole('viewer'), async (c) => {
  const days  = Number(c.req.query('days') ?? 30)
  const since = new Date(Date.now() - days * 86_400_000).toISOString()

  const { data, error } = await supabase
    .from('profiles')
    .select('id, created_at, gender')
    .gte('created_at', since)
    .order('created_at', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// GET /analytics/active-users
// Estimates DAU/WAU/MAU from message send activity
analytics.get('/active-users', requireRole('viewer'), async (c) => {
  const now      = new Date()
  const day1ago  = new Date(now.getTime() - 1  * 86_400_000).toISOString()
  const day7ago  = new Date(now.getTime() - 7  * 86_400_000).toISOString()
  const day30ago = new Date(now.getTime() - 30 * 86_400_000).toISOString()

  const [dau, wau, mau] = await Promise.all([
    supabase.from('messages').select('sender_id', { count: 'exact', head: true }).gte('created_at', day1ago),
    supabase.from('messages').select('sender_id', { count: 'exact', head: true }).gte('created_at', day7ago),
    supabase.from('messages').select('sender_id', { count: 'exact', head: true }).gte('created_at', day30ago),
  ])

  return c.json({
    dau: dau.count ?? 0,
    wau: wau.count ?? 0,
    mau: mau.count ?? 0,
  })
})

// GET /analytics/gender-split
// Returns patriarch vs muse profile counts
analytics.get('/gender-split', requireRole('viewer'), async (c) => {
  const [patriarchs, muses] = await Promise.all([
    supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('gender', 'patriarch'),
    supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('gender', 'muse'),
  ])

  return c.json({
    patriarch: patriarchs.count ?? 0,
    muse:      muses.count      ?? 0,
  })
})

// GET /analytics/subscription-split
// Returns active subscriber counts by tier
analytics.get('/subscription-split', requireRole('viewer'), async (c) => {
  const [nova, supernova] = await Promise.all([
    supabase.from('subscriptions').select('*', { count: 'exact', head: true }).eq('tier', 'nova').eq('status', 'active'),
    supabase.from('subscriptions').select('*', { count: 'exact', head: true }).eq('tier', 'supernova').eq('status', 'active'),
  ])

  const [totalProfiles] = await Promise.all([
    supabase.from('profiles').select('*', { count: 'exact', head: true }),
  ])

  const subscribedCount = (nova.count ?? 0) + (supernova.count ?? 0)
  const freeCount       = (totalProfiles.count ?? 0) - subscribedCount

  return c.json({
    nova:      nova.count      ?? 0,
    supernova: supernova.count ?? 0,
    free:      Math.max(0, freeCount),
  })
})

export default analytics
