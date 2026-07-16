import { createClient } from 'npm:@supabase/supabase-js@2'

const supabaseUrl      = Deno.env.get('SUPABASE_URL')!
const serviceRoleKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Service role client — bypasses RLS, never expose to the browser
export const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession:   false,
  },
})
