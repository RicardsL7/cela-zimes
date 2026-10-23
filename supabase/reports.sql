-- Ceļa Zīmes — kopīgi ziņojumi uz ceļa (policija, negadījums, kamera u.c.), labojums F10.
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run.
-- Failu var palaist atkārtoti (dati netiek dzēsti). Jāpalaiž PĒC rides-7-account.sql.
--
-- Kā tas strādā:
--   • Ziņojumu izveido tikai lietotājs ar sesiju (arī anonīms konts) — caur report_create.
--   • Ziņojumus apgabalā var lasīt ikviens, arī bez konta — caur report_list. Kas ziņoja, netiek atklāts
--     (user_id netiek atdots), tikai pazīme „mine” — vai tas ir paša lietotāja ziņojums.
--   • Citi var apstiprināt „vēl ir” (pagarina derīgumu, bet ne vairāk kā līdz 2× sākotnējam ilgumam)
--     vai „vairs nav” (pēc 2 dažādu lietotāju „vairs nav” ziņojums pazūd visiem). Par savu balsot nevar,
--     savu var dzēst.
--   • Viltojumu ierobežošana: līdz 10 jauniem ziņojumiem stundā uz kontu, līdz 60 balsojumiem stundā,
--     tikai Latvijas robežās, viens balsojums uz lietotāju, dublikāti 150 m attālumā tiek apvienoti.
--   • Tabulas tieši lasīt / rakstīt nevar (RLS bez politikām) — tikai caur funkcijām zemāk.

-- ---------- Derīgums pēc veida (minūtēs). Tiem pašiem veidiem kā pogā „Ziņot” (alerts.js) ----------
create or replace function public.report_ttl(t text) returns int
  language sql immutable set search_path = public as
$$
  select case t
    when 'police'          then 60
    when 'police-hidden'   then 60
    when 'camera-fixed'    then 43200   -- 30 dienas (stacionāra kamera)
    when 'camera-mobile'   then 120
    when 'accident'        then 120
    when 'jam'             then 30
    when 'roadworks'       then 1440    -- 24 h
    when 'closure'         then 360
    when 'lane-closed'     then 240
    when 'object'          then 60
    when 'pothole'         then 4320    -- 3 dienas
    when 'stopped-vehicle' then 60
    when 'signal-broken'   then 240
    when 'hazard'          then 120
    when 'obstacle'        then 120
    when 'weather'         then 120
    when 'fog'             then 120
    when 'flood'           then 360
    when 'ice'             then 240
    when 'snow'            then 180
    else null
  end
$$;

-- Attālums metros (pietiekami precīzi līdz dažiem km)
create or replace function public.report_dist_m(lat1 float8, lng1 float8, lat2 float8, lng2 float8) returns float8
  language sql immutable as
$$ select 111320 * sqrt(power(lat2 - lat1, 2) + power((lng2 - lng1) * cos(radians((lat1 + lat2) / 2)), 2)) $$;

-- ---------- Tabulas ----------
create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,   -- dzēšot kontu, dzēš arī tā ziņojumus
  type        text not null check (public.report_ttl(type) is not null),
  lat         double precision not null check (lat between 55.6 and 58.1),
  lng         double precision not null check (lng between 20.9 and 28.3),
  heading     smallint check (heading between 0 and 359),        -- braukšanas virziens grādos (var nebūt)
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  gone_count  int not null default 0,
  still_count int not null default 0,
  hidden      boolean not null default false                      -- „vairs nav” ×2 vai ziņotājs izdzēsa
);
create index if not exists reports_area on public.reports (lat, lng) where not hidden;
create index if not exists reports_expires on public.reports (expires_at);
create index if not exists reports_user_time on public.reports (user_id, created_at);

