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

// GET /analytics/active-users/kpis
// Returns live KPI values for the Active Users dashboard tab, powered by user_sessions.
analytics.get('/active-users/kpis', requireRole('viewer'), async (c) => {
  const now        = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString()

  // Online Now + Sessions Today in parallel; session detail for avg + peak
  const [onlineRes, todayCountRes, todaySessionsRes] = await Promise.all([
    supabase
      .from('user_sessions')
      .select('*', { count: 'exact', head: true })
      .is('ended_at', null)
      .gte('last_heartbeat_at', fiveMinAgo),

    supabase
      .from('user_sessions')
      .select('*', { count: 'exact', head: true })
      .gte('started_at', todayStart),

    supabase
      .from('user_sessions')
      .select('started_at, ended_at, last_heartbeat_at')
      .gte('started_at', todayStart),
  ])

  const sessions = todaySessionsRes.data ?? []

  // Avg session duration (seconds) — use last_heartbeat_at as proxy end for still-open sessions
  let avgSessionSeconds = 0
  if (sessions.length > 0) {
    const total = sessions.reduce((sum: number, s: Record<string, string | null>) => {
      const endMs = s.ended_at
        ? new Date(s.ended_at).getTime()
        : new Date(s.last_heartbeat_at!).getTime()
      return sum + Math.max(0, endMs - new Date(s.started_at!).getTime())
    }, 0)
    avgSessionSeconds = Math.round(total / sessions.length / 1000)
  }

  // Peak today — max concurrent sessions via sweep-line over open/close events
  let peakToday  = 0
  let peakTodayAt: string | null = null
  if (sessions.length > 0) {
    const events: { ts: number; delta: 1 | -1 }[] = []
    for (const s of sessions) {
      events.push({ ts: new Date(s.started_at as string).getTime(), delta: 1 })
      const endRaw = (s.ended_at ?? s.last_heartbeat_at) as string | null
      if (endRaw) events.push({ ts: new Date(endRaw).getTime(), delta: -1 })
    }
    events.sort((a, b) => a.ts - b.ts)
    let concurrent = 0
    for (const e of events) {
      concurrent += e.delta
      if (concurrent > peakToday) {
        peakToday  = concurrent
        peakTodayAt = new Date(e.ts).toISOString()
      }
    }
  }

  // Activity by hour — concurrent sessions active during each hour of today
  const todayStartMs = new Date(todayStart).getTime()
  const hourly = new Array(24).fill(0) as number[]
  for (const s of sessions) {
    const startMs = new Date(s.started_at as string).getTime()
    const endMs   = s.ended_at
      ? new Date(s.ended_at as string).getTime()
      : new Date(s.last_heartbeat_at as string).getTime()
    for (let h = 0; h < 24; h++) {
      const hStart = todayStartMs + h * 3_600_000
      const hEnd   = hStart       + 3_600_000
      if (startMs < hEnd && endMs > hStart) hourly[h]++
    }
  }

  return c.json({
    online_now:          onlineRes.count      ?? 0,
    sessions_today:      todayCountRes.count  ?? 0,
    avg_session_seconds: avgSessionSeconds,
    peak_today:          peakToday,
    peak_today_at:       peakTodayAt,
    hourly,
  })
})

// GET /analytics/active-users/top-users
// Returns top users by session count over the last 7 days with profile photo.
analytics.get('/active-users/top-users', requireRole('viewer'), async (c) => {
  const limit  = Math.min(Number(c.req.query('limit') ?? 10), 50)
  const now    = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString()

  const { data: sessionRows } = await supabase
    .from('user_sessions')
    .select('user_id, started_at, ended_at, last_heartbeat_at')
    .gte('started_at', weekAgo)

  const sessions = (sessionRows ?? []) as Array<{
    user_id: string; started_at: string; ended_at: string | null; last_heartbeat_at: string
  }>

  // Aggregate per user: session count + total duration
  const userStats = new Map<string, { sessions: number; totalMs: number }>()
  for (const s of sessions) {
    const startMs = new Date(s.started_at).getTime()
    const endMs   = s.ended_at
      ? new Date(s.ended_at).getTime()
      : new Date(s.last_heartbeat_at).getTime()
    const durMs = Math.max(0, endMs - startMs)
    const entry = userStats.get(s.user_id) ?? { sessions: 0, totalMs: 0 }
    entry.sessions++
    entry.totalMs += durMs
    userStats.set(s.user_id, entry)
  }

  const topUserIds = [...userStats.entries()]
    .sort((a, b) => b[1].sessions - a[1].sessions)
    .slice(0, limit)
    .map(([id]) => id)

  if (topUserIds.length === 0) return c.json([])

  const [profilesRes, photosRes] = await Promise.all([
    supabase.from('profiles').select('id, first_name, last_name, gender').in('id', topUserIds),
    supabase.from('photos').select('user_id, url, order_index').in('user_id', topUserIds).order('order_index'),
  ])

  const profileMap = new Map<string, { first_name: string; last_name: string | null; gender: string }>()
  for (const p of (profilesRes.data ?? []) as Array<{ id: string; first_name: string; last_name: string | null; gender: string }>) {
    profileMap.set(p.id, p)
  }

  const photoMap = new Map<string, string>()
  for (const photo of (photosRes.data ?? []) as Array<{ user_id: string; url: string; order_index: number }>) {
    if (!photoMap.has(photo.user_id)) photoMap.set(photo.user_id, photo.url)
  }

  const result = topUserIds.map(userId => {
    const stats     = userStats.get(userId)!
    const profile   = profileMap.get(userId)
    const firstName = profile?.first_name ?? 'Unknown'
    const lastName  = profile?.last_name  ?? null
    const gender    = profile?.gender     ?? ''
    const type      = gender === 'patriarch' ? 'Patriarch' : gender === 'muse' ? 'Muse' : 'Unknown'
    const avgMs     = stats.sessions > 0 ? stats.totalMs / stats.sessions : 0

    return {
      user_id:              userId,
      name:                 lastName ? `${firstName} ${lastName}` : firstName,
      initials:             ((firstName[0] ?? '') + (lastName?.[0] ?? '')).toUpperCase(),
      type,
      photo_url:            photoMap.get(userId) ?? null,
      sessions:             stats.sessions,
      avg_duration_seconds: Math.round(avgMs / 1000),
      total_seconds:        Math.round(stats.totalMs / 1000),
    }
  })

  return c.json(result)
})

