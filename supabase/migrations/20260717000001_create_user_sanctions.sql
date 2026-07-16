-- User sanctions: one row per moderation action, append-only audit trail.
-- Never update or delete rows — revoke by setting revoked_at/revoked_by.
-- Current active sanction = revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())

create table if not exists public.user_sanctions (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references public.profiles(id) on delete cascade,
  type        text        not null check (type in ('warning', 'suspension', 'ban')),
  reason      text        not null,
  issued_by   uuid        references public.admin_users(id),
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz,            -- null = permanent (used for bans)
  revoked_at  timestamptz,            -- null = still active
  revoked_by  uuid        references public.admin_users(id)
);

-- RLS: service role only (polaris-api uses service role key, bypasses this entirely)
alter table public.user_sanctions enable row level security;
create policy "service role only" on public.user_sanctions using (false);

-- Indexes for the most common admin queries
create index on public.user_sanctions (user_id);
create index on public.user_sanctions (issued_by);
create index on public.user_sanctions (type);
create index on public.user_sanctions (issued_at desc);
-- Partial index for fast "find all currently active sanctions" lookups
create index on public.user_sanctions (user_id) where revoked_at is null;
