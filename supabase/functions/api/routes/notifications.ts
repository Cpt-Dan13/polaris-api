import { Hono } from 'npm:hono@4'
import { supabase } from '../../_shared/supabase.ts'
import { requireRole } from '../../_shared/rbac.ts'

const notifications = new Hono()

// GET /notifications?limit=20&offset=0
// Returns notifications visible to the current admin (global + targeted),
// newest first. Each item includes a computed `read` boolean.
notifications.get('/', requireRole('viewer'), async (c) => {
  const adminUser = c.get('adminUser') as { user_id: string }
  const limit  = Math.min(Number(c.req.query('limit')  ?? 20), 50)
  const offset = Number(c.req.query('offset') ?? 0)
  const userId = adminUser.user_id

  const { data, count, error } = await supabase
    .from('admin_notifications')
    .select('*', { count: 'exact' })
    .or(`target_admin_id.is.null,target_admin_id.eq.${userId}`)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) return c.json({ error: error.message }, 500)

  const items = (data ?? []).map((n: any) => ({
    ...n,
    read: Array.isArray(n.read_by) && (n.read_by as string[]).includes(userId),
  }))

  return c.json({ data: items, count })
})

// GET /notifications/unread-count
// Lightweight poll endpoint — returns just the unread count for the badge.
notifications.get('/unread-count', requireRole('viewer'), async (c) => {
  const adminUser = c.get('adminUser') as { user_id: string }
  const userId = adminUser.user_id

  const { data, error } = await supabase
    .from('admin_notifications')
    .select('read_by')
    .or(`target_admin_id.is.null,target_admin_id.eq.${userId}`)

  if (error) return c.json({ error: error.message }, 500)

  const count = (data ?? []).filter(
    (n: any) => !Array.isArray(n.read_by) || !(n.read_by as string[]).includes(userId)
  ).length

  return c.json({ count })
})

// PATCH /notifications/read-all
// Must come BEFORE /:id so Hono doesn't treat "read-all" as an id param.
notifications.patch('/read-all', requireRole('viewer'), async (c) => {
  const adminUser = c.get('adminUser') as { user_id: string }
  const { error } = await supabase.rpc('mark_all_notifications_read', {
    p_admin_user_id: adminUser.user_id,
  })
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true })
})

// PATCH /notifications/:id/read
// Marks a single notification as read for the current admin.
notifications.patch('/:id/read', requireRole('viewer'), async (c) => {
  const adminUser = c.get('adminUser') as { user_id: string }
  const { error } = await supabase.rpc('mark_notification_read', {
    p_notification_id: c.req.param('id'),
    p_admin_user_id:   adminUser.user_id,
  })
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true })
})

export default notifications

// ── Helper exported for use as a side-effect in other route handlers ──────────

export async function createNotification(
  type:           string,
  title:          string,
  body:           string,
  metadata:       Record<string, unknown> = {},
  targetAdminId?: string | null,
): Promise<void> {
  await supabase.from('admin_notifications').insert({
    type,
    title,
    body,
    metadata,
    target_admin_id: targetAdminId ?? null,
  })
}
