import { Hono } from 'npm:hono@4'
import { supabase } from '../../_shared/supabase.ts'
import { requireRole } from '../../_shared/rbac.ts'

const users = new Hono()

// NOTE: profiles.id = the user's UUID (FK to auth.users), NOT a separate user_id column.

// GET /users
// Returns paginated profiles with optional search and filters
users.get('/', requireRole('viewer'), async (c) => {
  const search = c.req.query('search')
  const gender = c.req.query('gender')  // 'patriarch' | 'muse'
  const tier   = c.req.query('tier')    // 'nova' | 'supernova'
  const paused = c.req.query('paused')  // 'true' | 'false'
  const limit  = Number(c.req.query('limit')  ?? 50)
  const offset = Number(c.req.query('offset') ?? 0)

  let query = supabase
    .from('profiles')
    .select(
      'id, email, first_name, last_name, gender, subscription_tier, created_at, is_paused, onboarding_completed, location',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (search) query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`)
  if (gender) query = query.eq('gender', gender)
  if (tier)   query = query.eq('subscription_tier', tier)
  if (paused) query = query.eq('is_paused', paused === 'true')

  const { data, count, error } = await query
  if (error) return c.json({ error: error.message }, 500)

  // Batch-fetch first profile photo for each user
  const userIds = (data ?? []).map((p: any) => p.id)
  let photoMap: Record<string, string | null> = {}
  if (userIds.length > 0) {
    const { data: photos } = await supabase
      .from('photos')
      .select('user_id, url, order_index')
      .in('user_id', userIds)
      .order('order_index')
    if (photos) {
      for (const p of photos as { user_id: string; url: string }[]) {
        if (!photoMap[p.user_id]) photoMap[p.user_id] = p.url
      }
    }
  }

  // Batch count chats each user has participated in
  let convCountMap: Record<string, number> = {}
  if (userIds.length > 0) {
    const { data: participants } = await supabase
      .from('chat_participants')
      .select('user_id')
      .in('user_id', userIds)
    if (participants) {
      for (const p of participants as { user_id: string }[]) {
        convCountMap[p.user_id] = (convCountMap[p.user_id] ?? 0) + 1
      }
    }
  }

  const enriched = (data ?? []).map((p: any) => ({
    ...p,
    photo_url:          photoMap[p.id]   ?? null,
    conversation_count: convCountMap[p.id] ?? 0,
  }))
  return c.json({ data: enriched, count })
})

// GET /users/summary/counts
// Returns aggregate counts for the dashboard KPI row
users.get('/summary/counts', requireRole('viewer'), async (c) => {
  const [total, patriarchs, muses, subscribed, paused, dynamics] = await Promise.all([
    supabase.from('profiles').select('*', { count: 'exact', head: true }),
    supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('gender', 'patriarch'),
    supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('gender', 'muse'),
    supabase.from('subscriptions').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('is_paused', true),
    supabase.from('constellations').select('*', { count: 'exact', head: true }).eq('is_active', true),
  ])

  return c.json({
    total:      total.count      ?? 0,
    patriarch:  patriarchs.count ?? 0,
    muse:       muses.count      ?? 0,
    subscribed: subscribed.count ?? 0,
    paused:     paused.count     ?? 0,
    dynamics:   dynamics.count   ?? 0,
  })
})

// GET /users/:id
// Returns a single user's full profile + photos + stats
users.get('/:id', requireRole('viewer'), async (c) => {
  const id = c.req.param('id')

  const [profile, photos, promptAnswers, subscription, likesSent, likesReceived, matchCount, reportCount] =
    await Promise.all([
      supabase.from('profiles').select('*').eq('id', id).single(),
      supabase.from('photos').select('*').eq('user_id', id).order('order_index'),
      supabase.from('prompt_answers').select('*, prompt:prompts(text)').eq('user_id', id),
      supabase.from('subscriptions').select('tier, status, billing_interval, current_period_end, cancel_at_period_end').eq('user_id', id).maybeSingle(),
      supabase.from('likes').select('*', { count: 'exact', head: true }).eq('liker_id', id),
      supabase.from('likes').select('*', { count: 'exact', head: true }).eq('liked_id', id),
      supabase.from('matches').select('*', { count: 'exact', head: true }).or(`user1_id.eq.${id},user2_id.eq.${id}`),
      supabase.from('reports').select('*', { count: 'exact', head: true }).eq('reported_id', id),
    ])

  if (profile.error) return c.json({ error: 'User not found' }, 404)

  return c.json({
    profile:        profile.data,
    photos:         photos.data         ?? [],
    prompt_answers: promptAnswers.data  ?? [],
    subscription:   subscription.data   ?? null,
    stats: {
      likes_sent:     likesSent.count     ?? 0,
      likes_received: likesReceived.count ?? 0,
      matches:        matchCount.count    ?? 0,
      reports_against: reportCount.count ?? 0,
    },
  })
})

// GET /users/:id/reports
// Returns all reports filed against this user
users.get('/:id/reports', requireRole('support'), async (c) => {
  const id = c.req.param('id')

  const { data, error } = await supabase
    .from('reports')
    .select('id, reason, notes, created_at, reporter:profiles!reporter_id(id, first_name, last_name, gender)')
    .eq('reported_id', id)
    .order('created_at', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// GET /users/:id/messages
// Returns recent messages sent by this user (moderator view)
users.get('/:id/messages', requireRole('support'), async (c) => {
  const id    = c.req.param('id')
  const limit = Number(c.req.query('limit') ?? 30)

  const { data, error } = await supabase
    .from('messages')
    .select('id, content, created_at, is_deleted, contains_flagged_words, flagged_words, match_id, chat_id')
    .eq('sender_id', id)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// GET /users/:id/sanctions
// Returns active sanctions for a user (current moderation status)
users.get('/:id/sanctions', requireRole('support'), async (c) => {
  const id  = c.req.param('id')
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('user_sanctions')
    .select('*, issued_by_admin:admin_users!issued_by(full_name)')
    .eq('user_id', id)
    .is('revoked_at', null)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order('issued_at', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// PATCH /users/:id
// Update admin-controlled profile fields (only is_paused for now — moderation actions use /sanctions)
users.patch('/:id', requireRole('support'), async (c) => {
  const id   = c.req.param('id')
  const body = await c.req.json<Record<string, unknown>>()

  const allowed = ['is_paused']
  const update  = Object.fromEntries(
    Object.entries(body).filter(([k]) => allowed.includes(k))
  )

  if (!Object.keys(update).length) {
    return c.json({ error: 'No valid fields to update' }, 400)
  }

  const { error } = await supabase.from('profiles').update(update).eq('id', id)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

export default users
