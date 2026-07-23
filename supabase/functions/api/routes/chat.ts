import { Hono } from 'npm:hono@4'
import { supabase } from '../../_shared/supabase.ts'
import { requireRole } from '../../_shared/rbac.ts'

const chat = new Hono()

// ── GET /moderation/chat/kpis ────────────────────────────────────────────────
// Dashboard KPI pills: monitored today, flag rate, awaiting review, auto-approved rate

chat.get('/kpis', requireRole('support'), async (c) => {
  const todayStart = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z'

  const [monitoredRes, flaggedTodayRes, awaitingRes, autoApprovedRes, totalApprovedRes] =
    await Promise.all([
      supabase.from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('is_deleted', false)
        .gte('created_at', todayStart),

      supabase.from('message_flags')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', todayStart),

      supabase.from('message_flags')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending'),

      // "Auto-approved" = approved with no human reviewer (keyword detected, never escalated)
      supabase.from('message_flags')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'approved')
        .is('reviewed_by', null),

      supabase.from('message_flags')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'approved'),
    ])

  if (monitoredRes.error)    return c.json({ error: monitoredRes.error.message }, 500)
  if (flaggedTodayRes.error) return c.json({ error: flaggedTodayRes.error.message }, 500)
  if (awaitingRes.error)     return c.json({ error: awaitingRes.error.message }, 500)

  const monitored     = monitoredRes.count    ?? 0
  const flaggedToday  = flaggedTodayRes.count ?? 0
  const awaiting      = awaitingRes.count     ?? 0
  const autoApproved  = autoApprovedRes.count ?? 0
  const totalApproved = totalApprovedRes.count ?? 0

  return c.json({
    monitored_today:    monitored,
    flagged_today:      flaggedToday,
    flag_rate:          monitored > 0
      ? parseFloat(((flaggedToday / monitored) * 100).toFixed(1))
      : 0,
    awaiting_review:    awaiting,
    auto_approved_rate: totalApproved > 0
      ? parseFloat(((autoApproved / totalApproved) * 100).toFixed(1))
      : 0,
  })
})

// ── GET /moderation/chat/risk-distribution ───────────────────────────────────
// Count of message flags grouped by category (classified flags only)

chat.get('/risk-distribution', requireRole('support'), async (c) => {
  // Fetch just the category column — bounded count (< 10k/day reasonable for MVP)
  const { data, error } = await supabase
    .from('message_flags')
    .select('category')
    .not('category', 'is', null)

  if (error) return c.json({ error: error.message }, 500)

  const counts: Record<string, number> = {}
  for (const row of data ?? []) {
    if (row.category) counts[row.category] = (counts[row.category] ?? 0) + 1
  }

  const by_category = Object.entries(counts).map(([category, count]) => ({ category, count }))
  const total       = by_category.reduce((a, b) => a + b.count, 0)

  return c.json({ total, by_category })
})

// ── GET /moderation/chat/flags ───────────────────────────────────────────────
// Paginated flagged conversations with sender/receiver profile + message snippet
// Query params: status, severity, limit, offset