// GET /analytics/active-users/trend
// Returns DAU bucketed by period (week=7 days, month=5 weeks, year=12 months)
// with gender split and constellation entity count, powered by user_sessions.
analytics.get('/active-users/trend', requireRole('viewer'), async (c) => {
  const period = (c.req.query('period') ?? 'week') as 'week' | 'month' | 'year'
  const now    = new Date()

  type Bucket = { label: string; start: number; end: number }
  const buckets: Bucket[] = []

  if (period === 'week') {
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    for (let d = 6; d >= 0; d--) {
      const start = todayStart - d * 86_400_000
      const end   = start + 86_400_000 - 1
      buckets.push({
        label: new Date(start).toLocaleDateString('en-US', { weekday: 'short' }),
        start,
        end,
      })
    }
  } else if (period === 'month') {
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime()
    for (let w = 4; w >= 0; w--) {
      const end   = todayEnd - w * 7 * 86_400_000
      const start = end      - 7 * 86_400_000 + 1
      buckets.push({
        label: new Date(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        start,
        end,
      })
    }
  } else {
    for (let m = 11; m >= 0; m--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - m,     1)
      const monthEnd   = new Date(now.getFullYear(), now.getMonth() - m + 1, 0, 23, 59, 59, 999)
      buckets.push({
        label: monthStart.toLocaleDateString('en-US', { month: 'short' }),
        start: monthStart.getTime(),
        end:   monthEnd.getTime(),
      })
    }
  }

  const rangeStart = new Date(Math.min(...buckets.map(b => b.start))).toISOString()

  const { data: sessionRows } = await supabase
    .from('user_sessions')
    .select('user_id, started_at')
    .gte('started_at', rangeStart)

  const sessions = (sessionRows ?? []) as Array<{ user_id: string; started_at: string }>
  const userIds  = [...new Set(sessions.map(s => s.user_id))]
  const zeros    = new Array(buckets.length).fill(0)

  if (userIds.length === 0) {
    return c.json({
      labels:         buckets.map(b => b.label),
      total:          zeros,
      patriarchs:     zeros,
      muses:          zeros,
      constellations: zeros,
      monthly_avg:    0,
      yearly_avg:     0,
    })
  }

  const [profilesRes, membersRes, constellationsRes] = await Promise.all([
    supabase.from('profiles').select('id, gender').in('id', userIds),
    supabase.from('constellation_members').select('profile_id, dynamic_id').in('profile_id', userIds),
    supabase.from('constellations').select('id, created_by').in('created_by', userIds),
  ])

  const genderMap = new Map<string, string>()
  for (const p of (profilesRes.data ?? []) as Array<{ id: string; gender: string }>) {
    genderMap.set(p.id, p.gender)
  }

  const userConstMap = new Map<string, Set<string>>()
  for (const m of (membersRes.data ?? []) as Array<{ profile_id: string; dynamic_id: string }>) {
    if (!userConstMap.has(m.profile_id)) userConstMap.set(m.profile_id, new Set())
    userConstMap.get(m.profile_id)!.add(m.dynamic_id)
  }
  for (const con of (constellationsRes.data ?? []) as Array<{ id: string; created_by: string }>) {
    if (!userConstMap.has(con.created_by)) userConstMap.set(con.created_by, new Set())
    userConstMap.get(con.created_by)!.add(con.id)
  }

  const total:          number[] = []
  const patriarchs:     number[] = []
  const muses:          number[] = []
  const constellations: number[] = []

  for (const bucket of buckets) {
    const uniqueUsers  = new Set<string>()
    const uniqueConsts = new Set<string>()
    for (const s of sessions) {
      const ts = new Date(s.started_at).getTime()
      if (ts >= bucket.start && ts <= bucket.end) {
        uniqueUsers.add(s.user_id)
        const cids = userConstMap.get(s.user_id)
        if (cids) cids.forEach(cid => uniqueConsts.add(cid))
      }
    }
    let pCount = 0, mCount = 0
    for (const uid of uniqueUsers) {
      const gender = genderMap.get(uid)
      if (gender === 'patriarch') pCount++
      else if (gender === 'muse') mCount++
    }
    total.push(uniqueUsers.size)
    patriarchs.push(pCount)
    muses.push(mCount)
    constellations.push(uniqueConsts.size)
  }

  function avgDau(rows: Array<{ user_id: string; started_at: string }>, days: number): number {
    const byDay = new Map<string, Set<string>>()
    for (const row of rows) {
      const day = row.started_at.substring(0, 10)
      if (!byDay.has(day)) byDay.set(day, new Set())
      byDay.get(day)!.add(row.user_id)
    }
    if (byDay.size === 0) return 0
    const sum = [...byDay.values()].reduce((acc, s) => acc + s.size, 0)
    return Math.round(sum / days)
  }

  const day30ago  = new Date(now.getTime() - 30  * 86_400_000).toISOString()
  const day365ago = new Date(now.getTime() - 365 * 86_400_000).toISOString()

  const [monthly30Res, yearly365Res] = await Promise.all([
    supabase.from('user_sessions').select('user_id, started_at').gte('started_at', day30ago),
    supabase.from('user_sessions').select('user_id, started_at').gte('started_at', day365ago),
  ])

  const monthly_avg = avgDau((monthly30Res.data ?? []) as Array<{ user_id: string; started_at: string }>, 30)
  const yearly_avg  = avgDau((yearly365Res.data ?? []) as Array<{ user_id: string; started_at: string }>, 365)

  return c.json({
    labels:         buckets.map(b => b.label),
    total,
    patriarchs,
    muses,
    constellations,
    monthly_avg,
    yearly_avg,
  })
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

  // ── By user type ─────────────────────────────────────────────────────────────
  const [patriarchRes, museRes] = await Promise.all([
    supabase.from('profiles').select('id').eq('gender', 'patriarch'),
    supabase.from('profiles').select('id').eq('gender', 'muse'),
  ])

  const pIds = (patriarchRes.data ?? []).map((p: { id: string }) => p.id)
  const mIds = (museRes.data ?? []).map((p: { id: string }) => p.id)

  const none = { count: 0 }

  const [pLikes, pPasses, mLikes, mPasses, cLikes, cPasses, cMatches, indivMatches] = await Promise.all([
    pIds.length ? supabase.from('likes').select('id', { count: 'exact', head: true }).in('liker_id', pIds).is('liker_constellation_id', null)  : none,
    pIds.length ? supabase.from('passes').select('id', { count: 'exact', head: true }).in('passer_id', pIds)                                    : none,
    mIds.length ? supabase.from('likes').select('id', { count: 'exact', head: true }).in('liker_id', mIds).is('liker_constellation_id', null)  : none,
    mIds.length ? supabase.from('passes').select('id', { count: 'exact', head: true }).in('passer_id', mIds)                                   : none,
    supabase.from('constellation_group_interactions').select('id', { count: 'exact', head: true }).eq('action', 'like'),
    supabase.from('constellation_group_interactions').select('id', { count: 'exact', head: true }).eq('action', 'pass'),
    supabase.from('matches').select('id', { count: 'exact', head: true }).not('liker_constellation_id', 'is', null),
    supabase.from('matches').select('id', { count: 'exact', head: true }).is('liker_constellation_id', null),
  ])

  const pL  = pLikes.count  ?? 0,  pP  = pPasses.count ?? 0
  const mL  = mLikes.count  ?? 0,  mP  = mPasses.count ?? 0
  const cL  = cLikes.count  ?? 0,  cP  = cPasses.count ?? 0
  const cM  = cMatches.count ?? 0, iM  = indivMatches.count ?? 0

  function rate(a: number, b: number) { return b > 0 ? +(a / b * 100).toFixed(1) : 0 }

  const byType = {
    patriarch: {
      swipes:     pL + pP,
      like_rate:  rate(pL, pL + pP),
      match_rate: rate(iM, pL),
      avg_daily:  Math.round((pL + pP) / 30),
    },
    muse: {
      swipes:     mL + mP,
      like_rate:  rate(mL, mL + mP),
      match_rate: rate(iM, mL),
      avg_daily:  Math.round((mL + mP) / 30),
    },
    constellation: {
      swipes:     cL + cP,
      like_rate:  rate(cL, cL + cP),
      match_rate: rate(cM, cL),
      avg_daily:  Math.round((cL + cP) / 30),
    },
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
    by_type:   byType,
  })
})

