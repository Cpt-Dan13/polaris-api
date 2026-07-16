-- ─────────────────────────────────────────────────────────────────────────────
-- Admin users: team members who can access the Polaris dashboard
-- Linked to Supabase Auth (auth.users) via user_id
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.admin_users (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  role        text not null default 'viewer'
                check (role in ('viewer', 'support', 'moderator', 'admin', 'super_admin')),
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz,
  created_by  uuid references public.admin_users(id)
);

-- Only super_admin can read/write the admin_users table directly
-- (the Edge Function uses the service role key and bypasses RLS entirely)
alter table public.admin_users enable row level security;

create policy "service role only"
  on public.admin_users
  using (false);

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit log: immutable record of every admin action
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.admin_audit_log (
  id            uuid primary key default gen_random_uuid(),
  admin_user_id uuid references public.admin_users(id),
  action        text not null,          -- e.g. 'ban_user', 'resolve_report'
  target_table  text,                   -- e.g. 'profiles', 'reports'
  target_id     text,                   -- the row that was acted on
  metadata      jsonb default '{}',     -- any extra context (reason, duration, etc.)
  ip_address    text,
  created_at    timestamptz not null default now()
);

-- Audit log is append-only — no updates or deletes permitted via RLS
alter table public.admin_audit_log enable row level security;

create policy "service role only"
  on public.admin_audit_log
  using (false);

-- Index for fast lookups by admin or by target
create index on public.admin_audit_log (admin_user_id);
create index on public.admin_audit_log (target_table, target_id);
create index on public.admin_audit_log (created_at desc);