create table if not exists public.report_votes (
  report_id  uuid not null references public.reports(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  vote       text not null check (vote in ('still', 'gone')),
  created_at timestamptz not null default now(),
  primary key (report_id, user_id)                                 -- viens balsojums uz lietotāju
);
create index if not exists report_votes_user_time on public.report_votes (user_id, created_at);

alter table public.reports enable row level security;
alter table public.report_votes enable row level security;
-- Politiku nav: tieši lasīt / rakstīt nevar neviens (arī anon / authenticated), tikai caur funkcijām.

-- ---------- Iekšējā: balsojuma ieskaitīšana (izsauc report_create un report_vote) ----------
create or replace function public.report_vote_apply(p_id uuid, p_user uuid, p_vote text) returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare r reports; ttl int; s int; g int;
begin
  select * into r from reports where id = p_id for update;
  if not found or r.hidden or r.expires_at <= now() then raise exception 'not_found'; end if;
  insert into report_votes (report_id, user_id, vote) values (p_id, p_user, p_vote)
    on conflict (report_id, user_id) do update set vote = excluded.vote, created_at = now();
  select count(*) filter (where vote = 'still'), count(*) filter (where vote = 'gone') into s, g
    from report_votes where report_id = p_id;
  ttl := report_ttl(r.type);
  update reports set
      still_count = s,
      gone_count  = g,
      hidden      = hidden or g >= 2,
      expires_at  = case when p_vote = 'still'
                         then greatest(expires_at, least(now() + make_interval(mins => ttl),
                                                         created_at + make_interval(mins => 2 * ttl)))
                         else expires_at end
    where id = p_id
    returning * into r;
  return jsonb_build_object('id', r.id, 'still', s, 'gone', g, 'hidden', r.hidden, 'expires_at', r.expires_at);
end
$$;

-- ---------- Jauns ziņojums ----------
-- p_minutes — neobligāts īsāks derīgums (vecajiem ierīcē saglabātajiem ziņojumiem — atlikušais laiks).
-- Atgriež { id, merged }; merged = true, ja tuvumā jau bija tāds pats ziņojums (tad ieskaita „vēl ir”).
create or replace function public.report_create(p_type text, p_lat float8, p_lng float8,
                                                p_heading int default null, p_minutes int default null) returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); ttl int; h smallint; dup reports; n int; new_id uuid; exp timestamptz;
begin
  if me is null then raise exception 'no_auth'; end if;
  ttl := report_ttl(p_type);
  if ttl is null then raise exception 'bad_type'; end if;
  if p_lat is null or p_lng is null or p_lat not between 55.6 and 58.1 or p_lng not between 20.9 and 28.3 then
    raise exception 'outside_latvia';
  end if;
  h := case when p_heading is null then null else ((p_heading % 360) + 360) % 360 end;
  if p_minutes is not null then ttl := least(ttl, greatest(1, p_minutes)); end if;

  delete from reports where expires_at < now() - interval '2 days';   -- veco ierakstu uzkopšana

  -- Dublikāts: tāda paša veida aktīvs ziņojums ≤ 150 m (un ne pretējā virzienā)
  select * into dup from reports r
    where r.type = p_type and not r.hidden and r.expires_at > now()
      and r.lat between p_lat - 0.0015 and p_lat + 0.0015 and r.lng between p_lng - 0.003 and p_lng + 0.003
      and report_dist_m(r.lat, r.lng, p_lat, p_lng) <= 150
      and (r.heading is null or h is null or least(abs(r.heading - h), 360 - abs(r.heading - h)) <= 90)
    order by report_dist_m(r.lat, r.lng, p_lat, p_lng)
    limit 1;
  if found then
    if dup.user_id is distinct from me then perform report_vote_apply(dup.id, me, 'still'); end if;
    return jsonb_build_object('id', dup.id, 'merged', true);
  end if;

  select count(*) into n from reports where user_id = me and created_at > now() - interval '1 hour';
  if n >= 10 then raise exception 'rate_limit'; end if;

  exp := now() + make_interval(mins => ttl);
  insert into reports (user_id, type, lat, lng, heading, expires_at)
    values (me, p_type, round(p_lat::numeric, 6), round(p_lng::numeric, 6), h, exp)
    returning id into new_id;
  return jsonb_build_object('id', new_id, 'merged', false, 'expires_at', exp);
end
$$;

-- ---------- Aktīvie ziņojumi apgabalā (arī bez konta) ----------
create or replace function public.report_list(min_lat float8, min_lng float8, max_lat float8, max_lng float8)
returns table (id uuid, type text, lat double precision, lng double precision, heading smallint,
               created_at timestamptz, expires_at timestamptz, still_count int, mine boolean, my_vote text)
  language sql stable security definer set search_path = public as
$$
  select r.id, r.type, r.lat, r.lng, r.heading, r.created_at, r.expires_at, r.still_count,
         coalesce(r.user_id = auth.uid(), false) as mine,
         (select v.vote from report_votes v where v.report_id = r.id and v.user_id = auth.uid()) as my_vote
  from reports r
  where not r.hidden and r.expires_at > now()
    and r.lat between least(min_lat, max_lat) and greatest(min_lat, max_lat)
    and r.lng between least(min_lng, max_lng) and greatest(min_lng, max_lng)
    and abs(max_lat - min_lat) <= 3 and abs(max_lng - min_lng) <= 8      -- ne lielāks par Latviju
  order by r.created_at desc
  limit 500
$$;

-- ---------- „Vēl ir” / „Vairs nav” ----------
create or replace function public.report_vote(p_id uuid, p_vote text) returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); owner uuid; n int;
begin
  if me is null then raise exception 'no_auth'; end if;
  if p_vote is null or p_vote not in ('still', 'gone') then raise exception 'bad_vote'; end if;
  select user_id into owner from reports where id = p_id;
  if not found then raise exception 'not_found'; end if;
  if owner = me then raise exception 'own_report'; end if;
  select count(*) into n from report_votes where user_id = me and created_at > now() - interval '1 hour';
  if n >= 60 then raise exception 'vote_limit'; end if;
  return report_vote_apply(p_id, me, p_vote);