// GET /analytics/profiles
// Returns height/age stats, distributions, top performing, and most popular profiles
analytics.get('/profiles', requireRole('viewer'), async (c) => {
  // Round 1: fetch all frequency source data in parallel
  const [allLikesRes, allStarsRes, allViewsRes, allPassesRxRes, allReportsRes, allBlocksRes, patriarchRes, museRes] = await Promise.all([
    supabase.from('likes').select('liked_id').is('liker_constellation_id', null),
    supabase.from('profile_stars').select('starred_id'),
    supabase.from('profile_views').select('viewed_id'),
    supabase.from('passes').select('passed_id'),
    supabase.from('reports').select('reported_id'),
    supabase.from('blocks').select('blocked_id'),
    supabase.from('profiles').select('id, ethnicity').eq('gender', 'patriarch'),
    supabase.from('profiles').select('id, ethnicity').eq('gender', 'muse'),
  ])

  const likesFreq: Record<string, number> = {}
  for (const r of allLikesRes.data ?? []) {
    likesFreq[r.liked_id] = (likesFreq[r.liked_id] ?? 0) + 1
  }
  const starsFreq: Record<string, number> = {}
  for (const r of allStarsRes.data ?? []) {
    starsFreq[r.starred_id] = (starsFreq[r.starred_id] ?? 0) + 1
  }
  const viewsFreq: Record<string, number> = {}
  for (const r of allViewsRes.data ?? []) {
    viewsFreq[r.viewed_id] = (viewsFreq[r.viewed_id] ?? 0) + 1
  }
  const passesRxFreq: Record<string, number> = {}
  for (const r of allPassesRxRes.data ?? []) {
    passesRxFreq[r.passed_id] = (passesRxFreq[r.passed_id] ?? 0) + 1
  }
  const reportsFreq: Record<string, number> = {}
  for (const r of allReportsRes.data ?? []) {
    reportsFreq[r.reported_id] = (reportsFreq[r.reported_id] ?? 0) + 1
  }
  const blocksFreq: Record<string, number> = {}
  for (const r of allBlocksRes.data ?? []) {
    blocksFreq[r.blocked_id] = (blocksFreq[r.blocked_id] ?? 0) + 1
  }

  type GenderProfile = { id: string; ethnicity: string | null }
  const pProfiles = (patriarchRes.data ?? []) as GenderProfile[]
  const mProfiles = (museRes.data      ?? []) as GenderProfile[]
  const pIds   = pProfiles.map(p => p.id)
  const mIds   = mProfiles.map(p => p.id)
  const pIdSet = new Set(pIds)
  const mIdSet = new Set(mIds)

  const ETHNICITY_LABEL: Record<string, string> = {
    black_african:    'Black / African Descent',
    east_asian:       'East Asian',
    hispanic_latino:       'Hispanic / Latino',
    middle_eastern:        'Middle Eastern',
    native_american:       'Native American',
    pacific_islander:      'Pacific Islander',
    south_asian:           'South Asian',
    southeast_asian:       'Southeast Asian',
    white_caucasian:       'White / Caucasian',
    other:                 'Other',
  }

  function ethnicityDist(profiles: GenderProfile[]) {
    const counts: Record<string, number> = {}
    for (const p of profiles) {
      const label = (p.ethnicity && ETHNICITY_LABEL[p.ethnicity]) ?? 'Other'
      counts[label] = (counts[label] ?? 0) + 1
    }
    const total = profiles.length
    return Object.entries(counts)
      .map(([label, count]) => ({
        label,
        pct: total > 0 ? Math.round(count / total * 100) : 0,
      }))
      .sort((a, b) => b.pct - a.pct)
  }
  const likedIds = Object.keys(likesFreq)

  // Ranking helpers — run before round-2 fetch so we know which names to load
  function topPerformingIds(idSet: Set<string>, n = 3): string[] {
    return [...idSet]
      .filter(id => (starsFreq[id] ?? 0) > 0 || (likesFreq[id] ?? 0) > 0)
      .sort((a, b) =>
        ((starsFreq[b] ?? 0) - (starsFreq[a] ?? 0)) ||
        ((likesFreq[b] ?? 0) - (likesFreq[a] ?? 0))
      )
      .slice(0, n)
  }

  function mostPopularIds(idSet: Set<string>, n = 3): string[] {
    return [...idSet]
      .filter(id => (viewsFreq[id] ?? 0) > 0)
      .sort((a, b) => (viewsFreq[b] ?? 0) - (viewsFreq[a] ?? 0))
      .slice(0, n)
  }

  function mostDislikedIds(idSet: Set<string>, n = 3): string[] {
    return [...idSet]
      .filter(id => (passesRxFreq[id] ?? 0) > 0)
      .sort((a, b) => (passesRxFreq[b] ?? 0) - (passesRxFreq[a] ?? 0))
      .slice(0, n)
  }

  function mostReportedIds(idSet: Set<string>, n = 3): string[] {
    return [...idSet]
      .filter(id => (reportsFreq[id] ?? 0) > 0)
      .sort((a, b) => (reportsFreq[b] ?? 0) - (reportsFreq[a] ?? 0))
      .slice(0, n)
  }

  const pTopIds      = topPerformingIds(pIdSet)
  const mTopIds      = topPerformingIds(mIdSet)
  const pPopIds      = mostPopularIds(pIdSet)
  const mPopIds      = mostPopularIds(mIdSet)
  const pDislikedIds = mostDislikedIds(pIdSet)
  const mDislikedIds = mostDislikedIds(mIdSet)
  const pReportedIds = mostReportedIds(pIdSet)
  const mReportedIds = mostReportedIds(mIdSet)

  const nameIds = [...new Set([
    ...pTopIds, ...mTopIds, ...pPopIds, ...mPopIds,
    ...pDislikedIds, ...mDislikedIds, ...pReportedIds, ...mReportedIds,
  ])]

  // Round 2: liked-profile details (for stats/dist) + top-profile names — parallel
  let likedProfiles: { id: string; height_cm: number | null; gender: string; date_of_birth: string }[] = []
  const profileNamesMap: Record<string, { first_name: string; last_name: string | null }> = {}
  const photoMap: Record<string, string> = {}

  const CHUNK = 200
  const likedFetches: Promise<void>[] = []
  for (let i = 0; i < likedIds.length; i += CHUNK) {
    likedFetches.push(
      supabase.from('profiles')
        .select('id, height_cm, gender, date_of_birth')
        .in('id', likedIds.slice(i, i + CHUNK))
        .then(({ data }) => { likedProfiles = likedProfiles.concat(data ?? []) })
    )
  }

  const namesFetch = nameIds.length > 0
    ? supabase.from('profiles').select('id, first_name, last_name').in('id', nameIds)
        .then(({ data }) => {
          for (const p of data ?? []) {
            profileNamesMap[p.id] = { first_name: p.first_name, last_name: p.last_name }
          }
        })
    : Promise.resolve()

  const photosFetch = nameIds.length > 0
    ? supabase.from('photos').select('user_id, url, order_index').in('user_id', nameIds).order('order_index')
        .then(({ data }) => {
          for (const photo of data ?? []) {
            if (!photoMap[photo.user_id]) photoMap[photo.user_id] = photo.url
          }
        })
    : Promise.resolve()

  await Promise.all([...likedFetches, namesFetch, photosFetch])

  // ── Stats / distribution helpers ─────────────────────────────────────────────

  function heightStats(gender: string) {
    const freq: Record<number, number> = {}
    let totalH = 0, totalL = 0
    for (const p of likedProfiles) {
      if (p.gender !== gender || !p.height_cm) continue
      const l = likesFreq[p.id] ?? 0
      totalH += p.height_cm * l
      totalL += l
      freq[p.height_cm] = (freq[p.height_cm] ?? 0) + l
    }
    const avg_cm  = totalL > 0 ? Math.round(totalH / totalL) : null
    const modeEntry = Object.entries(freq).sort((a, b) => +b[1] - +a[1])[0]
    const mode_cm = modeEntry ? +modeEntry[0] : null
    return { avg_cm, mode_cm }
  }

  function ageStats(gender: string) {
    const now = new Date()
    const freq: Record<number, number> = {}
    let totalA = 0, totalL = 0
    for (const p of likedProfiles) {
      if (p.gender !== gender || !p.date_of_birth) continue
      const age = Math.floor((now.getTime() - new Date(p.date_of_birth).getTime()) / (365.25 * 86_400_000))
      const l = likesFreq[p.id] ?? 0
      totalA += age * l
      totalL += l
      freq[age] = (freq[age] ?? 0) + l
    }
    const avg_age  = totalL > 0 ? Math.round(totalA / totalL) : null
    const modeEntry = Object.entries(freq).sort((a, b) => +b[1] - +a[1])[0]
    const mode_age = modeEntry ? +modeEntry[0] : null
    return { avg_age, mode_age }
  }

  type HeightBucket = { label: string; maxIn: number }
  type AgeBucket    = { label: string; min: number; max: number }

  const PATRIARCH_H: HeightBucket[] = [
    { label: "5'5\"",  maxIn: 65  },
    { label: "5'6\"",  maxIn: 66  },
    { label: "5'7\"",  maxIn: 67  },
    { label: "5'8\"",  maxIn: 68  },
    { label: "5'9\"",  maxIn: 69  },
    { label: "5'10\"", maxIn: 70  },
    { label: "6'0\"+", maxIn: 999 },
  ]
  const MUSE_H: HeightBucket[] = [
    { label: "5'2\"",  maxIn: 62  },
    { label: "5'3\"",  maxIn: 63  },
    { label: "5'4\"",  maxIn: 64  },
    { label: "5'5\"",  maxIn: 65  },
    { label: "5'6\"",  maxIn: 66  },
    { label: "5'7\"",  maxIn: 67  },
    { label: "5'8\"+", maxIn: 999 },
  ]
  const PATRIARCH_A: AgeBucket[] = [
    { label: '25–30', min: 25, max: 30 },
    { label: '31–35', min: 31, max: 35 },
    { label: '36–40', min: 36, max: 40 },
    { label: '41–45', min: 41, max: 45 },
    { label: '46–50', min: 46, max: 50 },
    { label: '50+',   min: 51, max: 999 },
  ]
  const MUSE_A: AgeBucket[] = [
    { label: '21–24', min: 21, max: 24 },
    { label: '25–28', min: 25, max: 28 },
    { label: '29–32', min: 29, max: 32 },
    { label: '33–36', min: 33, max: 36 },
    { label: '37–40', min: 37, max: 40 },
    { label: '40+',   min: 41, max: 999 },
  ]

  function heightDist(gender: string) {
    const buckets = gender === 'patriarch' ? PATRIARCH_H : MUSE_H
    const counts  = new Array(buckets.length).fill(0)
    let total = 0
    for (const p of likedProfiles) {
      if (p.gender !== gender || !p.height_cm) continue
      const inches = Math.round(p.height_cm / 2.54)
      const idx    = buckets.findIndex(b => inches <= b.maxIn)
      if (idx === -1) continue
      const l = likesFreq[p.id] ?? 0
      counts[idx] += l
      total += l
    }
    const dist = buckets.map((b, i) => ({
      label: b.label,
      pct:   total > 0 ? Math.round(counts[i] / total * 100) : 0,
    }))
    const mostIdx = dist.reduce((best, d, i) => d.pct > dist[best].pct ? i : best, 0)
    return { dist, mostIdx }
  }

  function ageDist(gender: string) {
    const buckets = gender === 'patriarch' ? PATRIARCH_A : MUSE_A
    const counts  = new Array(buckets.length).fill(0)
    let total = 0
    const now = new Date()
    for (const p of likedProfiles) {
      if (p.gender !== gender || !p.date_of_birth) continue
      const age = Math.floor((now.getTime() - new Date(p.date_of_birth).getTime()) / (365.25 * 86_400_000))
      const idx = buckets.findIndex(b => age >= b.min && age <= b.max)
      if (idx === -1) continue
      const l = likesFreq[p.id] ?? 0
      counts[idx] += l
      total += l
    }
    const dist = buckets.map((b, i) => ({
      label: b.label,
      pct:   total > 0 ? Math.round(counts[i] / total * 100) : 0,
    }))
    const mostIdx = dist.reduce((best, d, i) => d.pct > dist[best].pct ? i : best, 0)
    return { dist, mostIdx }
  }

  // ── Ranking builders ─────────────────────────────────────────────────────────

  function getName(id: string): string {
    const p = profileNamesMap[id]
    if (!p) return id
    return p.last_name ? `${p.first_name} ${p.last_name}` : p.first_name
  }

  function getInitials(id: string): string {
    const p = profileNamesMap[id]
    if (!p) return '?'
    return ((p.first_name?.[0] ?? '') + (p.last_name?.[0] ?? '')).toUpperCase()
  }

  function getPhoto(id: string): string | null {
    return photoMap[id] ?? null
  }

  function buildTopPerforming(ids: string[]) {
    return ids.map(id => ({
      id,
      name:      getName(id),
      initials:  getInitials(id),
      photo_url: getPhoto(id),
      stars:     starsFreq[id] ?? 0,
      likes:     likesFreq[id] ?? 0,
    }))
  }

  function buildMostPopular(ids: string[]) {
    return ids.map(id => ({
      id,
      name:      getName(id),
      initials:  getInitials(id),
      photo_url: getPhoto(id),
      views:     viewsFreq[id] ?? 0,
    }))
  }

  function buildMostDisliked(ids: string[]) {
    return ids.map(id => ({
      id,
      name:      getName(id),
      initials:  getInitials(id),
      photo_url: getPhoto(id),
      passes:    passesRxFreq[id] ?? 0,
    }))
  }

  function buildMostReported(ids: string[]) {
    return ids.map(id => {
      const reports  = reportsFreq[id] ?? 0
      const blocks   = blocksFreq[id]  ?? 0
      const severity = reports >= 20 ? 'high' : reports >= 10 ? 'medium' : 'low'
      return {
        id,
        name:      getName(id),
        initials:  getInitials(id),
        photo_url: getPhoto(id),
        reports,
        blocks,
        severity,
      }
    })
  }

  // ── Constellation analytics ───────────────────────────────────────────────
  const [cStarsRes, cLikesRes, cViewsRes, cReportsRes, cConstBlocksRes, cPassesRes] = await Promise.all([
    supabase.from('constellation_stars').select('dynamic_id'),
    supabase.from('likes').select('liked_constellation_id').not('liked_constellation_id', 'is', null),
    supabase.from('constellation_views').select('constellation_id'),
    supabase.from('constellation_reports').select('reported_constellation_id'),
    supabase.from('individual_constellation_blocks').select('blocked_constellation_id'),
    supabase.from('constellation_group_interactions').select('target_dynamic_id').eq('action', 'pass').not('target_dynamic_id', 'is', null),
  ])

  const cStarsFreq: Record<string, number> = {}
  for (const r of cStarsRes.data ?? []) {
    cStarsFreq[r.dynamic_id] = (cStarsFreq[r.dynamic_id] ?? 0) + 1
  }
  const cLikesFreq: Record<string, number> = {}
  for (const r of cLikesRes.data ?? []) {
    cLikesFreq[r.liked_constellation_id] = (cLikesFreq[r.liked_constellation_id] ?? 0) + 1
  }
  const cViewsFreq: Record<string, number> = {}
  for (const r of cViewsRes.data ?? []) {
    cViewsFreq[r.constellation_id] = (cViewsFreq[r.constellation_id] ?? 0) + 1
  }
  const cReportsFreq: Record<string, number> = {}
  for (const r of cReportsRes.data ?? []) {
    cReportsFreq[r.reported_constellation_id] = (cReportsFreq[r.reported_constellation_id] ?? 0) + 1
  }
  const cConstBlocksFreq: Record<string, number> = {}
  for (const r of cConstBlocksRes.data ?? []) {
    cConstBlocksFreq[r.blocked_constellation_id] = (cConstBlocksFreq[r.blocked_constellation_id] ?? 0) + 1
  }
  const cPassesFreq: Record<string, number> = {}
  for (const r of cPassesRes.data ?? []) {
    cPassesFreq[r.target_dynamic_id] = (cPassesFreq[r.target_dynamic_id] ?? 0) + 1
  }

  const cTopIds = [...new Set([...Object.keys(cStarsFreq), ...Object.keys(cLikesFreq)])]
    .sort((a, b) =>
      ((cStarsFreq[b] ?? 0) - (cStarsFreq[a] ?? 0)) ||
      ((cLikesFreq[b] ?? 0) - (cLikesFreq[a] ?? 0))
    )
    .slice(0, 3)

  const cPopIds = Object.keys(cViewsFreq)
    .sort((a, b) => (cViewsFreq[b] ?? 0) - (cViewsFreq[a] ?? 0))
    .slice(0, 3)

  const cReportedIds = Object.keys(cReportsFreq)
    .sort((a, b) => (cReportsFreq[b] ?? 0) - (cReportsFreq[a] ?? 0))
    .slice(0, 3)

  const cDislikedIds = Object.keys(cPassesFreq)
    .sort((a, b) => (cPassesFreq[b] ?? 0) - (cPassesFreq[a] ?? 0))
    .slice(0, 3)

  const cAllIds = [...new Set([...cTopIds, ...cPopIds, ...cReportedIds, ...cDislikedIds])]

  const cNameMap:   Record<string, string>      = {}
  const cMemberMap: Record<string, number>      = {}
  const cPhotoMap:  Record<string, string|null> = {}

  if (cAllIds.length > 0) {
    const [cNamesRes, cMembersRes] = await Promise.all([
      supabase.from('constellations').select('id, name, profile_photo_url').in('id', cAllIds),
      supabase.from('constellation_members').select('dynamic_id').in('dynamic_id', cAllIds),
    ])
    for (const c of cNamesRes.data ?? []) {
      cNameMap[c.id]  = c.name              || 'Unnamed'
      cPhotoMap[c.id] = c.profile_photo_url ?? null
    }
    for (const m of cMembersRes.data ?? []) {
      cMemberMap[m.dynamic_id] = (cMemberMap[m.dynamic_id] ?? 0) + 1
    }
  }

  function getConstInitials(id: string): string {
    const words = (cNameMap[id] ?? '').trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) return '?'
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
    return (words[0][0] + words[words.length - 1][0]).toUpperCase()
  }

  return c.json({
    patriarch: {
      ...heightStats('patriarch'), ...ageStats('patriarch'),
      height_dist:     heightDist('patriarch'),
      age_dist:        ageDist('patriarch'),
      ethnicity_dist:  ethnicityDist(pProfiles),
      top_performing:  buildTopPerforming(pTopIds),
      most_popular:    buildMostPopular(pPopIds),
      most_disliked:   buildMostDisliked(pDislikedIds),
      most_reported:   buildMostReported(pReportedIds),
    },
    muse: {
      ...heightStats('muse'), ...ageStats('muse'),
      height_dist:     heightDist('muse'),
      age_dist:        ageDist('muse'),
      ethnicity_dist:  ethnicityDist(mProfiles),
      top_performing:  buildTopPerforming(mTopIds),
      most_popular:    buildMostPopular(mPopIds),
      most_disliked:   buildMostDisliked(mDislikedIds),
      most_reported:   buildMostReported(mReportedIds),
    },
    constellation: {
      top_performing: cTopIds.map(id => ({
        id,
        name:         cNameMap[id]   ?? 'Unnamed',
        initials:     getConstInitials(id),
        photo_url:    cPhotoMap[id]  ?? null,
        member_count: cMemberMap[id] ?? 0,
        stars:        cStarsFreq[id] ?? 0,
        likes:        cLikesFreq[id] ?? 0,
      })),
      most_popular: cPopIds.map(id => ({
        id,
        name:         cNameMap[id]   ?? 'Unnamed',
        initials:     getConstInitials(id),
        photo_url:    cPhotoMap[id]  ?? null,
        member_count: cMemberMap[id] ?? 0,
        views:        cViewsFreq[id] ?? 0,
      })),
      most_reported: cReportedIds.map(id => {
        const reports  = cReportsFreq[id]     ?? 0
        const blocks   = cConstBlocksFreq[id] ?? 0
        const severity = reports >= 20 ? 'high' : reports >= 10 ? 'medium' : 'low'
        return {
          id,
          name:         cNameMap[id]   ?? 'Unnamed',
          initials:     getConstInitials(id),
          photo_url:    cPhotoMap[id]  ?? null,
          member_count: cMemberMap[id] ?? 0,
          reports,
          blocks,
          severity,
        }
      }),
      most_disliked: cDislikedIds.map(id => ({
        id,
        name:         cNameMap[id]    ?? 'Unnamed',
        initials:     getConstInitials(id),
        photo_url:    cPhotoMap[id]   ?? null,
        member_count: cMemberMap[id]  ?? 0,
        passes:       cPassesFreq[id] ?? 0,
      })),
    },
  })
})

