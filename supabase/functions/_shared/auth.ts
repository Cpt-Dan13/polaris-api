import type { Context, Next } from 'npm:hono@4'
import { supabase } from './supabase.ts'

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing authorization header' }, 401)
  }

  const token = authHeader.replace('Bearer ', '')

  // Verify the JWT with Supabase Auth
  const { data: { user }, error } = await supabase.auth.getUser(token)

  if (error || !user) {
    return c.json({ error: 'Invalid or expired token' }, 401)
  }

  // Confirm the user exists in admin_users table
  const { data: adminUser, error: adminError } = await supabase
    .from('admin_users')
    .select('id, email, role')
    .eq('user_id', user.id)
    .single()

  if (adminError || !adminUser) {
    return c.json({ error: 'Access denied — not an admin account' }, 403)
  }

  // Attach admin context to the request for downstream use
  c.set('adminUser', adminUser)

  await next()
}
