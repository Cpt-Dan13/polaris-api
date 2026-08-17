import { Hono } from 'npm:hono@4'
import { supabase } from '../../_shared/supabase.ts'
import { requireRole } from '../../_shared/rbac.ts'
import { sendEmail, sendBatch, type EmailPayload } from '../../_shared/resend.ts'
import { createNotification } from './notifications.ts'

const email = new Hono()

// ── HTML templates ─────────────────────────────────────────────────────────────

function announcementHtml(title: string, body: string): string {
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#0f0e17;color:#e8e8e8;border-radius:12px">
  <h2 style="color:#e94560;margin:0 0 16px;font-size:20px">${title}</h2>
  <p style="line-height:1.7;color:#c8c8c8;margin:0 0 32px;font-size:15px">${body.replace(/\n/g, '<br>')}</p>
  <div style="border-top:1px solid #2a2a3e;padding-top:16px;font-size:12px;color:#666">
    © Constell8tion LLC · All rights reserved
  </div>
</div>`
}

function directEmailHtml(body: string): string {
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#0f0e17;color:#e8e8e8;border-radius:12px">
  <p style="line-height:1.7;color:#c8c8c8;margin:0 0 32px;font-size:15px">${body.replace(/\n/g, '<br>')}</p>
  <div style="border-top:1px solid #2a2a3e;padding-top:16px;font-size:12px;color:#666">
    © Constell8tion LLC · All rights reserved
  </div>
</div>`
}

// ── POST /email/announcement ──────────────────────────────────────────────────
// Bulk-sends to all users matching the selected audience tier.
// Requires moderator or above.

email.post('/announcement', requireRole('moderator'), async (c) => {
  const adminUser = c.get('adminUser') as { id: string }
  const { title, body, audience } = await c.req.json<{
    title:    string
    body:     string
    audience: 'all' | 'orbit' | 'nova' | 'supernova'
  }>()

  if (!title?.trim() || !body?.trim() || !audience) {
    return c.json({ error: 'title, body and audience are required' }, 400)
  }

  let query = supabase
    .from('profiles')
    .select('email')
    .not('email', 'is', null)

  if (audience !== 'all') {
    query = query.eq('subscription_tier', audience)
  }

  const { data: profiles, error: fetchError } = await query
  if (fetchError) return c.json({ error: fetchError.message }, 500)
  if (!profiles?.length) {
    return c.json({ error: 'No users found for the selected audience' }, 404)
  }

  const payloads: EmailPayload[] = (profiles as { email: string }[]).map(p => ({
    to:      p.email,
    subject: title,
    html:    announcementHtml(title, body),
  }))

  const { sent, failed } = await sendBatch(payloads)

  // Persist record — announcements table created in Layer 4
  await supabase.from('announcements').insert({
    title,
    body,
    audience,
    sent_count:   sent,
    failed_count: failed,
    sent_by:      adminUser.id,
  })

  // Side-effect: notify all admins that an email broadcast went out
  await createNotification(
    'announcement_sent',
    'Email Broadcast Sent',
    `"${title}" sent to ${audience === 'all' ? 'all users' : `${audience} subscribers`} — ${sent} delivered`,
    { title, audience, sent_count: sent, failed_count: failed },
  )

  return c.json({ sent_count: sent, failed_count: failed })
})

// ── GET /email/announcements ──────────────────────────────────────────────────
// Returns past announcements for the history list in Polaris.

email.get('/announcements', requireRole('viewer'), async (c) => {
  const limit  = Number(c.req.query('limit')  ?? 20)
  const offset = Number(c.req.query('offset') ?? 0)

  const { data, count, error } = await supabase
    .from('announcements')
    .select('*, sent_by_admin:admin_users!sent_by(full_name)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data, count })
})

// ── POST /email/user/:id ──────────────────────────────────────────────────────
// Sends a one-off email to a single user by their profile id.
// Requires support or above.

email.post('/user/:id', requireRole('support'), async (c) => {
  const profileId = c.req.param('id')
  const { subject, body } = await c.req.json<{ subject: string; body: string }>()

  if (!subject?.trim() || !body?.trim()) {
    return c.json({ error: 'subject and body are required' }, 400)
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('email')
    .eq('id', profileId)
    .single()

  if (error || !profile?.email) {
    return c.json({ error: 'User not found or has no email' }, 404)
  }

  await sendEmail({
    to:      profile.email,
    subject,
    html:    directEmailHtml(body),
  })

  return c.json({ success: true })
})

export default email