// GET /analytics/insights
// Returns conversion funnel counts per profile type (patriarch / muse / constellation)
analytics.get('/insights', requireRole('viewer'), async (c) => {
  const [
    profilesRes,
    viewsRes,
    likesRes,
    matchesRes,
    chatsRes,
    hiddenChatsRes,
    constViewsRes,
  ] = await Promise.all([
    supabase.from('profiles').select('id, gender'),
    supabase.from('profile_views').select('viewed_id'),
    supabase.from('likes').select('liked_id, liked_constellation_id'),
    supabase.from('matches').select('id, user1_id, user2_id, liker_constellation_id, liked_constellation_id, status'),
    supabase.from('chats').select('id, match_id, sender_constellation_id, receiver_constellation_id'),
    supabase.from('hidden_chats').select('chat_id').eq('is_hidden', true),
    supabase.from('constellation_views').select('constellation_id'),
  ])

  const patriarchIds = new Set<string>()
  const museIds      = new Set<string>()
  for (const p of profilesRes.data ?? []) {
    if      (p.gender === 'patriarch') patriarchIds.add(p.id)
    else if (p.gender === 'muse')      museIds.add(p.id)
  }

  const hiddenChatIds = new Set<string>((hiddenChatsRes.data ?? []).map(h => h.chat_id))

  // ── Patriarch ─────────────────────────────────────────────────────────────
  const pViews = (viewsRes.data ?? []).filter(v => patriarchIds.has(v.viewed_id)).length

  const pLikes = (likesRes.data ?? []).filter(
    l => patriarchIds.has(l.liked_id) && !l.liked_constellation_id
  ).length

  const pMatchIds = new Set<string>()
  for (const m of matchesRes.data ?? []) {
    if (
      m.status === 'active' &&
      !m.liker_constellation_id &&
      !m.liked_constellation_id &&
      (patriarchIds.has(m.user1_id) || patriarchIds.has(m.user2_id))
    ) pMatchIds.add(m.id)
  }

  const pActiveConvos = (chatsRes.data ?? []).filter(
    c => c.match_id && pMatchIds.has(c.match_id) &&
         !c.sender_constellation_id && !c.receiver_constellation_id &&
         !hiddenChatIds.has(c.id)
  ).length

  // ── Muse ──────────────────────────────────────────────────────────────────
  const mViews = (viewsRes.data ?? []).filter(v => museIds.has(v.viewed_id)).length

  const mLikes = (likesRes.data ?? []).filter(
    l => museIds.has(l.liked_id) && !l.liked_constellation_id
  ).length

  const mMatchIds = new Set<string>()
  for (const m of matchesRes.data ?? []) {
    if (
      m.status === 'active' &&
      !m.liker_constellation_id &&
      !m.liked_constellation_id &&
      (museIds.has(m.user1_id) || museIds.has(m.user2_id))
    ) mMatchIds.add(m.id)
  }

  const mActiveConvos = (chatsRes.data ?? []).filter(
    c => c.match_id && mMatchIds.has(c.match_id) &&
         !c.sender_constellation_id && !c.receiver_constellation_id &&
         !hiddenChatIds.has(c.id)
  ).length

  // ── Constellation ─────────────────────────────────────────────────────────
  const cViews = (constViewsRes.data ?? []).length

  const cLikes = (likesRes.data ?? []).filter(l => !!l.liked_constellation_id).length

  const cMatches = (matchesRes.data ?? []).filter(
    m => m.status === 'active' &&
         (!!m.liker_constellation_id || !!m.liked_constellation_id)
  ).length

  const cActiveConvos = (chatsRes.data ?? []).filter(
    c => (!!c.sender_constellation_id || !!c.receiver_constellation_id) &&
         !hiddenChatIds.has(c.id)
  ).length

  return c.json({
    patriarch: {
      funnel: [
        { label: 'Profile Views',  count: pViews        },
        { label: 'Likes Received', count: pLikes        },
        { label: 'Mutual Matches', count: pMatchIds.size },
        { label: 'Active Conv.',   count: pActiveConvos  },
      ],
    },
    muse: {
      funnel: [
        { label: 'Profile Views',  count: mViews        },
        { label: 'Likes Received', count: mLikes        },
        { label: 'Mutual Matches', count: mMatchIds.size },
        { label: 'Active Conv.',   count: mActiveConvos  },
      ],
    },
    constellation: {
      funnel: [
        { label: 'Const. Views',   count: cViews        },
        { label: 'Likes Received', count: cLikes        },
        { label: 'Mutual Matches', count: cMatches      },
        { label: 'Active Conv.',   count: cActiveConvos  },
      ],
    },
  })
})

