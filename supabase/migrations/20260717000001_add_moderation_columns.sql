-- Adds moderation-related columns to the profiles table.
-- Required before the ban/suspend/admin_notes routes in polaris-api will work.
-- Safe to run — all columns are nullable with no breaking defaults.

alter table public.profiles
  add column if not exists is_banned         boolean      default false,
  add column if not exists ban_reason        text,
  add column if not exists banned_at         timestamptz,
  add column if not exists suspended_until   timestamptz,
  add column if not exists suspension_reason text,
  add column if not exists admin_notes       text;

-- Index for fast banned/suspended lookups in the user list
create index if not exists profiles_is_banned_idx       on public.profiles (is_banned)       where is_banned = true;
create index if not exists profiles_suspended_until_idx on public.profiles (suspended_until) where suspended_until is not null;
