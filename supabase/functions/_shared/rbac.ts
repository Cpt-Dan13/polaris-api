import type { Context, Next } from 'npm:hono@4'

export type AdminRole = 'viewer' | 'support' | 'super_admin'

const ROLE_RANK: Record<AdminRole, number> = {
  viewer:      0,
  support:     1,
  super_admin: 2,
}

/** Returns a Hono middleware that requires the caller to have at least `minRole`. */
export function requireRole(minRole: AdminRole) {
  return async (c: Context, next: Next) => {
    const adminUser = c.get('adminUser') as { role: AdminRole } | undefined

    if (!adminUser) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const callerRank = ROLE_RANK[adminUser.role] ?? -1
    const required   = ROLE_RANK[minRole]

    if (callerRank < required) {
      return c.json(
        { error: `Forbidden — requires role '${minRole}' or higher` },
        403,
      )
    }

    await next()
  }
}