// GET /analytics/insights/health
// Returns profile health score and signals per profile type
analytics.get('/insights/health', requireRole('viewer'), async (c) => {
  const [
    profilesRes,
    promptAnswersRes,
    viewsRes,
    likesRes,
    matchesRes,
    chatsRes,
    hiddenChatsRes,
    constViewsRes,
    constellationsRes,
  ] = await Promise.all([
    supabase.from('profiles').select('id, gender, bio'),
    supabase.from('prompt_answers').select('user_id, answer'),
    supabase.from('profile_views').select('viewed_id'),
    supabase.from('likes').select('liked_id, liked_constellation_id'),
    supabase.from('matches').select('id, user1_id, user2_id, liker_constellation_id, liked_constellation_id, status'),
    supabase.from('chats').select('id, match_id, sender_constellation_id, receiver_constellation_id'),
    supabase.from('hidden_chats').select('chat_id').eq('is_hidden', true),
    supabase.from('constellation_views').select('constellation_id'),
    supabase.from('constellations').select('id, description, profile_photo_url'),
  ])

  const profiles = profilesRes.data ?? []
  const patriarchIds = new Set<string>()
  const museIds      = new Set<string>()
  for (const p of profiles) {
    if      (p.gender === 'patriarch') patriarchIds.add(p.id)
    else if (p.gender === 'muse')      museIds.add(p.id)
  }

  const hiddenChatIds = new Set<string>((hiddenChatsRes.data ?? []).map(h => h.chat_id))

  // Prompt quality: per-user avg answer length >= 150 chars
  const promptLengths: Record<string, number[]> = {}
  for (const row of promptAnswersRes.data ?? []) {
    if (!promptLengths[row.user_id]) promptLengths[row.user_id] = []
    promptLengths[row.user_id].push((row.answer as string).length)
  }
  const qualityUserIds = new Set(
    Object.entries(promptLengths)
      .filter(([, lens]) => lens.reduce((a, b) => a + b, 0) / lens.length >= 150)
      .map(([id]) => id)
  )

  function pct(num: number, den: number): number {
    return den === 0 ? 0 : Math.min(100, Math.round((num / den) * 100))
  }
  // Like rate: scale so 20% view-to-like = 100 score
  function likeScore(likes: number, views: number): number {
    return Math.min(100, Math.round(pct(likes, views) * 5))
  }
  function avg(...scores: number[]): number {
    return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
  }

  // ── Patriarch ─────────────────────────────────────────────────────────────
  const pProfiles    = profiles.filter(p => patriarchIds.has(p.id))
  const pBioCount    = pProfiles.filter(p => p.bio && p.bio.length > 0).length
  const pBioScore    = pct(pBioCount, pProfiles.length)
  const pPromptCount = pProfiles.filter(p => qualityUserIds.has(p.id)).length
  const pPromptScore = pct(pPromptCount, pProfiles.length)
  const pViews       = (viewsRes.data ?? []).filter(v => patriarchIds.has(v.viewed_id)).length
  const pLikes       = (likesRes.data ?? []).filter(l => patriarchIds.has(l.liked_id) && !l.liked_constellation_id).length
  const pLikeScore   = likeScore(pLikes, pViews)
  const pMatchIds    = new Set<string>()
  for (const m of matchesRes.data ?? []) {
    if (m.status === 'active' && !m.liker_constellation_id && !m.liked_constellation_id &&
        (patriarchIds.has(m.user1_id) || patriarchIds.has(m.user2_id))) pMatchIds.add(m.id)
  }
  const pChats     = (chatsRes.data ?? []).filter(
    ch => ch.match_id && pMatchIds.has(ch.match_id) &&
          !ch.sender_constellation_id && !ch.receiver_constellation_id && !hiddenChatIds.has(ch.id)
  ).length
  const pChatScore = pct(pChats, pMatchIds.size)

  // ── Muse ──────────────────────────────────────────────────────────────────
  const mProfiles    = profiles.filter(p => museIds.has(p.id))
  const mBioCount    = mProfiles.filter(p => p.bio && p.bio.length > 0).length
  const mBioScore    = pct(mBioCount, mProfiles.length)
  const mPromptCount = mProfiles.filter(p => qualityUserIds.has(p.id)).length
  const mPromptScore = pct(mPromptCount, mProfiles.length)
  const mViews       = (viewsRes.data ?? []).filter(v => museIds.has(v.viewed_id)).length
  const mLikes       = (likesRes.data ?? []).filter(l => museIds.has(l.liked_id) && !l.liked_constellation_id).length
  const mLikeScore   = likeScore(mLikes, mViews)
  const mMatchIds    = new Set<string>()
  for (const m of matchesRes.data ?? []) {
    if (m.status === 'active' && !m.liker_constellation_id && !m.liked_constellation_id &&
        (museIds.has(m.user1_id) || museIds.has(m.user2_id))) mMatchIds.add(m.id)
  }
  const mChats     = (chatsRes.data ?? []).filter(
    ch => ch.match_id && mMatchIds.has(ch.match_id) &&
          !ch.sender_constellation_id && !ch.receiver_constellation_id && !hiddenChatIds.has(ch.id)
  ).length
  const mChatScore = pct(mChats, mMatchIds.size)

  // ── Constellation ─────────────────────────────────────────────────────────
  const constellations  = constellationsRes.data ?? []
  const cBioCount       = constellations.filter(c => c.description && c.description.length > 0).length
  const cBioScore       = pct(cBioCount, constellations.length)
  const cPhotoCount     = constellations.filter(c => !!c.profile_photo_url).length
  const cPhotoScore     = pct(cPhotoCount, constellations.length)
  const cViews          = (constViewsRes.data ?? []).length
  const cLikes          = (likesRes.data ?? []).filter(l => !!l.liked_constellation_id).length
  const cLikeScore      = likeScore(cLikes, cViews)
  const cMatchIds       = new Set<string>()
  for (const m of matchesRes.data ?? []) {
    if (m.status === 'active' && (!!m.liker_constellation_id || !!m.liked_constellation_id)) cMatchIds.add(m.id)
  }
  const cChats     = (chatsRes.data ?? []).filter(
    ch => (!!ch.sender_constellation_id || !!ch.receiver_constellation_id) && !hiddenChatIds.has(ch.id)
  ).length
  const cChatScore = pct(cChats, cMatchIds.size)

  return c.json({
    patriarch: {
      overall: avg(pBioScore, pPromptScore, pLikeScore, pChatScore),
      signals: [
        { label: 'Bio Completeness', score: pBioScore,    detail: `${pBioCount} of ${pProfiles.length} patriarchs have a filled bio` },
        { label: 'Prompt Quality',   score: pPromptScore, detail: `${pPromptCount} of ${pProfiles.length} write detailed prompt answers` },
        { label: 'Like Rate',        score: pLikeScore,   detail: `${pLikes} likes across ${pViews} profile views` },
        { label: 'Match-to-Chat',    score: pChatScore,   detail: `${pChats} of ${pMatchIds.size} matches started a conversation` },
      ],
    },
    muse: {
      overall: avg(mBioScore, mPromptScore, mLikeScore, mChatScore),
      signals: [
        { label: 'Bio Completeness', score: mBioScore,    detail: `${mBioCount} of ${mProfiles.length} muses have a filled bio` },
        { label: 'Prompt Quality',   score: mPromptScore, detail: `${mPromptCount} of ${mProfiles.length} write detailed prompt answers` },
        { label: 'Like Rate',        score: mLikeScore,   detail: `${mLikes} likes across ${mViews} profile views` },
        { label: 'Match-to-Chat',    score: mChatScore,   detail: `${mChats} of ${mMatchIds.size} matches started a conversation` },
      ],
    },
    constellation: {
      overall: avg(cBioScore, cPhotoScore, cLikeScore, cChatScore),
      signals: [
        { label: 'Group Bio',         score: cBioScore,   detail: `${cBioCount} of ${constellations.length} constellations have a group bio` },
        { label: 'Profile Photo Set', score: cPhotoScore, detail: `${cPhotoCount} of ${constellations.length} have a profile photo` },
        { label: 'Like Rate',         score: cLikeScore,  detail: `${cLikes} likes across ${cViews} constellation views` },
        { label: 'Match-to-Chat',     score: cChatScore,  detail: `${cChats} of ${cMatchIds.size} matches started a conversation` },
      ],
    },
  })
})

