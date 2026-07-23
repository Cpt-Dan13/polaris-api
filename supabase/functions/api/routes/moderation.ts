import { Hono } from 'npm:hono@4'
import { supabase } from '../../_shared/supabase.ts'
import { requireRole } from '../../_shared/rbac.ts'

const moderation = new Hono()

// ── Reports ─────────────────────────────────────────────────────────────────

// GET /moderation/reports/kpis
// Aggregated counts for the Report Evaluation dashboard
// NOTE: must be declared before /:id to avoid matching 'kpis' as an id param
moderation.get('/reports/kpis', requireRole('support'), async (c) => {
  const [openRes, investigatingRes, resolvedRes, dismissedRes, totalRes] = await Promise.all([
    supabase.from('reports').select('*', { count: 'exact', head: true }).eq('status', 'open'),
    supabase.from('reports').select('*', { count: 'exact', head: true }).eq('status', 'investigating'),
    supabase.from('reports').select('*', { count: 'exact', head: true }).eq('status', 'resolved'),
    supabase.from('reports').select('*', { count: 'exact', head: true }).eq('status', 'dismissed'),
    supabase.from('reports').select('*', { count: 'exact', head: true }),
  ])

  const open          = openRes.count          ?? 0
  const investigating = investigatingRes.count  ?? 0
  const resolved      = resolvedRes.count      ?? 0
  const dismissed     = dismissedRes.count     ?? 0
  const total         = totalRes.count         ?? 0
  const closed        = resolved + dismissed

  return c.json({
    open_reports:    open,
    escalated:       investigating,
    resolution_rate: total > 0 ? parseFloat(((closed / total) * 100).toFixed(1)) : 0,
    total_reports:   total,
  })
})

// GET /moderation/reports/category-breakdown
// Count of non-trivial classified reports grouped by category
moderation.get('/reports/category-breakdown', requireRole('support'), async (c) => {
  const { data, error } = await supabase
    .from('reports')
    .select('category')
    .not('category', 'is', null)
    .eq('is_trivial', false)

  if (error) return c.json({ error: error.message }, 500)

  const counts: Record<string, number> = {}
  for (const row of data ?? []) {
    if (row.category) counts[row.category] = (counts[row.category] ?? 0) + 1
  }

  const by_category = Object.entries(counts).map(([category, count]) => ({ category, count }))
  const total       = by_category.reduce((a, b) => a + b.count, 0)

  return c.json({ total, by_category })
})

// GET /moderation/reports
// Paginated non-trivial reports with reporter + reported profiles + photos
// Query params: status, category, priority, limit, offset
moderation.get('/reports', requireRole('support'), async (c) => {
  const limit    = Math.min(Number(c.req.query('limit')  ?? 50), 200)
  const offset   = Number(c.req.query('offset') ?? 0)
  const status   = c.req.query('status')
  const category = c.req.query('category')
  const priority = c.req.query('priority')

  let query = supabase
    .from('reports')
    .select(`
      id, reason, notes, category, is_trivial, status, priority, created_at,
      reporter:profiles!reporter_id(id, first_name, last_name, gender),
      reported:profiles!reported_id(id, first_name, last_name, gender)
    `, { count: 'exact' })
    .eq('is_trivial', false)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (status)   query = query.eq('status', status)
  if (category) query = query.eq('category', category)
  if (priority) query = query.eq('priority', priority)

  const { data, count, error } = await query
  if (error) return c.json({ error: error.message }, 500)

  // Fetch primary photos for all reporters + reported profiles
  // deno-lint-ignore no-explicit-any
  const rows = (data ?? []) as any[]
  const userIds = [...new Set(
    rows.flatMap((r: any) => [r.reporter?.id, r.reported?.id]).filter(Boolean)
  )]
  const photoMap = new Map<string, string>()
  if (userIds.length > 0) {
    const { data: photos } = await supabase
      .from('photos')
      .select('user_id, url')
      .in('user_id', userIds)
      .order('order_index')
    for (const p of photos ?? []) {
      if (!photoMap.has(p.user_id)) photoMap.set(p.user_id, p.url)
    }
  }

  // deno-lint-ignore no-explicit-any
  const reports = rows.map((r: any) => ({
    id:         r.id,
    reason:     r.reason,
    notes:      r.notes,
    category:   r.category,
    is_trivial: r.is_trivial,
    status:     r.status,
    priority:   r.priority,
    created_at: r.created_at,
    reporter: r.reporter ? { ...r.reporter, photo_url: photoMap.get(r.reporter.id) ?? null } : null,
    reported: r.reported ? { ...r.reported, photo_url: photoMap.get(r.reported.id) ?? null } : null,
  }))

  return c.json({ data: reports, count: count ?? 0 })
})

