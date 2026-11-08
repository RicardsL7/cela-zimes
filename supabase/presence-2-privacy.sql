-- Ceļa Zīmes — citu braucēju punkti kartē: atsevišķa izvēle, rupjāka vieta, redz tikai braucot (audits A16, 08.11.2026).
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Var palaist atkārtoti (kamēr nav jaunāku).
-- Palaist PĒC account-1-delete.sql (secība — supabase/ORDER.txt, Nr. 29).
--
-- Problēma (coins-2-presence.sql): braucēja punkts (~20 m, ik 20 s, virziens, Garāžas tēls) bija redzams JEBKURAM —
-- arī bez konta — 55 × 60 km laukumā, un rādīšana ieslēdzās kopā ar ātruma dalīšanu. Ar biežu nolasīšanu punktus var
-- savienot ceļā un atrast, kur cilvēks dzīvo vai strādā.
--
-- Labojums (īpašnieka lēmums 08.11.2026):
--   1) Atsevišķa izvēle „Rādīt mani citu kartē” (piekrišana user_consents, kind = 'show_on_map', versija ≥ 2026-11-08),
--      noklusēti izslēgta. Ātruma dalīšana to vairs neieslēdz. Līdzšinējie punkti tiek dzēsti uzreiz.
--   2) Rupjāka vieta: ~150 m (platums 1/700°, garums 1/400°); punkts parādās tikai pēc ≥ 60 s nepārtrauktas braukšanas
--      (brauciena sākums netiek rādīts); atjaunojas ne biežāk kā ik 25 s; apstājoties (< 15 km/h) — dzēsts uzreiz.
--   3) Redz tikai pieteicies lietotājs, kurš pats tagad brauc (≥ 15 km/h), tikai ≤ 15 km ap savu vietu:
--      presence_nearby(mana vieta, ātrums) — ne biežāk kā ik 12 s; pirmos 60 s un līdz nobraukti ≥ 200 m — tukšs
--      („iesildās”); neiespējams lēciens (> 250 km/h) sāk no jauna. Skatītāja vieta (~50 m) glabājas tikai šai
--      pārbaudei — dzēsta, kad apstājas vai pēc 10 min (presence_viewers). Bez konta (anon) — nevar.
--   Vecā presence_nearby(laukums) tiek dzēsta — vecās lietotnes versijas citus braucējus vairs nesaņem.

do $$ begin
  if to_regprocedure('public.cz_migration_begin(integer, text)') is null then
    raise exception 'Vispirms palaid visus iepriekšējos failus līdz account-1-delete.sql (secība — supabase/ORDER.txt).';
  end if;
end $$;
select public.cz_migration_begin(29, 'presence-2-privacy.sql');

-- ---------- 1) Atsevišķa piekrišana ----------
alter table public.user_consents drop constraint if exists user_consents_kind_check;
alter table public.user_consents add constraint user_consents_kind_check
  check (kind in ('terms', 'privacy', 'speed_share', 'show_on_map'));

create or replace function public.presence_allowed(u uuid) returns boolean
  language sql stable security definer set search_path = public as
$$
  select coalesce((select accepted and version >= '2026-11-08' from user_consents
                   where user_id = u and kind = 'show_on_map' order by created_at desc, id desc limit 1), false)
$$;
revoke all on function public.presence_allowed(uuid) from public, anon, authenticated;

-- ---------- 2) Mans punkts: ~150 m, pēc 60 s braukšanas ----------
alter table public.user_presence add column if not exists started_at timestamptz not null default now();
-- Līdz šim rādītie (ar ātruma dalīšanu, ~20 m) — dzēsti; parādīsies tikai pēc jaunās izvēles
-- (atkārtoti palaižot, jau jaunajā kārtībā rādītos neaiztiek)
delete from public.user_presence p where not public.presence_allowed(p.user_id);

create or replace function public.presence_update(p_lat float8, p_lng float8, p_heading int, p_speed_kmh float8)
  returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); h smallint; cur user_presence;