// GET /analytics/insights/correlations
// Computes lift ratios for each attribute (has attribute vs. doesn't)
analytics.get('/insights/correlations', requireRole('viewer'), async (c) => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const [
    profilesRes,
    promptUsersRes,
    subscriptionsRes,
    likesRes,
    matchesRes,
    recentViewersRes,
  ] = await Promise.all([
    supabase.from('profiles').select('id, bio, religion, politics, ethnicity, has_children, drinking, smoking, marijuana, drugs, height_cm'),
    supabase.from('prompt_answers').select('user_id, answer'),
    supabase.from('subscriptions').select('user_id').eq('status', 'active'),
    supabase.from('likes').select('liked_id').is('liked_constellation_id', null),
    supabase.from('matches').select('user1_id, user2_id').eq('status', 'active'),
    supabase.from('profile_views').select('viewer_id').gte('created_at', thirtyDaysAgo),
  ])

  // ── Frequency maps ────────────────────────────────────────────────────────
  const likesFreq: Record<string, number> = {}
  for (const l of likesRes.data ?? []) {
    likesFreq[l.liked_id] = (likesFreq[l.liked_id] ?? 0) + 1
  }

  const matchesFreq: Record<string, number> = {}
  for (const m of matchesRes.data ?? []) {
    matchesFreq[m.user1_id] = (matchesFreq[m.user1_id] ?? 0) + 1
    matchesFreq[m.user2_id] = (matchesFreq[m.user2_id] ?? 0) + 1
  }

  const promptAnswerLengths: Record<string, number[]> = {}
  for (const row of promptUsersRes.data ?? []) {
    if (!promptAnswerLengths[row.user_id]) promptAnswerLengths[row.user_id] = []
    promptAnswerLengths[row.user_id].push((row.answer as string).length)
  }
  const PROMPT_LIMIT     = 250
  const EFFORT_THRESHOLD = PROMPT_LIMIT * 0.60
  const promptUserIds = {
    detailed: new Set(
      Object.entries(promptAnswerLengths)
        .filter(([, lens]) => lens.reduce((a, b) => a + b, 0) / lens.length >= EFFORT_THRESHOLD)
        .map(([id]) => id)
    ),
    brief: new Set(
      Object.entries(promptAnswerLengths)
        .filter(([, lens]) => lens.reduce((a, b) => a + b, 0) / lens.length < EFFORT_THRESHOLD)
        .map(([id]) => id)
    ),
  }
  const premiumUserIds   = new Set<string>((subscriptionsRes.data ?? []).map(s => s.user_id))
  const recentViewerIds  = new Set<string>((recentViewersRes.data ?? []).map(v => v.viewer_id))

  const profiles = profilesRes.data ?? []
  const allIds   = profiles.map(p => p.id)

  // ── Helpers ───────────────────────────────────────────────────────────────
  function avgMetric(ids: string[], freq: Record<string, number>): number {
    if (ids.length === 0) return 0
    return ids.reduce((sum, id) => sum + (freq[id] ?? 0), 0) / ids.length
  }

  function lift(groupA: string[], groupB: string[], freq: Record<string, number>): number | null {
    const avgB = avgMetric(groupB, freq)
    if (avgB === 0 || groupA.length === 0 || groupB.length === 0) return null
    return +(avgMetric(groupA, freq) / avgB).toFixed(2)
  }

  // ── Per-attribute splits ──────────────────────────────────────────────────
  const withPrompts    = allIds.filter(id => promptUserIds.detailed.has(id))
  const withoutPrompts = allIds.filter(id => promptUserIds.brief.has(id))

  const withBio    = profiles.filter(p => (p.bio?.length ?? 0) > 80).map(p => p.id)
  const withoutBio = profiles.filter(p => (p.bio?.length ?? 0) <= 80).map(p => p.id)

  const withPremium    = allIds.filter(id =>  premiumUserIds.has(id))
  const withoutPremium = allIds.filter(id => !premiumUserIds.has(id))

  const withValues    = profiles.filter(p =>  p.religion && p.politics).map(p => p.id)
  const withoutValues = profiles.filter(p => !p.religion || !p.politics).map(p => p.id)

  const activeRecently   = allIds.filter(id =>  recentViewerIds.has(id))
  const inactiveRecently = allIds.filter(id => !recentViewerIds.has(id))

  const withEthnicity    = profiles.filter(p =>  p.ethnicity).map(p => p.id)
  const withoutEthnicity = profiles.filter(p => !p.ethnicity).map(p => p.id)

  const withChildren    = profiles.filter(p => p.has_children === 'has_child').map(p => p.id)
  const withoutChildren = profiles.filter(p => p.has_children === 'no_child').map(p => p.id)

  const VICE_USE = ['yes', 'sometimes']
  const withVices    = profiles.filter(p =>
    VICE_USE.includes(p.drinking) || VICE_USE.includes(p.smoking) ||
    VICE_USE.includes(p.marijuana) || VICE_USE.includes(p.drugs)
  ).map(p => p.id)
  const withoutVices = profiles.filter(p =>
    p.drinking === 'no' && p.smoking === 'no' && p.marijuana === 'no' && p.drugs === 'no'
  ).map(p => p.id)

  const withHeight    = profiles.filter(p =>  p.height_cm).map(p => p.id)
  const withoutHeight = profiles.filter(p => !p.height_cm).map(p => p.id)

  return c.json({
    prompt_answers:    lift(withPrompts,        withoutPrompts,    likesFreq),
    bio_length:        lift(withBio,            withoutBio,        likesFreq),
    premium:           lift(withPremium,        withoutPremium,    matchesFreq),
    religion_politics: lift(withValues,         withoutValues,     matchesFreq),
    active_30d:        lift(activeRecently,     inactiveRecently,  likesFreq),
    ethnicity:         lift(withEthnicity,      withoutEthnicity,  likesFreq),
    has_children:      lift(withChildren,       withoutChildren,   matchesFreq),
    vices:             lift(withVices,          withoutVices,      matchesFreq),
    height:            lift(withHeight,         withoutHeight,     likesFreq),
  })
})