// GET /moderation/reports/:id
// Returns a single report with full profile info
moderation.get('/reports/:id', requireRole('support'), async (c) => {
  const id = c.req.param('id')

  const { data, error } = await supabase
    .from('reports')
    .select(`
      id, reason, notes, category, is_trivial, status, priority, created_at,
      reporter:profiles!reporter_id(id, first_name, last_name, gender),
      reported:profiles!reported_id(id, first_name, last_name, gender)
    `)
    .eq('id', id)
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// POST /moderation/reports/:id/action
// Apply a moderation action to a report.
// Body: { action: 'warn'|'suspend_24h'|'suspend_7d'|'ban'|'dismiss'|'investigate', notes?: string }
moderation.post('/reports/:id/action', requireRole('support'), async (c) => {
  const id        = c.req.param('id')
  const body      = await c.req.json<{ action: string; notes?: string }>()
  const adminUser = c.get('adminUser') as { id: string }
  const { action, notes } = body

  const validActions = ['warn', 'suspend_24h', 'suspend_7d', 'ban', 'dismiss', 'investigate']
  if (!validActions.includes(action)) {
    return c.json({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` }, 400)
  }

  // Status-only transitions (no sanction)
  if (action === 'investigate') {
    const { error } = await supabase.from('reports').update({ status: 'investigating' }).eq('id', id)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ success: true, status: 'investigating' })
  }

  if (action === 'dismiss') {
    const { error } = await supabase.from('reports').update({ status: 'dismissed' }).eq('id', id)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ success: true, status: 'dismissed' })
  }

  // Sanction-based actions: fetch reported_id, then resolve + sanction in parallel
  const { data: report, error: fetchErr } = await supabase
    .from('reports')
    .select('reported_id, category')
    .eq('id', id)
    .single()

  if (fetchErr || !report) return c.json({ error: 'Report not found' }, 404)

  const sanctionType =
    action === 'ban'  ? 'ban'       :
    action === 'warn' ? 'warning'   : 'suspension'

  let expires_at: string | null = null
  if (action === 'suspend_24h') expires_at = new Date(Date.now() +      24 * 3_600_000).toISOString()
  if (action === 'suspend_7d')  expires_at = new Date(Date.now() + 7 * 24 * 3_600_000).toISOString()

  const sanctionReason = notes?.trim() || `Report action (${action}) — ${report.category ?? 'unclassified'}`

  const [updateRes, sanctionRes] = await Promise.all([
    supabase.from('reports').update({ status: 'resolved' }).eq('id', id),
    supabase.from('user_sanctions').insert({
      user_id:    report.reported_id,
      type:       sanctionType,
      reason:     sanctionReason,
      issued_by:  adminUser.id,
      expires_at,
    }),
  ])

  if (updateRes.error)   return c.json({ error: updateRes.error.message }, 500)
  if (sanctionRes.error) return c.json({ error: sanctionRes.error.message }, 500)

  return c.json({ success: true, status: 'resolved' })
})

// ── Flagged Messages ─────────────────────────────────────────────────────────

// GET /moderation/flagged-messages
// Returns messages flagged by the word-filter system
moderation.get('/flagged-messages', requireRole('support'), async (c) => {
  const limit = Number(c.req.query('limit') ?? 50)

  const { data, error } = await supabase
    .from('messages')
    .select(`
      id, content, flagged_words, created_at, match_id, chat_id,
      sender:profiles!sender_id(id, first_name, last_name, gender)
    `)
    .eq('contains_flagged_words', true)
    .eq('is_deleted', false)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// GET /moderation/flagged-messages/count
// Returns total count of unreviewed flagged messages
moderation.get('/flagged-messages/count', requireRole('support'), async (c) => {
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
moderation.get('/blocks', requireRole('support'), async (c) => {
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
moderation.get('/users/:id/sanctions', requireRole('support'), async (c) => {
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
moderation.post('/users/:id/warn', requireRole('support'), async (c) => {
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
moderation.post('/users/:id/suspend', requireRole('super_admin'), async (c) => {
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
moderation.post('/users/:id/ban', requireRole('super_admin'), async (c) => {
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
moderation.post('/sanctions/:id/revoke', requireRole('super_admin'), async (c) => {
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