end
$$;

-- ---------- Ziņotājs izdzēš savu ziņojumu ----------
create or replace function public.report_delete(p_id uuid) returns boolean
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'no_auth'; end if;
  update reports set hidden = true where id = p_id and user_id = me;   -- paliek limita skaitīšanai, vēlāk uzkopj
  if not found then raise exception 'not_found'; end if;
  return true;
end
$$;

-- ---------- Tiesības ----------
revoke all on function public.report_ttl(text) from public, anon, authenticated;
revoke all on function public.report_dist_m(float8, float8, float8, float8) from public, anon, authenticated;
revoke all on function public.report_vote_apply(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.report_create(text, float8, float8, int, int) from public, anon;
revoke all on function public.report_list(float8, float8, float8, float8) from public;
revoke all on function public.report_vote(uuid, text) from public, anon;
revoke all on function public.report_delete(uuid) from public, anon;
grant execute on function public.report_list(float8, float8, float8, float8) to anon, authenticated;
grant execute on function public.report_create(text, float8, float8, int, int) to authenticated;
grant execute on function public.report_vote(uuid, text) to authenticated;
grant execute on function public.report_delete(uuid) to authenticated;

-- ---------- Kontu apvienošana (F1): pārceļ arī ziņojumus un balsojumus ----------
-- Šī ir tā pati funkcija kā rides-7-account.sql, papildināta ar ziņojumu pārcelšanu.
create or replace function public.account_transfer_claim(code text) returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); src uuid; n_req int := 0; n_off int := 0; n_msg int := 0; stripe_note text := null;
begin
  if me is null then raise exception 'Nav pieteicies'; end if;
  select from_user into src from account_transfers
    where code_hash = encode(sha256(convert_to(coalesce(code, ''), 'UTF8')), 'hex') and expires_at > now();
  if src is null then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  delete from account_transfers where from_user = src;
  if src = me then return jsonb_build_object('ok', true, 'same', true); end if;
  if not coalesce((select is_anonymous from auth.users where id = src), false) then
    return jsonb_build_object('ok', false, 'reason', 'not_anonymous');
  end if;

  -- Profils: ja jaunajam kontam profila nav, pārņem anonīmā konta vārdu, auto un tālruni
  if not exists (select 1 from profiles where id = me) and exists (select 1 from profiles where id = src) then
    insert into profiles (id, name, car) select me, name, car from profiles where id = src;
    insert into contacts (id, phone) select me, phone from contacts where id = src on conflict (id) do nothing;
  end if;

  if exists (select 1 from profiles where id = src) then
    update ride_requests set user_id = me where user_id = src;
    get diagnostics n_req = row_count;
    -- Ja abi konti piedāvājuši vienu un to pašu braucienu — anonīmā konta piedāvājumu atceļ (aktīvs drīkst būt viens)
    update ride_offers o set status = 'cancelled'
      where o.driver_id = src and o.status <> 'cancelled'
        and exists (select 1 from ride_offers x where x.request_id = o.request_id and x.driver_id = me and x.status <> 'cancelled');
    update ride_offers set driver_id = me where driver_id = src;
    get diagnostics n_off = row_count;
    update ride_messages set sender = me where sender = src;
    get diagnostics n_msg = row_count;
    if exists (select 1 from driver_accounts where user_id = src) then
      if not exists (select 1 from driver_accounts where user_id = me) then
        update driver_accounts set user_id = me where user_id = src;
        stripe_note := 'moved';
      else
        insert into account_closures (acct) select acct from driver_accounts where user_id = src on conflict do nothing;
        stripe_note := 'duplicate';
      end if;
    end if;
  end if;

  -- Ziņojumi uz ceļa (reports.sql): pārceļ ziņojumus; balsojumus — ja tie nedublējas un nav par paša ziņojumu
  if to_regclass('public.reports') is not null then
    update reports set user_id = me where user_id = src;
    delete from report_votes v where v.user_id = src
      and (exists (select 1 from report_votes x where x.report_id = v.report_id and x.user_id = me)
           or exists (select 1 from reports r where r.id = v.report_id and r.user_id = me));
    update report_votes set user_id = me where user_id = src;
  end if;

  update user_consents set user_id = me where user_id = src;
  insert into account_aliases (old_user, new_user) values (src, me)
    on conflict (old_user) do update set new_user = excluded.new_user;
  delete from auth.users where id = src;            -- atlikušais (anonīmais profils) tiek dzēsts kaskādē
  return jsonb_build_object('ok', true, 'requests', n_req, 'offers', n_off, 'messages', n_msg, 'stripe', stripe_note);
end
$$;
revoke all on function public.account_transfer_claim(text) from public, anon;
grant execute on function public.account_transfer_claim(text) to authenticated;