// GET /analytics/acquisition/signups
// Monthly new-user signups for the last 12 months, split by type.
analytics.get('/acquisition/signups', requireRole('viewer'), async (c) => {
  const now = new Date()

  const buckets: { label: string; start: number; end: number }[] = []
  for (let m = 11; m >= 0; m--) {
    const start = new Date(now.getFullYear(), now.getMonth() - m,     1)
    const end   = new Date(now.getFullYear(), now.getMonth() - m + 1, 1)
    buckets.push({ label: start.toLocaleDateString('en-US', { month: 'short' }), start: start.getTime(), end: end.getTime() })
  }

  const rangeStart = new Date(buckets[0].start).toISOString()

  const [profilesRes, constellationsRes] = await Promise.all([
    supabase.from('profiles').select('gender, created_at').gte('created_at', rangeStart),
    supabase.from('constellations').select('created_at').gte('created_at', rangeStart),
  ])

  const profiles      = (profilesRes.data      ?? []) as Array<{ gender: string; created_at: string }>
  const constellations = (constellationsRes.data ?? []) as Array<{ created_at: string }>

  const patriarchs:        number[] = []
  const muses:             number[] = []
  const constellationCounts: number[] = []

  for (const bucket of buckets) {
    let pCount = 0, mCount = 0, cCount = 0
    for (const p of profiles) {
      const ts = new Date(p.created_at).getTime()
      if (ts >= bucket.start && ts < bucket.end) {
        if (p.gender === 'patriarch') pCount++
        else if (p.gender === 'muse') mCount++
      }
    }
    for (const con of constellations) {
      const ts = new Date(con.created_at).getTime()
      if (ts >= bucket.start && ts < bucket.end) cCount++
    }
    patriarchs.push(pCount)
    muses.push(mCount)
    constellationCounts.push(cCount)
  }

  const thisMonthStart = buckets[buckets.length - 1].start
  const thisMonthTotal = profiles.filter(p => new Date(p.created_at).getTime() >= thisMonthStart).length

  return c.json({
    labels:           buckets.map(b => b.label),
    patriarchs,
    muses,
    constellations:   constellationCounts,
    this_month_total: thisMonthTotal,
  })
})

// GET /analytics/acquisition/retention
// D1 / D7 / D30 cumulative retention for users who signed up 30–90 days ago.
// Activity signal: first message sent after signup (most reliable historical data).
// Constellation retention uses the creator's first post-creation message as the signal.
analytics.get('/acquisition/retention', requireRole('viewer'), async (c) => {
  const now      = new Date()
  const day30ago = new Date(now.getTime() - 30 * 86_400_000).toISOString()
  const day90ago = new Date(now.getTime() - 90 * 86_400_000).toISOString()

  const [pCohortRes, mCohortRes, cCohortRes] = await Promise.all([
    supabase.from('profiles').select('id, created_at').eq('gender', 'patriarch')
      .gte('created_at', day90ago).lt('created_at', day30ago),
    supabase.from('profiles').select('id, created_at').eq('gender', 'muse')
      .gte('created_at', day90ago).lt('created_at', day30ago),
    supabase.from('constellations').select('id, created_at, created_by')
      .gte('created_at', day90ago).lt('created_at', day30ago),
  ])

  const pCohort = (pCohortRes.data ?? []) as Array<{ id: string; created_at: string }>
  const mCohort = (mCohortRes.data ?? []) as Array<{ id: string; created_at: string }>
  const cCohort = (cCohortRes.data ?? []) as Array<{ id: string; created_at: string; created_by: string }>

  const uniqueUserIds = [...new Set([
    ...pCohort.map(u => u.id),
    ...mCohort.map(u => u.id),
    ...cCohort.map(c => c.created_by),
  ])]

  const firstActivity = new Map<string, number>()
  if (uniqueUserIds.length > 0) {
    const { data: msgRows } = await supabase
      .from('messages')
      .select('sender_id, created_at')
      .in('sender_id', uniqueUserIds)
      .gte('created_at', day90ago)

    for (const msg of (msgRows ?? []) as Array<{ sender_id: string; created_at: string }>) {
      const ts  = new Date(msg.created_at).getTime()
      const cur = firstActivity.get(msg.sender_id)
      if (!cur || ts < cur) firstActivity.set(msg.sender_id, ts)
    }
  }

  type RetentionResult = { d1: number; d7: number; d30: number; cohort_size: number }

  function computeRetention(entries: Array<{ createdAt: number; actorId: string }>): RetentionResult {
    if (entries.length === 0) return { d1: 0, d7: 0, d30: 0, cohort_size: 0 }
    let d1 = 0, d7 = 0, d30 = 0
    for (const e of entries) {
      const actMs = firstActivity.get(e.actorId)
      if (!actMs) continue
      const days = (actMs - e.createdAt) / 86_400_000
      if (days <= 2)  d1++
      if (days <= 7)  d7++
      if (days <= 30) d30++
    }
    return {
      d1:          Math.round((d1  / entries.length) * 100),
      d7:          Math.round((d7  / entries.length) * 100),
      d30:         Math.round((d30 / entries.length) * 100),
      cohort_size: entries.length,
    }
  }

  return c.json({
    patriarchs:     computeRetention(pCohort.map(u => ({ createdAt: new Date(u.created_at).getTime(), actorId: u.id }))),
    muses:          computeRetention(mCohort.map(u => ({ createdAt: new Date(u.created_at).getTime(), actorId: u.id }))),
    constellations: computeRetention(cCohort.map(c => ({ createdAt: new Date(c.created_at).getTime(), actorId: c.created_by }))),
  })
})

