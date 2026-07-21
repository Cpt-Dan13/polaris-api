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
    supabase.from('prompt_answers').select('user_id'),
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

  const promptUserIds    = new Set<string>((promptUsersRes.data   ?? []).map(p => p.user_id))
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
  const withPrompts    = allIds.filter(id =>  promptUserIds.has(id))
  const withoutPrompts = allIds.filter(id => !promptUserIds.has(id))

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

  const withChildren    = profiles.filter(p =>  p.has_children).map(p => p.id)
  const withoutChildren = profiles.filter(p => !p.has_children).map(p => p.id)

  const withVices    = profiles.filter(p =>  p.drinking && p.smoking && p.marijuana && p.drugs).map(p => p.id)
  const withoutVices = profiles.filter(p => !p.drinking || !p.smoking || !p.marijuana || !p.drugs).map(p => p.id)

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

export default analytics
