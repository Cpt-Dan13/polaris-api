import { Hono } from 'npm:hono@4'
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

// GET /analytics/swipes?period=week|month|year
// Returns KPIs, volume series, funnel, hourly activity, and top liked profiles
analytics.get('/swipes', requireRole('viewer'), async (c) => {
  const period = (c.req.query('period') ?? 'week') as 'week' | 'month' | 'year'
  const now = new Date()

  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const todayISO = todayStart.toISOString()

  // ── Today's raw rows (for KPIs + hourly buckets) ──────────────────────────
  const [todayLikesRes, todayPassesRes, todayStarsRes, todayMatchesRes] = await Promise.all([
    supabase.from('likes').select('created_at').gte('created_at', todayISO).is('liker_constellation_id', null),
    supabase.from('passes').select('created_at').gte('created_at', todayISO),
    supabase.from('profile_stars').select('id', { count: 'exact', head: true }).gte('created_at', todayISO),
    supabase.from('matches').select('id', { count: 'exact', head: true }).gte('created_at', todayISO).is('liker_constellation_id', null),
  ])

  const todayLikeRows  = todayLikesRes.data  ?? []
  const todayPassRows  = todayPassesRes.data  ?? []
  const likesToday     = todayLikeRows.length
  const passesToday    = todayPassRows.length
  const starsTodayCount   = todayStarsRes.count    ?? 0
  const matchesTodayCount = todayMatchesRes.count   ?? 0
  const totalSwipesToday  = likesToday + passesToday + starsTodayCount

  // Hourly swipe buckets (UTC hour 0–23)
  const hourly = new Array(24).fill(0)
  for (const r of todayLikeRows) hourly[new Date(r.created_at).getUTCHours()]++
  for (const r of todayPassRows) hourly[new Date(r.created_at).getUTCHours()]++

  // ── Volume series buckets by period ───────────────────────────────────────
  type Bucket = { start: Date; end: Date; label: string }
  const buckets: Bucket[] = []

  if (period === 'week') {
    for (let i = 6; i >= 0; i--) {
      const s = new Date(now); s.setHours(0, 0, 0, 0); s.setDate(s.getDate() - i)
      const e = new Date(s);   e.setDate(e.getDate() + 1)
      buckets.push({ start: s, end: e, label: s.toLocaleDateString('en-US', { weekday: 'short' }) })
    }
  } else if (period === 'month') {
    for (let i = 3; i >= 0; i--) {
      const s = new Date(now.getTime() - (i + 1) * 7 * 86_400_000)
      const e = new Date(now.getTime() -  i      * 7 * 86_400_000)
      buckets.push({ start: s, end: e, label: s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) })
    }
  } else {
    for (let i = 11; i >= 0; i--) {
      const s = new Date(now.getFullYear(), now.getMonth() - i,     1)
      const e = new Date(now.getFullYear(), now.getMonth() - i + 1, 1)
      buckets.push({ start: s, end: e, label: s.toLocaleDateString('en-US', { month: 'short' }) })
    }
  }

  const volumeResults = await Promise.all(
    buckets.map(b => Promise.all([
      supabase.from('likes').select('id', { count: 'exact', head: true })
        .gte('created_at', b.start.toISOString()).lt('created_at', b.end.toISOString())
        .is('liker_constellation_id', null),
      supabase.from('passes').select('id', { count: 'exact', head: true })
        .gte('created_at', b.start.toISOString()).lt('created_at', b.end.toISOString()),
    ]))
  )

  const volumeLabels = buckets.map(b => b.label)
  const volumeLikes  = volumeResults.map(([l]) => l.count ?? 0)
  const volumePasses = volumeResults.map(([, p]) => p.count ?? 0)

  // ── All-time funnel ───────────────────────────────────────────────────────
  const twoDaysAgo = new Date(now.getTime() - 48 * 3600_000).toISOString()

  const [allLikes, allPasses, allMatches, allConvos] = await Promise.all([
    supabase.from('likes').select('id', { count: 'exact', head: true }).is('liker_constellation_id', null),
    supabase.from('passes').select('id', { count: 'exact', head: true }),
    supabase.from('matches').select('id', { count: 'exact', head: true }),
    supabase.from('chats').select('id', { count: 'exact', head: true }).not('match_id', 'is', null),
  ])

  // Active chats = chats with a message in the last 48 h
  const recentMsgRes = await supabase
    .from('messages')
    .select('chat_id')
    .not('chat_id', 'is', null)
    .gte('created_at', twoDaysAgo)
    .eq('is_deleted', false)

  const activeChats = new Set((recentMsgRes.data ?? []).map((r: { chat_id: string }) => r.chat_id)).size

  // ── Top liked profiles today ──────────────────────────────────────────────
  const topRaw = await supabase
    .from('likes')
    .select('liked_id')
    .gte('created_at', todayISO)
    .is('liker_constellation_id', null)

  const likeCountMap: Record<string, number> = {}
  for (const r of topRaw.data ?? []) {
    likeCountMap[r.liked_id] = (likeCountMap[r.liked_id] ?? 0) + 1
  }
  const topIds = Object.entries(likeCountMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id]) => id)

  let topLiked: { user_id: string; first_name: string; last_name: string | null; likes: number }[] = []
  if (topIds.length > 0) {
    const { data: topProfiles } = await supabase
      .from('profiles')
      .select('id, first_name, last_name')
      .in('id', topIds)
    topLiked = (topProfiles ?? [])
      .map((p: { id: string; first_name: string; last_name: string | null }) => ({
        user_id:    p.id,
        first_name: p.first_name,
        last_name:  p.last_name,
        likes:      likeCountMap[p.id] ?? 0,
      }))
      .sort((a: { likes: number }, b: { likes: number }) => b.likes - a.likes)
  }

  return c.json({
    kpis: {
      total_swipes_today: totalSwipesToday,
      like_rate:          totalSwipesToday > 0 ? +(likesToday     / totalSwipesToday * 100).toFixed(1) : 0,
      match_rate:         likesToday       > 0 ? +(matchesTodayCount / likesToday    * 100).toFixed(1) : 0,
      super_likes_today:  starsTodayCount,
    },
    decisions: {
      like_pct:       totalSwipesToday > 0 ? +(likesToday       / totalSwipesToday * 100).toFixed(1) : 0,
      pass_pct:       totalSwipesToday > 0 ? +(passesToday      / totalSwipesToday * 100).toFixed(1) : 0,
      super_like_pct: totalSwipesToday > 0 ? +(starsTodayCount  / totalSwipesToday * 100).toFixed(1) : 0,
    },
    volume: {
      labels:  volumeLabels,
      likes:   volumeLikes,
      passes:  volumePasses,
    },
    funnel: {
      total_swipes:  (allLikes.count ?? 0) + (allPasses.count ?? 0),
      likes:         allLikes.count   ?? 0,
      matches:       allMatches.count ?? 0,
      conversations: allConvos.count  ?? 0,
      active_chats:  activeChats,
    },
    hourly,
    top_liked: topLiked,
  })
})

export default analytics