begin
  if me is null then raise exception 'no_auth'; end if;
  delete from user_presence where updated_at < now() - interval '10 minutes';   -- housekeeping
  if not presence_allowed(me) or p_lat is null or p_lng is null
     or p_lat not between 55.6 and 58.1 or p_lng not between 20.9 and 28.3
     or p_speed_kmh is null or p_speed_kmh < 15 or p_speed_kmh > 220 then
    delete from user_presence where user_id = me;                               -- apstājies / nerāda → dzēš uzreiz
    return jsonb_build_object('stored', false, 'shown', false);
  end if;
  select * into cur from user_presence where user_id = me;
  if found and cur.updated_at > now() - interval '25 seconds' then              -- ne biežāk kā ik 25 s
    return jsonb_build_object('stored', true, 'shown', cur.started_at <= now() - interval '60 seconds');
  end if;
  h := case when p_heading is null then null else ((p_heading % 360) + 360) % 360 end;
  insert into user_presence as up (user_id, lat, lng, heading, skin, started_at, updated_at)
    values (me, round(p_lat::numeric * 700) / 700, round(p_lng::numeric * 400) / 400, h,
            (select equipped_skin from user_wallet where user_id = me), now(), now())
    on conflict (user_id) do update set lat = excluded.lat, lng = excluded.lng, heading = excluded.heading,
      skin = excluded.skin,
      started_at = case when up.updated_at < now() - interval '2 minutes' then now() else up.started_at end,
      updated_at = now()
    returning * into cur;
  return jsonb_build_object('stored', true, 'shown', cur.started_at <= now() - interval '60 seconds');
end
$$;

-- ---------- 3) Kas redz: tikai braucot, ≤ 15 km ap sevi ----------
create table if not exists public.presence_viewers (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  lat       double precision not null,           -- ~50 m
  lng       double precision not null,
  first_lat double precision not null,
  first_lng double precision not null,
  first_at  timestamptz not null default now(),
  last_at   timestamptz not null default now()
);
create index if not exists presence_viewers_last on public.presence_viewers (last_at);
alter table public.presence_viewers enable row level security;   -- bez politikām: lietotnei nav redzams
revoke all on public.presence_viewers from public, anon, authenticated;

drop function if exists public.presence_nearby(float8, float8, float8, float8);   -- vecā: jebkuram, laukumā

create or replace function public.presence_nearby(p_lat float8, p_lng float8, p_speed_kmh float8) returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); v presence_viewers; la float8; lo float8; dt float8; pts jsonb;
begin
  if me is null then raise exception 'no_auth'; end if;
  delete from presence_viewers where last_at < now() - interval '10 minutes';
  if p_lat is null or p_lng is null or p_lat not between 55.6 and 58.1 or p_lng not between 20.9 and 28.3
     or p_speed_kmh is null or p_speed_kmh < 15 or p_speed_kmh > 220 then
    delete from presence_viewers where user_id = me;
    return jsonb_build_object('ok', false, 'reason', 'not_moving', 'points', '[]'::jsonb);
  end if;
  la := round(p_lat::numeric * 2000) / 2000; lo := round(p_lng::numeric * 1100) / 1100;
  select * into v from presence_viewers where user_id = me for update;
  if found and v.last_at > now() - interval '12 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'throttled', 'points', '[]'::jsonb);
  end if;
  if found and v.last_at > now() - interval '2 minutes' then
    dt := greatest(1, extract(epoch from now() - v.last_at));
    if greatest(0, report_dist_m(v.lat, v.lng, la, lo) - 120) / dt * 3.6 > 250 then          -- neiespējams lēciens
      update presence_viewers set lat = la, lng = lo, first_lat = la, first_lng = lo, first_at = now(), last_at = now()
        where user_id = me;
      return jsonb_build_object('ok', false, 'reason', 'warming_up', 'points', '[]'::jsonb);
    end if;
    update presence_viewers set lat = la, lng = lo, last_at = now() where user_id = me returning * into v;
  else
    insert into presence_viewers as pv (user_id, lat, lng, first_lat, first_lng, first_at, last_at)
      values (me, la, lo, la, lo, now(), now())
      on conflict (user_id) do update set lat = la, lng = lo, first_lat = la, first_lng = lo, first_at = now(), last_at = now()
      returning * into v;
  end if;
  if v.first_at > now() - interval '60 seconds' or report_dist_m(v.first_lat, v.first_lng, la, lo) < 200 then
    return jsonb_build_object('ok', false, 'reason', 'warming_up', 'points', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('lat', x.lat, 'lng', x.lng, 'heading', x.heading, 'skin', x.skin, 'age_s', x.age_s)
                            order by x.d), '[]'::jsonb) into pts
  from (
    select p.lat, p.lng, p.heading, p.skin, (floor(extract(epoch from now() - p.updated_at) / 10) * 10)::int as age_s,
           report_dist_m(la, lo, p.lat, p.lng) as d
    from user_presence p
    where p.updated_at > now() - interval '2 minutes' and p.started_at <= now() - interval '60 seconds'
      and p.user_id <> me
      and p.lat between la - 0.14 and la + 0.14 and p.lng between lo - 0.25 and lo + 0.25
      and report_dist_m(la, lo, p.lat, p.lng) <= 15000
    order by 6 limit 50
  ) x;
  return jsonb_build_object('ok', true, 'points', pts);
