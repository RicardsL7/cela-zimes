-- Ceļa Zīmes — radaru paziņošana un „nav radara” balsojumi tikai ar kontu, viens balss no konta (audits 2, B08 — 10.11.2026).
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Var palaist atkārtoti (kamēr nav jaunāku).
-- Palaist PĒC account-2-anon-cleanup.sql (secība — supabase/ORDER.txt, Nr. 33).
--
-- Problēma: radar_report un radar_bad varēja izsaukt bez konta (anon), bez limita, un radar_bad vienu radaru varēja
-- „nobalsot” neierobežoti — viens skripts varēja paslēpt visus radarus (radar_list slēpj, ja bad ≥ 3 un good ≤ bad × 2)
-- vai aizpildīt tabulu ar viltotiem numuriem līdz kopējiem griestiem (50 000), lai jauni radari vairs netiktu pieņemti.
--
-- Labojums (īpašnieka lēmumi 10.11.2026: konts tiek izveidots neredzami; balsis glabā 30 dienas):
--   1) radar_votes — kurš konts par kuru radaru jau balsojis („g” — redzēts, „b” — nav). Viens konts = viena balss katrā
--      virzienā. Glabā 30 dienas (tad dzēš — „cz-radar-votes” katru nakti), kontu dzēšot — uzreiz (on delete cascade).
--      Tabula nav pieejama lietotnei (RLS bez politikām, tiesības atņemtas) — tikai funkcijām zemāk.
--   2) radar_report / radar_bad — tikai pieteicies (authenticated); anon tiesības atņemtas.
--        radar_report: ≤ 120 radari stundā no konta; jaunus (vēl nebijušus) radarus — ≤ 100 diennaktī no konta,
--          kopējie griesti 50 000 paliek; good palielinās tikai par jaunu kontu (atkārtots ziņojums tikai atjauno last_seen).
--        radar_bad: ≤ 100 balsis stundā no konta; bad palielinās tikai par jaunu kontu.
--   3) radar_list — bez izmaiņām (lasīt var arī bez konta).
-- Radaru tabulā (radar_signs) joprojām nav nekādas informācijas par lietotājiem.

do $$ begin
  if to_regprocedure('public.cz_migration_begin(integer, text)') is null
     or to_regprocedure('public.account_erase(uuid)') is null then
    raise exception 'Vispirms palaid visus iepriekšējos failus līdz account-2-anon-cleanup.sql (secība — supabase/ORDER.txt).';
  end if;
end $$;
select public.cz_migration_begin(33, 'radars-2-votes.sql');

-- ---------- 1) Balsis ----------
create table if not exists public.radar_votes (
  mly_id  text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind    char(1) not null check (kind in ('g', 'b')),       -- g — radars redzēts (radar_report), b — nav (radar_bad)
  created boolean not null default false,                     -- šis ziņojums radaru pievienoja sarakstam (griesti uz kontu)
  at      timestamptz not null default now(),
  primary key (mly_id, user_id, kind)
);
create index if not exists radar_votes_user_at on public.radar_votes (user_id, at);
create index if not exists radar_votes_at on public.radar_votes (at);
alter table public.radar_votes enable row level security;    -- bez politikām: lietotne tieši neredz un neraksta
revoke all on public.radar_votes from public, anon, authenticated;

-- ---------- 2) Paziņošana (tikai ar kontu) ----------
create or replace function public.radar_report(items jsonb)
returns int language plpgsql security definer set search_path = public as
$$
declare
  me uuid := auth.uid();
  n int := 0; k int := 0;
  hour_n int; day_new int; total int;
  it record; was_new boolean; voted boolean;