// GET /analytics/acquisition/markets?limit=8
// Top cities by new-user count this month, ranked by MoM growth.
// Uses profiles.location (free-text string set by users on signup).
analytics.get('/acquisition/markets', requireRole('viewer'), async (c) => {
  const url   = new URL(c.req.url)
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '8', 10), 20)

  const now             = new Date()
  const recentStart     = new Date(now.getFullYear(), now.getMonth() - 3, 1).toISOString()
  const priorStart      = new Date(now.getFullYear(), now.getMonth() - 6, 1).toISOString()
  const recentStartMs   = new Date(recentStart).getTime()

  // Fetch profiles with a location for the past 6 months
  const { data: rows } = await supabase
    .from('profiles')
    .select('location, created_at')
    .not('location', 'is', null)
    .gte('created_at', priorStart)

  const profiles = (rows ?? []) as Array<{ location: string; created_at: string }>

  const recent = new Map<string, number>()  // last 3 months
  const prior  = new Map<string, number>()  // 3 months before that

  for (const p of profiles) {
    const loc = (p.location as string).trim()
    if (!loc) continue
    const map = new Date(p.created_at).getTime() >= recentStartMs ? recent : prior
    map.set(loc, (map.get(loc) ?? 0) + 1)
  }

  // Only rank cities that had signups in the recent window
  const ranked = [...recent.keys()]
    .map(city => {
      const curr  = recent.get(city) ?? 0
      const prev  = prior.get(city)  ?? 0
      const delta = prev === 0 ? null : +((curr - prev) / prev * 100).toFixed(1)
      return { city, users: curr, delta }
    })
    .sort((a, b) => (b.delta ?? Infinity) - (a.delta ?? Infinity))
    .slice(0, limit)

  return c.json(ranked)
})

// GET /analytics/acquisition/kpis
// Returns the four KPI cards for the Acquisition & Retention tab.
analytics.get('/acquisition/kpis', requireRole('viewer'), async (c) => {
  const now = new Date()

  const thisMonthStart     = new Date(now.getFullYear(), now.getMonth(),     1)
  const prevMonthStart     = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const prevPrevMonthStart = new Date(now.getFullYear(), now.getMonth() - 2, 1)
  const todayStart         = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterdayStart     = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const day30ago           = new Date(now.getTime() - 30 * 86_400_000)
  const day60ago           = new Date(now.getTime() - 60 * 86_400_000)

  const [
    newThisMonthRes,
    newPrevMonthRes,
    newPrevPrevMonthRes,
    dauTodayRes,
    dauYesterdayRes,
    mau30dRes,
    activeSubsRes,
    churnedLast30Res,
    churnedPrev30Res,
  ] = await Promise.all([
    supabase.from('profiles').select('*', { count: 'exact', head: true })
      .gte('created_at', thisMonthStart.toISOString()),
    supabase.from('profiles').select('*', { count: 'exact', head: true })
      .gte('created_at', prevMonthStart.toISOString())
      .lt('created_at', thisMonthStart.toISOString()),
    supabase.from('profiles').select('*', { count: 'exact', head: true })
      .gte('created_at', prevPrevMonthStart.toISOString())
      .lt('created_at', prevMonthStart.toISOString()),

    supabase.from('user_sessions').select('user_id')
      .gte('started_at', todayStart.toISOString()),
    supabase.from('user_sessions').select('user_id')
      .gte('started_at', yesterdayStart.toISOString())
      .lt('started_at', todayStart.toISOString()),
    supabase.from('user_sessions').select('user_id')
      .gte('started_at', day30ago.toISOString()),

    supabase.from('subscriptions').select('*', { count: 'exact', head: true })
      .eq('status', 'active'),
    supabase.from('subscriptions').select('*', { count: 'exact', head: true })
      .eq('status', 'canceled')
      .gte('updated_at', day30ago.toISOString()),
    supabase.from('subscriptions').select('*', { count: 'exact', head: true })
      .eq('status', 'canceled')
      .gte('updated_at', day60ago.toISOString())
      .lt('updated_at', day30ago.toISOString()),
  ])

  // ── New users ──────────────────────────────────────────────────────────────
  const newThisMonth      = newThisMonthRes.count     ?? 0
  const newPrevMonth      = newPrevMonthRes.count     ?? 0
  const newPrevPrevMonth  = newPrevPrevMonthRes.count ?? 0

  const newUsersDelta = newPrevMonth > 0
    ? ((newThisMonth - newPrevMonth) / newPrevMonth) * 100
    : 0

  // ── MoM growth rate ────────────────────────────────────────────────────────
  const momRate     = newPrevMonth     > 0 ? ((newThisMonth    - newPrevMonth)     / newPrevMonth)     * 100 : 0
  const prevMomRate = newPrevPrevMonth > 0 ? ((newPrevMonth    - newPrevPrevMonth) / newPrevPrevMonth) * 100 : 0
  const momDelta    = momRate - prevMomRate

  // ── DAU / MAU ──────────────────────────────────────────────────────────────
  const dauToday     = new Set((dauTodayRes.data     ?? []).map((s: { user_id: string }) => s.user_id)).size
  const dauYesterday = new Set((dauYesterdayRes.data ?? []).map((s: { user_id: string }) => s.user_id)).size
  const mau30d       = new Set((mau30dRes.data       ?? []).map((s: { user_id: string }) => s.user_id)).size

  const dauMauRatio = mau30d > 0 ? (dauToday     / mau30d) * 100 : 0
  const dauMauPrev  = mau30d > 0 ? (dauYesterday / mau30d) * 100 : 0
  const dauMauDelta = dauMauRatio - dauMauPrev

  // ── Monthly churn ──────────────────────────────────────────────────────────
  const activeSubs    = activeSubsRes.count    ?? 0
  const churnedLast30 = churnedLast30Res.count ?? 0
  const churnedPrev30 = churnedPrev30Res.count ?? 0

  const churnRate  = (activeSubs + churnedLast30) > 0 ? (churnedLast30 / (activeSubs + churnedLast30)) * 100 : 0
  const prevChurn  = (activeSubs + churnedPrev30) > 0 ? (churnedPrev30 / (activeSubs + churnedPrev30)) * 100 : 0
  const churnDelta = churnRate - prevChurn

  function round1(n: number) { return Math.round(n * 10) / 10 }

  return c.json({
    new_users_month:     newThisMonth,
    new_users_delta:     round1(newUsersDelta),
    mom_growth_rate:     round1(momRate),
    mom_growth_delta:    round1(momDelta),
    dau_mau_ratio:       round1(dauMauRatio),
    dau_mau_delta:       round1(dauMauDelta),
    monthly_churn:       round1(churnRate),
    monthly_churn_delta: round1(churnDelta),
  })
})

export default analytics