chat.get('/flags', requireRole('support'), async (c) => {
  const limit           = Math.min(Number(c.req.query('limit')  ?? 50), 200)
  const offset          = Number(c.req.query('offset') ?? 0)
  const status          = c.req.query('status')
  const severity        = c.req.query('severity')
  const detectionSource = c.req.query('detection_source')

  let query = supabase
    .from('message_flags')
    .select(`
      id, category, severity, confidence, flagged_terms, status, detection_source,
      tech_review_requested, created_at,
      sender:profiles!sender_id(id, first_name, last_name),
      receiver:profiles!receiver_id(id, first_name, last_name),
      message:messages!message_id(content)
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (status)          query = query.eq('status', status)
  if (severity)        query = query.eq('severity', severity)
  if (detectionSource) query = query.eq('detection_source', detectionSource)

  const { data, count, error } = await query
  if (error) return c.json({ error: error.message }, 500)

  // Fetch primary photos for all senders + receivers in one query
  // deno-lint-ignore no-explicit-any
  const rows = (data ?? []) as any[]
  const userIds = [...new Set(
    rows.flatMap((r: any) => [r.sender?.id, r.receiver?.id]).filter(Boolean)
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

  // Truncate message content to a presentable snippet
  // deno-lint-ignore no-explicit-any
  const flags = rows.map((row: any) => {
    const raw = row.message?.content ?? ''
    const snippet = raw.length > 0
      ? `"${raw.slice(0, 120)}${raw.length > 120 ? '...' : ''}"`
      : null

    return {
      id:                    row.id,
      category:              row.category,
      severity:              row.severity,
      confidence:            row.confidence,
      flagged_terms:         row.flagged_terms,
      status:                row.status,
      detection_source:      row.detection_source,
      tech_review_requested: row.tech_review_requested,
      created_at:            row.created_at,
      sender:   row.sender   ? { ...row.sender,   photo_url: photoMap.get(row.sender.id)   ?? null } : null,
      receiver: row.receiver ? { ...row.receiver, photo_url: photoMap.get(row.receiver.id) ?? null } : null,
      snippet,
    }
  })

  return c.json({ data: flags, count: count ?? 0 })
})

// ── POST /moderation/chat/flags/:id/action ───────────────────────────────────
// Apply a moderation decision to a flagged conversation
// Body: { action: 'approve' | 'escalate' | 'ban' | 'tech_review', notes?: string }

chat.post('/flags/:id/action', requireRole('support'), async (c) => {
  const id        = c.req.param('id')
  const body      = await c.req.json<{ action: string; notes?: string }>()
  const adminUser = c.get('adminUser') as { id: string }

  const { action, notes } = body

  if (!['approve', 'escalate', 'ban', 'tech_review'].includes(action)) {
    return c.json({ error: 'Invalid action. Must be one of: approve, escalate, ban, tech_review' }, 400)
  }

  const now = new Date().toISOString()

  // Tech review: flag-only update, does not change moderation status
  if (action === 'tech_review') {
    const { error } = await supabase
      .from('message_flags')
      .update({
        tech_review_requested:    true,
        tech_review_requested_by: adminUser.id,
        tech_review_requested_at: now,
        review_notes:             notes ?? null,
      })
      .eq('id', id)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ success: true })
  }

  const statusMap: Record<string, string> = {
    approve:  'approved',
    escalate: 'escalated',
    ban:      'banned',
  }

  const newStatus = statusMap[action]

  // For ban: fetch the flag first to get sender_id + category for the sanction record
  if (action === 'ban') {
    const { data: flag, error: fetchErr } = await supabase
      .from('message_flags')
      .select('sender_id, category')
      .eq('id', id)
      .single()

    if (fetchErr || !flag) return c.json({ error: 'Flag not found' }, 404)

    const [updateRes, sanctionRes] = await Promise.all([
      supabase.from('message_flags')
        .update({ status: newStatus, reviewed_by: adminUser.id, reviewed_at: now, review_notes: notes ?? null })
        .eq('id', id),

      supabase.from('user_sanctions')
        .insert({
          user_id:   flag.sender_id,
          type:      'ban',
          reason:    notes?.trim()
            || `Chat Assessment ban — ${flag.category ?? 'unclassified'} flag`,
          issued_by:  adminUser.id,
          expires_at: null,  // permanent ban
        }),
    ])

    if (updateRes.error)  return c.json({ error: updateRes.error.message }, 500)
    if (sanctionRes.error) return c.json({ error: sanctionRes.error.message }, 500)

    return c.json({ success: true })
  }

  // Approve or escalate
  const { error } = await supabase
    .from('message_flags')
    .update({ status: newStatus, reviewed_by: adminUser.id, reviewed_at: now, review_notes: notes ?? null })
    .eq('id', id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

export default chat
