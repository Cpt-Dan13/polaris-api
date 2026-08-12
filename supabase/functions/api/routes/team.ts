import { Hono } from 'npm:hono@4'
import { supabase } from '../../_shared/supabase.ts'
import { requireRole } from '../../_shared/rbac.ts'

const team = new Hono()

// GET /team
// List all admin_users ordered by creation date.
team.get('/', requireRole('super_admin'), async (c) => {
  const { data, error } = await supabase
    .from('admin_users')
    .select('id, user_id, email, full_name, role, avatar_seed, created_at, last_seen_at')
    .order('created_at', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data: data ?? [] })
})

// POST /team
// Create a new Supabase auth user + admin_users record in one step.
// Body: { email, password, full_name, role, avatar_seed? }
team.post('/', requireRole('super_admin'), async (c) => {
  const body = await c.req.json<{
    email:       string
    password:    string
    full_name:   string
    role:        string
    avatar_seed: string | null
  }>()

  const { email, password, full_name, role, avatar_seed } = body

  if (!email || !password || !full_name || !role) {
    return c.json({ error: 'email, password, full_name and role are required' }, 400)
  }

  const validRoles = ['viewer', 'support', 'moderator', 'admin', 'super_admin']
  if (!validRoles.includes(role)) {
    return c.json({ error: `Invalid role: ${role}` }, 400)
  }

  // Step 1 — create the Supabase auth user
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })

  if (authError || !authData.user) {
    return c.json({ error: authError?.message ?? 'Failed to create auth user' }, 500)
  }

  // Step 2 — insert into admin_users
  const { data, error } = await supabase
    .from('admin_users')
    .insert({
      user_id:     authData.user.id,
      email,
      full_name,
      role,
      avatar_seed: avatar_seed ?? null,
    })
    .select('id, user_id, email, full_name, role, avatar_seed, created_at, last_seen_at')
    .single()

  if (error) {
    // Best-effort cleanup — delete the auth user if the DB insert failed
    await supabase.auth.admin.deleteUser(authData.user.id)
    return c.json({ error: error.message }, 500)
  }

  return c.json({ data }, 201)
})

export default team