begin
  if me is null then raise exception 'nepieciešama pieteikšanās'; end if;
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 or jsonb_array_length(items) > 30 then
    raise exception 'nederīgi dati';
  end if;
  perform pg_advisory_xact_lock(hashtext('cz-radar-' || me::text));          -- viena konta pieprasījumi pēc kārtas
  select count(*) filter (where kind = 'g' and at > now() - interval '1 hour'),
         count(*) filter (where created and at > now() - interval '1 day')
    into hour_n, day_new from radar_votes where user_id = me and at > now() - interval '1 day';
  if hour_n + jsonb_array_length(items) > 120 then return 0; end if;          -- par daudz stundā — neņem
  select count(*) into total from radar_signs;

  for it in
    select distinct on (x->>'id') x->>'id' as id, x->>'v' as v, (x->>'lat')::float8 as lat, (x->>'lng')::float8 as lng
    from jsonb_array_elements(items) x
    where (x->>'id') ~ '^[0-9]{6,20}$'
      and (x->>'v') ~ '^[a-z0-9-]+--[a-z0-9-]+--g[0-9]+$' and (x->>'v') ~ '(camera|photo-enforced|speed-enforcement)'
      and (x->>'lat') ~ '^[0-9.]{1,12}$' and (x->>'lng') ~ '^[0-9.]{1,12}$'
      and (x->>'lat')::float8 between 55.6 and 58.1 and (x->>'lng')::float8 between 20.9 and 28.3
  loop
    voted := exists (select 1 from radar_votes where mly_id = it.id and user_id = me and kind = 'g');
    if exists (select 1 from radar_signs where mly_id = it.id) then
      update radar_signs set last_seen = now(), good = case when voted then good else least(good + 1, 1000000) end
       where mly_id = it.id;
      was_new := false;
    elsif day_new < 100 and total < 50000 then                               -- jauni — ar griestiem uz kontu un kopā
      insert into radar_signs (mly_id, value, lat, lng) values (it.id, it.v, it.lat, it.lng) on conflict (mly_id) do nothing;
      if not found then continue; end if;                                      -- vienlaikus pievienoja cits
      was_new := true; day_new := day_new + 1; total := total + 1; k := k + 1;
    else
      continue;
    end if;
    insert into radar_votes (mly_id, user_id, kind, created) values (it.id, me, 'g', was_new)
      on conflict (mly_id, user_id, kind) do update set at = now();
    n := n + 1;
  end loop;

  if k > 0 then                                                               -- F16: jauni radari
    perform stat_bump('radar_new', k);
    perform stat_user_bump(me, 'radars', k);
  end if;
  return n;
end
$$;

-- ---------- 3) „Nav radara” (tikai ar kontu, viena balss no konta) ----------
create or replace function public.radar_bad(ids text[])
returns int language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); n int := 0; hour_n int; id text;
begin
  if me is null then raise exception 'nepieciešama pieteikšanās'; end if;
  if array_length(ids, 1) is null or array_length(ids, 1) > 50 then return 0; end if;
  perform pg_advisory_xact_lock(hashtext('cz-radar-' || me::text));
  select count(*) into hour_n from radar_votes where user_id = me and kind = 'b' and at > now() - interval '1 hour';
  for id in select distinct x from unnest(ids) x where x ~ '^[0-9]{6,20}$' loop
    exit when hour_n >= 100;                                                   -- ≤ 100 balsis stundā
    if not exists (select 1 from radar_signs where mly_id = id) then continue; end if;
    insert into radar_votes (mly_id, user_id, kind) values (id, me, 'b') on conflict do nothing;
    if found then
      update radar_signs set bad = least(bad + 1, 1000000) where mly_id = id;
      n := n + 1; hour_n := hour_n + 1;
    end if;
  end loop;
  return n;
end
$$;

revoke all on function public.radar_report(jsonb) from public, anon;
revoke all on function public.radar_bad(text[]) from public, anon;
grant execute on function public.radar_report(jsonb) to authenticated;
grant execute on function public.radar_bad(text[]) to authenticated;

-- ---------- 4) Balsis glabā 30 dienas ----------
create or replace function public.cz_radar_votes_cleanup() returns int
  language plpgsql security definer set search_path = public as
$$
declare n int;
begin
  delete from radar_votes where at < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function public.cz_radar_votes_cleanup() from public, anon, authenticated;
select cron.schedule('cz-radar-votes', '37 2 * * *', 'select public.cz_radar_votes_cleanup()');

select public.cz_migration_done(33, 'radars-2-votes.sql');

-- PĀRBAUDE PĒC PALAIŠANAS:
--   supabase/status.sql → „VISS KĀRTĪBĀ”
--   select jobname, schedule, active from cron.job where jobname = 'cz-radar-votes';                 -- 37 2 * * *, true
--   select has_function_privilege('anon', 'public.radar_bad(text[])', 'execute');                   -- false
-- ATCELŠANA: nav ieteicama (atkal atvērtu radaru sabojāšanu bez konta).
