import { Hono } from 'hono'
import { supabase } from '../../_shared/supabase.ts'
import { requireRole } from '../../_shared/rbac.ts'

const moderation = new Hono()

// ── Reports ─────────────────────────────────────────────────────────────────

// GET /moderation/reports
// Returns user-submitted reports with reporter + reported profile info
moderation.get('/reports', requireRole('moderator'), async (c) => {
  const limit = Number(c.req.query('limit') ?? 50)

  const { data, error } = await supabase
    .from('reports')
    .select(`
      id, reason, notes, created_at,
      reporter:profiles!reporter_id(id, first_name, last_name, gender),
      reported:profiles!reported_id(id, first_name, last_name, gender)
    `)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// GET /moderation/reports/:id
// Returns a single report with full profile info
moderation.get('/reports/:id', requireRole('moderator'), async (c) => {
  const id = c.req.param('id')

  const { data, error } = await supabase
    .from('reports')
    .select(`
      id, reason, notes, created_at,
      reporter:profiles!reporter_id(id, first_name, last_name, gender),
      reported:profiles!reported_id(id, first_name, last_name, gender)
    `)
    .eq('id', id)
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// ── Flagged Messages ─────────────────────────────────────────────────────────

// GET /moderation/flagged-messages
// Returns messages flagged by the word-filter system
moderation.get('/flagged-messages', requireRole('moderator'), async (c) => {
  const limit = Number(c.req.query('limit') ?? 50)

  const { data, error } = await supabase
    .from('messages')
    .select(`
      id, content, flagged_words, flagged_at, created_at, match_id, chat_id,
      sender:profiles!sender_id(id, first_name, last_name, gender)
    `)
    .eq('contains_flagged_words', true)
    .eq('is_deleted', false)
    .order('flagged_at', { ascending: false })
    .limit(limit)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// GET /moderation/flagged-messages/count
// Returns total count of unreviewed flagged messages
moderation.get('/flagged-messages/count', requireRole('moderator'), async (c) => {
  const { count, error } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('contains_flagged_words', true)
    .eq('is_deleted', false)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ count: count ?? 0 })
})

// ── Blocks ───────────────────────────────────────────────────────────────────

// GET /moderation/blocks
// Returns recent block events for pattern detection
moderation.get('/blocks', requireRole('moderator'), async (c) => {
  const limit = Number(c.req.query('limit') ?? 50)

  const { data, error } = await supabase
    .from('blocks')
    .select(`
      id, created_at,
      blocker:profiles!blocker_id(id, first_name, last_name, gender),
      blocked:profiles!blocked_id(id, first_name, last_name, gender)
    `)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// ── User Moderation Actions ───────────────────────────────────────────────────
// These routes update columns added by migration 20260717000001_add_moderation_columns

// POST /moderation/users/:id/ban
moderation.post('/users/:id/ban', requireRole('admin'), async (c) => {
  const id   = c.req.param('id')
  const body = await c.req.json<{ reason: string }>()

  const { error } = await supabase
    .from('profiles')
    .update({
      is_banned:  true,
      ban_reason: body.reason,
      banned_at:  new Date().toISOString(),
    })
    .eq('id', id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

// POST /moderation/users/:id/unban
moderation.post('/users/:id/unban', requireRole('admin'), async (c) => {
  const id = c.req.param('id')

  const { error } = await supabase
    .from('profiles')
    .update({ is_banned: false, ban_reason: null, banned_at: null })
    .eq('id', id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

// POST /moderation/users/:id/suspend
moderation.post('/users/:id/suspend', requireRole('admin'), async (c) => {
  const id   = c.req.param('id')
  const body = await c.req.json<{ duration_hours: number; reason: string }>()

  const until = new Date(Date.now() + body.duration_hours * 3_600_000).toISOString()

  const { error } = await supabase
    .from('profiles')
    .update({ suspended_until: until, suspension_reason: body.reason })
    .eq('id', id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true, suspended_until: until })
})

// POST /moderation/users/:id/unsuspend
moderation.post('/users/:id/unsuspend', requireRole('admin'), async (c) => {
  const id = c.req.param('id')

  const { error } = await supabase
    .from('profiles')
    .update({ suspended_until: null, suspension_reason: null })
    .eq('id', id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

export default moderation
