import { Hono } from 'npm:hono@4'
import { supabase } from '../../_shared/supabase.ts'
import { requireRole } from '../../_shared/rbac.ts'

const support = new Hono()

// GET /support
// Returns paginated support tickets with optional status / priority filters.
support.get('/', requireRole('viewer'), async (c) => {
  const status   = c.req.query('status')
  const priority = c.req.query('priority')
  const limit    = Number(c.req.query('limit')  ?? 50)
  const offset   = Number(c.req.query('offset') ?? 0)

  let query = supabase
    .from('support_tickets')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  // DB stores 'in_progress'; normalise to 'in-progress' before filtering
  if (status)   query = query.eq('status',   status === 'in-progress' ? 'in_progress' : status)
  if (priority) query = query.eq('priority', priority)

  const { data, count, error } = await query
  if (error) return c.json({ error: error.message }, 500)

  // Normalise status back to frontend convention (in_progress → in-progress)
  const normalised = (data ?? []).map((t: any) => ({
    ...t,
    status: t.status === 'in_progress' ? 'in-progress' : t.status,
  }))

  return c.json({ data: normalised, count })
})

// PATCH /support/:id
// Update a ticket's status, assigned_to, and/or assessment_note.
support.patch('/:id', requireRole('support'), async (c) => {
  const id   = c.req.param('id')
  const body = await c.req.json<Record<string, unknown>>()

  const allowed = ['status', 'assigned_to', 'assessment_note']
  const update  = Object.fromEntries(
    Object.entries(body).filter(([k]) => allowed.includes(k))
  )

  // Normalise status to DB convention
  if (update.status === 'in-progress') update.status = 'in_progress'

  if ('assessment_note' in update) {
    if (update.assessment_note !== null && typeof update.assessment_note !== 'string') {
      return c.json({ error: 'assessment_note must be a string or null' }, 400)
    }

    update.assessment_note = typeof update.assessment_note === 'string'
      ? update.assessment_note.trim() || null
      : null
  }

  if (!Object.keys(update).length) {
    return c.json({ error: 'No valid fields to update' }, 400)
  }

  const { data, error } = await supabase
    .from('support_tickets')
    .update(update)
    .eq('id', id)
    .select('*')
    .single()

  if (error) return c.json({ error: error.message }, 500)

  return c.json({
    data: {
      ...data,
      status: data.status === 'in_progress' ? 'in-progress' : data.status,
    },
  })
})

export default support
