-- Ceļa Zīmes — other drivers on the map with their skin ("Garāža").
--
-- HOW TO RUN: Supabase → SQL Editor → New query → paste this whole file → Run. Run AFTER coins-1.sql.
-- Safe to re-run.
--
-- Privacy (owner decision 01.11.2026, option A): a driver is shown to others ONLY if they turned on
-- "Palīdzēt citiem" (speed sharing) and accepted its current version (2026-11-01, which mentions this).
--   • Only while moving (≥ 15 km/h); stopping removes the point at once (no parking / home spots).
--   • Position rounded to ~20 m, plus heading and the equipped skin. No name, no account id is returned.
--   • A point disappears after 2 minutes without an update; rows older than 10 minutes are deleted.

create table if not exists public.user_presence (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  lat        double precision not null,
  lng        double precision not null,
  heading    smallint check (heading between 0 and 359),
  skin       text references public.skins(id),
  updated_at timestamptz not null default now()
);
create index if not exists user_presence_area on public.user_presence (lat, lng);
alter table public.user_presence enable row level security;

-- Is the user currently sharing (latest speed_share consent accepted, version 2026-11-01 or newer)?
create or replace function public.presence_allowed(u uuid) returns boolean
  language sql stable security definer set search_path = public as
$$
  select coalesce((select accepted and version >= '2026-11-01' from user_consents
                   where user_id = u and kind = 'speed_share' order by created_at desc limit 1), false)
$$;

-- Report my position while driving. Returns {shown: true|false}.
create or replace function public.presence_update(p_lat float8, p_lng float8, p_heading int, p_speed_kmh float8)
  returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); h smallint;
begin
  if me is null then raise exception 'no_auth'; end if;
  delete from user_presence where updated_at < now() - interval '10 minutes';   -- housekeeping
  if not presence_allowed(me) or p_lat is null or p_lng is null
     or p_lat not between 55.6 and 58.1 or p_lng not between 20.9 and 28.3
     or p_speed_kmh is null or p_speed_kmh < 15 or p_speed_kmh > 220 then
    delete from user_presence where user_id = me;                               -- stopped / not sharing → hide at once
    return jsonb_build_object('shown', false);
  end if;
  h := case when p_heading is null then null else ((p_heading % 360) + 360) % 360 end;
  insert into user_presence (user_id, lat, lng, heading, skin, updated_at)
    values (me, round(p_lat::numeric * 5000) / 5000, round(p_lng::numeric * 3000) / 3000, h,
            (select equipped_skin from user_wallet where user_id = me), now())
    on conflict (user_id) do update set lat = excluded.lat, lng = excluded.lng, heading = excluded.heading,
      skin = excluded.skin, updated_at = now();
  return jsonb_build_object('shown', true);
end
$$;

-- Stop showing me (sharing turned off, navigation ended, app closed).
create or replace function public.presence_clear() returns void
  language sql security definer set search_path = public as
$$ delete from user_presence where user_id = auth.uid() $$;

-- Other drivers in a small area (≤ 0.5° × 1°), updated in the last 2 minutes. No ids are returned.
create or replace function public.presence_nearby(min_lat float8, min_lng float8, max_lat float8, max_lng float8)
returns table (lat double precision, lng double precision, heading smallint, skin text, age_s int)
  language sql stable security definer set search_path = public as
$$
  select p.lat, p.lng, p.heading, p.skin, extract(epoch from now() - p.updated_at)::int
  from user_presence p
  where p.updated_at > now() - interval '2 minutes'
    and p.user_id is distinct from auth.uid()
    and p.lat between least(min_lat, max_lat) and greatest(min_lat, max_lat)
    and p.lng between least(min_lng, max_lng) and greatest(min_lng, max_lng)
    and abs(max_lat - min_lat) <= 0.5 and abs(max_lng - min_lng) <= 1
  limit 100
$$;

revoke all on function public.presence_allowed(uuid) from public, anon, authenticated;
revoke all on function public.presence_update(float8, float8, int, float8) from public, anon;
revoke all on function public.presence_clear() from public, anon;
revoke all on function public.presence_nearby(float8, float8, float8, float8) from public;
grant execute on function public.presence_update(float8, float8, int, float8) to authenticated;
grant execute on function public.presence_clear() to authenticated;
grant execute on function public.presence_nearby(float8, float8, float8, float8) to anon, authenticated;