end
$$;
revoke all on function public.presence_nearby(float8, float8, float8) from public, anon;
grant execute on function public.presence_nearby(float8, float8, float8) to authenticated;

-- Kad lietotājs izslēdz rādīšanu vai apstājas — arī skatītāja ieraksts prom
create or replace function public.presence_clear() returns void
  language sql security definer set search_path = public as
$$ delete from user_presence where user_id = auth.uid(); delete from presence_viewers where user_id = auth.uid(); $$;
revoke all on function public.presence_clear() from public, anon;
grant execute on function public.presence_clear() to authenticated;
revoke all on function public.presence_update(float8, float8, int, float8) from public, anon;
grant execute on function public.presence_update(float8, float8, int, float8) to authenticated;

-- ---------- 4) Regulārā tīrīšana: + skatītāju vietas (10 min) ----------
create or replace function public.cz_cleanup() returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare
  run_id bigint; d jsonb := '{}'::jsonb; errs text[] := '{}'; k int;
begin
  insert into cz_cleanup_runs default values returning id into run_id;

  begin delete from reports where expires_at < now() - interval '2 days';
        get diagnostics k = row_count; d := d || jsonb_build_object('reports', k);
  exception when others then errs := errs || ('reports: ' || sqlerrm); end;

  begin delete from traffic_samples where at < now() - interval '28 days';
        get diagnostics k = row_count; d := d || jsonb_build_object('traffic_samples', k);
  exception when others then errs := errs || ('traffic_samples: ' || sqlerrm); end;

  begin delete from traffic_quota where window_start < now() - interval '1 day';
        get diagnostics k = row_count; d := d || jsonb_build_object('traffic_quota', k);
  exception when others then errs := errs || ('traffic_quota: ' || sqlerrm); end;

  begin delete from user_presence where updated_at < now() - interval '5 minutes';
        get diagnostics k = row_count; d := d || jsonb_build_object('user_presence', k);
  exception when others then errs := errs || ('user_presence: ' || sqlerrm); end;

  begin delete from presence_viewers where last_at < now() - interval '10 minutes';            -- A16
        get diagnostics k = row_count; d := d || jsonb_build_object('presence_viewers', k);
  exception when others then errs := errs || ('presence_viewers: ' || sqlerrm); end;

  begin delete from account_transfers where expires_at < now();
        get diagnostics k = row_count; d := d || jsonb_build_object('account_transfers', k);
  exception when others then errs := errs || ('account_transfers: ' || sqlerrm); end;

  begin delete from stripe_events where created_at < now() - interval '90 days';
        get diagnostics k = row_count; d := d || jsonb_build_object('stripe_events', k);
  exception when others then errs := errs || ('stripe_events: ' || sqlerrm); end;

  begin k := ride_expire(); d := d || jsonb_build_object('rides_expired', k);
  exception when others then errs := errs || ('ride_expire: ' || sqlerrm); end;

  -- Plānotāja paša vēsture (pg_cron to netīra): 7 dienas
  begin
    if to_regclass('cron.job_run_details') is not null then
      execute 'delete from cron.job_run_details where end_time < now() - interval ''7 days''';
      get diagnostics k = row_count; d := d || jsonb_build_object('cron_history', k);
    end if;
  exception when others then errs := errs || ('cron_history: ' || sqlerrm); end;

  delete from cz_cleanup_runs where started_at < now() - interval '7 days';

  update cz_cleanup_runs
     set finished_at = clock_timestamp(), ok = cardinality(errs) = 0, deleted = d,
         errors = nullif(array_to_string(errs, E'\n'), '')
   where id = run_id;
  return jsonb_build_object('ok', cardinality(errs) = 0, 'deleted', d, 'errors', to_jsonb(errs));
end
$$;
revoke all on function public.cz_cleanup() from public, anon, authenticated;

select public.cz_migration_done(29, 'presence-2-privacy.sql');

-- PĀRBAUDE PĒC PALAIŠANAS:
--   supabase/status.sql → „VISS KĀRTĪBĀ”
--   select has_function_privilege('anon', 'public.presence_nearby(float8, float8, float8)', 'execute');   -- false
--   select count(*) from public.user_presence;                                                           -- 0 (līdz kāds ieslēdz jauno izvēli)
-- ATCELŠANA: nav ieteicama (atkal atvērtu punktus ikvienam).
