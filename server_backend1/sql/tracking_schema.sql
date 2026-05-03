create extension if not exists pgcrypto;

create table if not exists public.tracking_locations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id text null,
  device_name text null,
  latitude double precision not null,
  longitude double precision not null,
  timestamp timestamptz not null,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists tracking_locations_user_id_idx
  on public.tracking_locations (user_id);

create index if not exists tracking_locations_user_id_timestamp_idx
  on public.tracking_locations (user_id, timestamp desc);

create or replace view public.tracking_latest_locations as
select distinct on (user_id)
  id,
  user_id,
  device_id,
  device_name,
  latitude,
  longitude,
  timestamp,
  created_at
from public.tracking_locations
order by user_id, timestamp desc, created_at desc;

alter table public.tracking_locations enable row level security;

drop policy if exists "tracking_locations_select_own" on public.tracking_locations;
create policy "tracking_locations_select_own"
  on public.tracking_locations
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "tracking_locations_insert_own" on public.tracking_locations;
create policy "tracking_locations_insert_own"
  on public.tracking_locations
  for insert
  to authenticated
  with check (auth.uid() = user_id);
