import { Hono } from 'npm:hono@4'
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

// ── User Sanctions ────────────────────────────────────────────────────────────
// Append-only — never mutate rows. Revoke by setting revoked_at/revoked_by.

// GET /moderation/users/:id/sanctions
// Returns full sanction history for a user
moderation.get('/users/:id/sanctions', requireRole('moderator'), async (c) => {
  const id = c.req.param('id')

  const { data, error } = await supabase
    .from('user_sanctions')
    .select('*, issued_by_admin:admin_users!issued_by(full_name, email), revoked_by_admin:admin_users!revoked_by(full_name, email)')
    .eq('user_id', id)
    .order('issued_at', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// POST /moderation/users/:id/warn
moderation.post('/users/:id/warn', requireRole('moderator'), async (c) => {
  const id        = c.req.param('id')
  const body      = await c.req.json<{ reason: string }>()
  const adminUser = c.get('adminUser') as { id: string }

  const { data, error } = await supabase
    .from('user_sanctions')
    .insert({ user_id: id, type: 'warning', reason: body.reason, issued_by: adminUser.id })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true, sanction: data })
})

// POST /moderation/users/:id/suspend
moderation.post('/users/:id/suspend', requireRole('admin'), async (c) => {
  const id        = c.req.param('id')
  const body      = await c.req.json<{ duration_hours: number; reason: string }>()
  const adminUser = c.get('adminUser') as { id: string }

  const expires_at = new Date(Date.now() + body.duration_hours * 3_600_000).toISOString()

  const { data, error } = await supabase
    .from('user_sanctions')
    .insert({ user_id: id, type: 'suspension', reason: body.reason, issued_by: adminUser.id, expires_at })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true, sanction: data })
})

// POST /moderation/users/:id/ban
moderation.post('/users/:id/ban', requireRole('admin'), async (c) => {
  const id        = c.req.param('id')
  const body      = await c.req.json<{ reason: string }>()
  const adminUser = c.get('adminUser') as { id: string }

  // expires_at is null = permanent ban
  const { data, error } = await supabase
    .from('user_sanctions')
    .insert({ user_id: id, type: 'ban', reason: body.reason, issued_by: adminUser.id, expires_at: null })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true, sanction: data })
})

// POST /moderation/sanctions/:id/revoke
// Revoke any active sanction (unban, unsuspend, clear warning)
moderation.post('/sanctions/:id/revoke', requireRole('admin'), async (c) => {
  const id        = c.req.param('id')
  const adminUser = c.get('adminUser') as { id: string }

  const { error } = await supabase
    .from('user_sanctions')
    .update({ revoked_at: new Date().toISOString(), revoked_by: adminUser.id })
    .eq('id', id)
    .is('revoked_at', null)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

export default moderation
