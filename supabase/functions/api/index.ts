import { Hono } from 'npm:hono@4'
import { cors } from 'npm:hono@4/cors'
import { corsOptions } from '../_shared/cors.ts'
import { authMiddleware } from '../_shared/auth.ts'
import { supabase } from '../_shared/supabase.ts'

import analytics  from './routes/analytics.ts'
import moderation from './routes/moderation.ts'
import chat       from './routes/chat.ts'
import finance    from './routes/finance.ts'
import users      from './routes/users.ts'

const app = new Hono().basePath('/api')

// ── Global middleware ───────────────────────────────────────────────────────

app.use('*', cors(corsOptions))

// Health check — no auth required
app.get('/health', (c) => c.json({ status: 'ok', version: '1.0.0' }))

// All routes below this point require a valid admin JWT
app.use('*', authMiddleware)

// GET /api/me — returns the current admin user's profile
app.get('/me', (c) => c.json({ data: c.get('adminUser') }))

// PATCH /api/me/avatar — update the calling admin's robot avatar seed
app.patch('/me/avatar', async (c) => {
  const adminUser = c.get('adminUser') as { id: string }
  const { seed } = await c.req.json<{ seed: string | null }>()
  const { error } = await supabase
    .from('admin_users')
    .update({ avatar_seed: seed ?? null })
    .eq('id', adminUser.id)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true, avatar_seed: seed ?? null })
})

// ── Route groups ────────────────────────────────────────────────────────────

app.route('/analytics',        analytics)
app.route('/moderation',       moderation)
app.route('/moderation/chat',  chat)
app.route('/finance',          finance)
app.route('/users',            users)

// ── Fallback ────────────────────────────────────────────────────────────────

app.notFound((c) => c.json({ error: 'Route not found' }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500)
})

// Supabase Edge Functions expect a Deno.serve() call
Deno.serve(app.fetch)
