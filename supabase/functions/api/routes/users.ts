import { Hono } from 'hono'
import { supabase } from '../../_shared/supabase.ts'
import { requireRole } from '../../_shared/rbac.ts'

const users = new Hono()

// GET /users
// Returns paginated user list with optional search
users.get('/', requireRole('viewer'), async (c) => {
  const search  = c.req.query('search')
  const limit   = Number(c.req.query('limit') ?? 50)
  const offset  = Number(c.req.query('offset') ?? 0)
  const userType = c.req.query('user_type')

  let query = supabase
    .from('profiles')
    .select('user_id, username, email, user_type, subscription_plan, created_at, banned, suspended_until, avatar_url', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (search)   query = query.or(`username.ilike.%${search}%,email.ilike.%${search}%`)
  if (userType) query = query.eq('user_type', userType)

  const { data, count, error } = await query
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data, count })
})

// GET /users/:id
// Returns a single user's full profile + stats
users.get('/:id', requireRole('viewer'), async (c) => {
  const id = c.req.param('id')

  const [profile, stats] = await Promise.all([
    supabase
      .from('profiles')
      .select('*')
      .eq('user_id', id)
      .single(),
    supabase
      .from('swipe_events')
      .select('decision', { count: 'exact' })
      .eq('user_id', id),
  ])

  if (profile.error) return c.json({ error: profile.error.message }, 500)
  return c.json({ data: profile.data, swipe_count: stats.count ?? 0 })
})

// GET /users/:id/photos
// Returns all uploaded photos for a user
users.get('/:id/photos', requireRole('moderator'), async (c) => {
  const id = c.req.param('id')

  const { data, error } = await supabase
    .from('photos')
    .select('*')
    .eq('user_id', id)
    .order('created_at', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// PATCH /users/:id
// Update mutable fields on a profile (e.g. flag/unflag, notes)
users.patch('/:id', requireRole('moderator'), async (c) => {
  const id   = c.req.param('id')
  const body = await c.req.json<Record<string, unknown>>()

  // Whitelist fields moderators may update
  const allowed = ['flagged', 'admin_notes']
  const update  = Object.fromEntries(
    Object.entries(body).filter(([k]) => allowed.includes(k)),
  )

  if (!Object.keys(update).length) {
    return c.json({ error: 'No valid fields to update' }, 400)
  }

  const { error } = await supabase
    .from('profiles')
    .update(update)
    .eq('user_id', id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

// GET /users/summary/counts
// Returns total / active / banned / suspended counts
users.get('/summary/counts', requireRole('viewer'), async (c) => {
  const [total, banned, suspended] = await Promise.all([
    supabase.from('profiles').select('*', { count: 'exact', head: true }),
    supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('banned', true),
    supabase.from('profiles').select('*', { count: 'exact', head: true }).gt('suspended_until', new Date().toISOString()),
  ])

  return c.json({
    total:     total.count     ?? 0,
    banned:    banned.count    ?? 0,
    suspended: suspended.count ?? 0,
    active:    (total.count ?? 0) - (banned.count ?? 0),
  })
})

export default users
