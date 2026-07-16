import { Hono } from 'hono'
import { supabase } from '../../_shared/supabase.ts'
import { requireRole } from '../../_shared/rbac.ts'

const moderation = new Hono()

// ── Reports ────────────────────────────────────────────────────────────────

// GET /moderation/reports
// Returns user-submitted reports with optional status filter
moderation.get('/reports', requireRole('moderator'), async (c) => {
  const status   = c.req.query('status')
  const category = c.req.query('category')
  const limit    = Number(c.req.query('limit') ?? 50)

  let query = supabase
    .from('reports')
    .select('*, reporter:profiles!reporter_id(username, avatar_url), reported:profiles!reported_id(username, avatar_url)')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (status)   query = query.eq('status', status)
  if (category) query = query.eq('category', category)

  const { data, error } = await query
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// PATCH /moderation/reports/:id
// Update report status (open → investigating → resolved/dismissed)
moderation.patch('/reports/:id', requireRole('moderator'), async (c) => {
  const id   = c.req.param('id')
  const body = await c.req.json<{ status: string; action?: string; notes?: string }>()

  const { error } = await supabase
    .from('reports')
    .update({
      status:     body.status,
      action:     body.action,
      notes:      body.notes,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

// ── Chat Assessment ────────────────────────────────────────────────────────

// GET /moderation/chat-flags
// Returns AI-flagged conversation segments awaiting review
moderation.get('/chat-flags', requireRole('moderator'), async (c) => {
  const severity = c.req.query('severity')
  const limit    = Number(c.req.query('limit') ?? 50)

  let query = supabase
    .from('chat_flags')
    .select('*, message:messages(content, created_at), user:profiles!user_id(username, avatar_url)')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (severity) query = query.eq('severity', severity)

  const { data, error } = await query
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// PATCH /moderation/chat-flags/:id
// Approve, escalate, or action a flagged message
moderation.patch('/chat-flags/:id', requireRole('moderator'), async (c) => {
  const id   = c.req.param('id')
  const body = await c.req.json<{ status: string; action?: string }>()

  const { error } = await supabase
    .from('chat_flags')
    .update({ status: body.status, action: body.action, reviewed_at: new Date().toISOString() })
    .eq('id', id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

// ── User Actions ───────────────────────────────────────────────────────────

// POST /moderation/users/:id/warn
moderation.post('/users/:id/warn', requireRole('moderator'), async (c) => {
  const id   = c.req.param('id')
  const body = await c.req.json<{ reason: string }>()

  const { error } = await supabase
    .from('user_warnings')
    .insert({ user_id: id, reason: body.reason, issued_at: new Date().toISOString() })

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
    .eq('user_id', id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true, suspended_until: until })
})

// POST /moderation/users/:id/ban
moderation.post('/users/:id/ban', requireRole('admin'), async (c) => {
  const id   = c.req.param('id')
  const body = await c.req.json<{ reason: string }>()

  const { error } = await supabase
    .from('profiles')
    .update({ banned: true, ban_reason: body.reason, banned_at: new Date().toISOString() })
    .eq('user_id', id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

export default moderation
