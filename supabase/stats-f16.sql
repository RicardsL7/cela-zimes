-- Ceļa Zīmes — statistika (labojums F16): īpašnieka statistika un „Mana statistika”.
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run.
-- Jāpalaiž PĒC visiem pārējiem failiem (rides*.sql, reports.sql, radars.sql, traffic*.sql). Var palaist atkārtoti.
--
-- KĀ SEVI PADARĪT PAR ĪPAŠNIEKU (vienreiz, SQL Editor, ar SAVU e-pastu — repozitorijā to neieraksti):
--   insert into public.app_admins select id from auth.users where email = '[TAVS E-PASTS]' on conflict do nothing;
-- Pārbaude:  select * from public.app_admins;
--
-- Kas tiek glabāts:
--   • app_admins — kuri konti redz īpašnieka statistiku. Tieši lasīt / rakstīt nevar neviens (tikai SQL Editor).
--   • stat_daily — dienas kopsummas (diena, veids, skaitlis): ceļa ziņojumi pēc veida, apstiprinājumi, jauni radari,
--     sastrēgumu mērījumi. Bez lietotāju ID un bez vietām. Vajag, jo ziņojumi un mērījumi pēc laika tiek dzēsti.
--   • user_stat_counters — lietotāja darbību SKAITS (ziņojumi, apstiprinājumi, mērījumi, radari). Bez vietām un laikiem;
--     dzēsts kopā ar kontu, pārcelts konta apvienošanā.
--   • Skaitītāji sāk skaitīt no šī faila palaišanas dienas (stat_meta 'since') — agrākas vēstures tajos nav.
-- Esošās funkcijas report_create, report_vote, radar_report, traffic_report pārrakstītas tikai ar skaitītāju
-- palielināšanu — pārbaudes, limiti un pārējā loģika nav mainīti.

-- ---------- Tabulas ----------
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users on delete cascade
);
alter table public.app_admins enable row level security;            -- bez politikām: tikai SQL Editor / funkcijas

create table if not exists public.stat_daily (
  day  date   not null,
  kind text   not null check (char_length(kind) between 1 and 60),
  n    bigint not null default 0,
  primary key (day, kind)
);
alter table public.stat_daily enable row level security;            -- bez politikām

create table if not exists public.user_stat_counters (
  user_id uuid   not null references auth.users on delete cascade,
  kind    text   not null check (kind in ('reports', 'confirms', 'confirmed', 'traffic', 'radars')),
  n       bigint not null default 0,
  primary key (user_id, kind)
);
alter table public.user_stat_counters enable row level security;    -- bez politikām: lasa tikai my_stats()

create table if not exists public.stat_meta (
  key   text primary key,
  value text not null
);
alter table public.stat_meta enable row level security;             -- bez politikām
insert into public.stat_meta (key, value) values ('since', to_char((now() at time zone 'Europe/Riga')::date, 'YYYY-MM-DD'))
  on conflict (key) do nothing;

-- ---------- Palīgfunkcijas ----------
create or replace function public.is_app_admin() returns boolean
  language sql stable security definer set search_path = public as
$$ select auth.uid() is not null and exists (select 1 from app_admins where user_id = auth.uid()) $$;

-- Dienas kopsumma (diena pēc Rīgas laika)
create or replace function public.stat_bump(p_kind text, p_n bigint default 1) returns void
  language sql security definer set search_path = public as
$$ insert into stat_daily (day, kind, n) values ((now() at time zone 'Europe/Riga')::date, p_kind, p_n)
     on conflict (day, kind) do update set n = stat_daily.n + excluded.n $$;

-- Lietotāja skaitītājs (tikai skaitlis)
create or replace function public.stat_user_bump(p_user uuid, p_kind text, p_n bigint default 1) returns void
  language sql security definer set search_path = public as
$$ insert into user_stat_counters (user_id, kind, n) select p_user, p_kind, p_n where p_user is not null and p_n > 0
     on conflict (user_id, kind) do update set n = user_stat_counters.n + excluded.n $$;

-- Īpašnieks pēc e-pasta, ja konts ar šo e-pastu vēl nav izveidots / saglabāts:
--   insert into public.app_admin_pending values ('[TAVS E-PASTS]') on conflict do nothing;
-- Kad konts ar šo e-pastu parādās UN e-pasts ir apstiprināts (saite atvērta), tas automātiski tiek pievienots app_admins.
create table if not exists public.app_admin_pending (
  email text primary key check (email = lower(email))
);
alter table public.app_admin_pending enable row level security;     -- bez politikām
create or replace function public.app_admin_from_pending() returns trigger
  language plpgsql security definer set search_path = public as
$$ begin
  if new.email is not null and new.email_confirmed_at is not null
     and exists (select 1 from app_admin_pending where email = lower(new.email)) then
    insert into app_admins (user_id) values (new.id) on conflict do nothing;
  end if;
  return new;
end $$;
revoke all on function public.app_admin_from_pending() from public, anon, authenticated;
drop trigger if exists app_admin_from_pending on auth.users;
create trigger app_admin_from_pending after insert or update of email, email_confirmed_at on auth.users
  for each row execute function public.app_admin_from_pending();
insert into public.app_admins (user_id)
  select u.id from auth.users u join public.app_admin_pending p on p.email = lower(u.email)
  where u.email_confirmed_at is not null on conflict do nothing;

revoke all on function public.stat_bump(text, bigint) from public, anon, authenticated;
revoke all on function public.stat_user_bump(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.is_app_admin() from public, anon;
grant execute on function public.is_app_admin() to authenticated;

-- ---------- Ceļa ziņojumi (reports.sql) + skaitītāji ----------
create or replace function public.report_create(p_type text, p_lat float8, p_lng float8,
                                                p_heading int default null, p_minutes int default null) returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); ttl int; h smallint; dup reports; n int; new_id uuid; exp timestamptz; prev text;
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
    if dup.user_id is distinct from me then
      select vote into prev from report_votes where report_id = dup.id and user_id = me;
      perform report_vote_apply(dup.id, me, 'still');
      if prev is distinct from 'still' then                           -- F16: jauns apstiprinājums
        perform stat_bump('report_confirm');
        perform stat_user_bump(me, 'confirms');
        perform stat_user_bump(dup.user_id, 'confirmed');
      end if;
    end if;
    return jsonb_build_object('id', dup.id, 'merged', true);
  end if;

  select count(*) into n from reports where user_id = me and created_at > now() - interval '1 hour';
  if n >= 10 then raise exception 'rate_limit'; end if;

  exp := now() + make_interval(mins => ttl);
  insert into reports (user_id, type, lat, lng, heading, expires_at)
    values (me, p_type, round(p_lat::numeric, 6), round(p_lng::numeric, 6), h, exp)
    returning id into new_id;
  perform stat_bump('report:' || p_type);                              -- F16
  perform stat_user_bump(me, 'reports');
  return jsonb_build_object('id', new_id, 'merged', false, 'expires_at', exp);
end
$$;

create or replace function public.report_vote(p_id uuid, p_vote text) returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); owner uuid; n int; prev text; res jsonb;
begin
  if me is null then raise exception 'no_auth'; end if;
  if p_vote is null or p_vote not in ('still', 'gone') then raise exception 'bad_vote'; end if;
  select user_id into owner from reports where id = p_id;
  if not found then raise exception 'not_found'; end if;
  if owner = me then raise exception 'own_report'; end if;
  select count(*) into n from report_votes where user_id = me and created_at > now() - interval '1 hour';
  if n >= 60 then raise exception 'vote_limit'; end if;
  select vote into prev from report_votes where report_id = p_id and user_id = me;
  res := report_vote_apply(p_id, me, p_vote);
  if p_vote = 'still' and prev is distinct from 'still' then            -- F16: jauns apstiprinājums (ne atkārtots)
    perform stat_bump('report_confirm');
    perform stat_user_bump(me, 'confirms');
    perform stat_user_bump(owner, 'confirmed');
  end if;
  return res;
end
$$;

-- ---------- Radari (radars.sql) + skaitītāji ----------
create or replace function public.radar_report(items jsonb)
returns int language plpgsql security definer set search_path = public as
$$
declare n int; k int;
begin
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 or jsonb_array_length(items) > 30 then
    raise exception 'nederīgi dati';
  end if;
  if (select count(*) from radar_signs) > 50000 then return 0; end if;   -- drošības griesti
  with ins as (
    insert into radar_signs as r (mly_id, value, lat, lng)
    select x->>'id', x->>'v', (x->>'lat')::float8, (x->>'lng')::float8
    from jsonb_array_elements(items) x
    where (x->>'id') ~ '^[0-9]{6,20}$'
      and (x->>'v') ~ '^[a-z0-9-]+--[a-z0-9-]+--g[0-9]+$' and (x->>'v') ~ '(camera|photo-enforced|speed-enforcement)'
      and (x->>'lat') ~ '^[0-9.]{1,12}$' and (x->>'lng') ~ '^[0-9.]{1,12}$'
      and (x->>'lat')::float8 between 55.6 and 58.1 and (x->>'lng')::float8 between 20.9 and 28.3
    on conflict (mly_id) do update set good = least(r.good + 1, 1000000), last_seen = now()
    returning (xmax = 0) as fresh)
  select count(*), count(*) filter (where fresh) into n, k from ins;
  if k > 0 then                                                         -- F16: jauni radari
    perform stat_bump('radar_new', k);
    perform stat_user_bump(auth.uid(), 'radars', k);
  end if;
  return n;
end
$$;

-- ---------- Sastrēgumu mērījumi (traffic-2-helpers.sql) + skaitītāji ----------
create or replace function public.traffic_report(items jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  u   uuid := auth.uid();
  q   public.traffic_quota;
  cnt int;
  ins int;
begin
  if u is null then raise exception 'nepieciešama pieteikšanās'; end if;
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 or jsonb_array_length(items) > 80 then
    raise exception 'nederīgi dati';
  end if;
  cnt := jsonb_array_length(items);

  select * into q from public.traffic_quota where uid = u for update;
  if not found then
    insert into public.traffic_quota (uid, window_start, n) values (u, now(), 0) returning * into q;
  end if;
  if q.window_start < now() - interval '1 hour' then q.window_start := now(); q.n := 0; end if;
  if q.n + cnt > 1500 then return 0; end if;           -- vairāk par 1500 mērījumiem stundā — neņem
  update public.traffic_quota set window_start = q.window_start, n = q.n + cnt, last_at = now() where uid = u;

  insert into public.traffic_samples (cell, dir, kmh, cls)
  select x->>'c', (x->>'d')::smallint, least(greatest((x->>'v')::real, 0), 200), coalesce((x->>'k')::smallint, 0)
  from jsonb_array_elements(items) x
  where (x->>'c') ~ '^-?[0-9]{1,7}_-?[0-9]{1,7}$'
    and (x->>'d') ~ '^[0-7]$'
    and (x->>'v') ~ '^[0-9]{1,3}(\.[0-9]+)?$'
    and coalesce(x->>'k', '0') ~ '^[0-9]$';
  get diagnostics ins = row_count;
  if ins > 0 then                                                       -- F16
    perform stat_bump('traffic_samples', ins);
    perform stat_user_bump(u, 'traffic', ins);
  end if;

  -- Vecu datu tīrīšana (ik pa laikam)
  if random() < 0.02 then
    delete from public.traffic_samples where at < now() - interval '28 days';
    delete from public.traffic_quota where window_start < now() - interval '1 day';
  end if;
  return cnt;
end $$;

revoke all on function public.report_create(text, float8, float8, int, int) from public, anon;
revoke all on function public.report_vote(uuid, text) from public, anon;
revoke all on function public.radar_report(jsonb) from public;
revoke all on function public.traffic_report(jsonb) from public, anon;
grant execute on function public.report_create(text, float8, float8, int, int) to authenticated;
grant execute on function public.report_vote(uuid, text) to authenticated;
grant execute on function public.radar_report(jsonb) to anon, authenticated;
grant execute on function public.traffic_report(jsonb) to authenticated;

-- ---------- Īpašnieka statistika ----------
-- Katrs rādītājs: [šodien, šomēnes, kopā] (Rīgas laikā). Sastrēgumu mērījumiem „kopā” = pēdējās 28 dienas (vecākie dzēsti).
create or replace function public.admin_stats() returns jsonb
  language plpgsql stable security definer set search_path = public as
$$
declare
  d0 timestamptz := date_trunc('day', now() at time zone 'Europe/Riga') at time zone 'Europe/Riga';
  m0 timestamptz := date_trunc('month', now() at time zone 'Europe/Riga') at time zone 'Europe/Riga';
  dd date := (now() at time zone 'Europe/Riga')::date;
  md date := date_trunc('month', now() at time zone 'Europe/Riga')::date;
  res jsonb;
begin
  if not is_app_admin() then raise exception 'forbidden'; end if;
  select jsonb_build_object(
    'since', (select value from stat_meta where key = 'since'),
    'users', (select jsonb_build_object(
        'new',      jsonb_build_array(count(*) filter (where created_at >= d0), count(*) filter (where created_at >= m0), count(*)),
        'active',   jsonb_build_array(count(*) filter (where last_sign_in_at >= d0), count(*) filter (where last_sign_in_at >= m0), count(*) filter (where last_sign_in_at is not null)),
        'saved',    jsonb_build_array(count(*) filter (where not coalesce(is_anonymous, false) and created_at >= d0),
                                      count(*) filter (where not coalesce(is_anonymous, false) and created_at >= m0),
                                      count(*) filter (where not coalesce(is_anonymous, false))),
        'anon',     jsonb_build_array(count(*) filter (where coalesce(is_anonymous, false) and created_at >= d0),
                                      count(*) filter (where coalesce(is_anonymous, false) and created_at >= m0),
                                      count(*) filter (where coalesce(is_anonymous, false))))
      from auth.users),
    'profiles', (select jsonb_build_array(count(*) filter (where created_at >= d0), count(*) filter (where created_at >= m0), count(*)) from profiles),
    'requests', (select jsonb_build_array(count(*) filter (where created_at >= d0), count(*) filter (where created_at >= m0), count(*)) from ride_requests),
    'done',     (select jsonb_build_array(count(*) filter (where r.depart_at >= d0), count(*) filter (where r.depart_at >= m0), count(*))
                   from ride_offers o join ride_requests r on r.id = o.request_id where o.status = 'accepted' and o.trip = 'done'),
    'cancelled',(select jsonb_build_array(count(*) filter (where depart_at >= d0), count(*) filter (where depart_at >= m0), count(*))
                   from ride_requests where status = 'cancelled'),
    'paid',     (select jsonb_build_array(count(*) filter (where p.created_at >= d0), count(*) filter (where p.created_at >= m0), count(*))
                   from ride_payments p where p.status in ('paid', 'refunded')),
    'turnover', (select jsonb_build_array(coalesce(sum(o.price_cents) filter (where p.created_at >= d0), 0),
                                          coalesce(sum(o.price_cents) filter (where p.created_at >= m0), 0), coalesce(sum(o.price_cents), 0))
                   from ride_payments p join ride_offers o on o.id = p.offer_id where p.status in ('paid', 'refunded')),
    'refunds',  (select jsonb_build_array(coalesce(sum(refund_cents) filter (where refunded_at >= d0), 0),
                                          coalesce(sum(refund_cents) filter (where refunded_at >= m0), 0), coalesce(sum(refund_cents), 0))
                   from ride_payments where status = 'refunded'),
    'reports',  coalesce((select jsonb_object_agg(t, jsonb_build_array(a, b, c)) from (
                   select substr(kind, 8) as t, sum(n) filter (where day >= dd) as a, sum(n) filter (where day >= md) as b, sum(n) as c
                   from stat_daily where kind like 'report:%' group by kind) x), '{}'::jsonb),
    'reports_active', coalesce((select jsonb_object_agg(type, c) from (
                   select type, count(*) as c from reports where not hidden and expires_at > now() group by type) x), '{}'::jsonb),
    'confirms', (select jsonb_build_array(coalesce(sum(n) filter (where day >= dd), 0), coalesce(sum(n) filter (where day >= md), 0), coalesce(sum(n), 0))
                   from stat_daily where kind = 'report_confirm'),
    'radars',   (select jsonb_build_object(
                   'new', jsonb_build_array(count(*) filter (where first_seen >= d0), count(*) filter (where first_seen >= m0), count(*)),
                   'invalid', count(*) filter (where bad > good)) from radar_signs),
    'traffic',  (select jsonb_build_array(count(*) filter (where at >= d0), count(*) filter (where at >= m0), count(*))
                   from traffic_samples where at > now() - interval '28 days'),
    'helpers',  traffic_helpers()
  ) into res;
  return res;
end
$$;

-- ---------- „Mana statistika” (tikai pieteikušā lietotāja dati) ----------
create or replace function public.my_stats() returns jsonb
  language plpgsql stable security definer set search_path = public as
$$
declare me uuid := auth.uid(); res jsonb;
begin
  if me is null then return null; end if;
  with x as (
    select case when o.driver_id = me then 'driver' else 'passenger' end as role,
           (o.status = 'accepted' and o.trip = 'done') as done, r.seats, o.price_cents, p.status as pay,
           report_dist_m(r.from_lat, r.from_lng, r.to_lat, r.to_lng) as dist
    from ride_offers o join ride_requests r on r.id = o.request_id
      left join ride_payments p on p.offer_id = o.id
    where o.was_accepted and (o.driver_id = me or r.user_id = me)
      and (r.status in ('done', 'cancelled') or o.status = 'cancelled' or (o.status = 'accepted' and o.trip = 'done'))
  )
  select jsonb_build_object(
    'driver_done',       count(*) filter (where role = 'driver' and done),
    'driver_cancelled',  count(*) filter (where role = 'driver' and not done),
    'passenger_done',    count(*) filter (where role = 'passenger' and done),
    'passenger_cancelled', count(*) filter (where role = 'passenger' and not done),
    'carried',           coalesce(sum(seats) filter (where role = 'driver' and done), 0),
    'km_approx',         round(coalesce(sum(dist) filter (where done), 0) * 1.3 / 1000),
    'earned_card_cents', coalesce(sum(price_cents) filter (where role = 'driver' and done and pay = 'paid'), 0),
    'paid_card_cents',   coalesce(sum(price_cents) filter (where role = 'passenger' and done and pay = 'paid'), 0)
  ) into res from x;
  return res || jsonb_build_object(
    'reports',   coalesce((select n from user_stat_counters where user_id = me and kind = 'reports'), 0),
    'confirms',  coalesce((select n from user_stat_counters where user_id = me and kind = 'confirms'), 0),
    'confirmed', coalesce((select n from user_stat_counters where user_id = me and kind = 'confirmed'), 0),
    'traffic',   coalesce((select n from user_stat_counters where user_id = me and kind = 'traffic'), 0),
    'radars',    coalesce((select n from user_stat_counters where user_id = me and kind = 'radars'), 0),
    'rating',    (select jsonb_build_object('avg', s.avg, 'count', s.count, 'rides', s.rides) from rating_summary(array[me]) s),
    'since',     (select value from stat_meta where key = 'since'));
end
$$;

-- ---------- Admin lapa (admin.html): ziņojumi par lietotājiem („Ziņot par problēmu”) ----------
create or replace function public.admin_user_reports(lim int default 100)
  returns table (id bigint, created_at timestamptz, reason text, details text, status text,
                 reporter_name text, reported_name text, offer_id uuid, reported_reports bigint)
  language plpgsql stable security definer set search_path = public as
$$
begin
  if not is_app_admin() then raise exception 'forbidden'; end if;
  return query
    select u.id, u.created_at, u.reason, u.details, u.status,
           (select name from profiles where profiles.id = u.reporter_id),
           (select name from profiles where profiles.id = u.reported_id),
           u.offer_id,
           (select count(*) from user_reports x where x.reported_id = u.reported_id and u.reported_id is not null)
    from user_reports u
    order by (u.status = 'new') desc, u.created_at desc
    limit greatest(1, least(coalesce(lim, 100), 500));
end
$$;
create or replace function public.admin_user_report_set(p_id bigint, p_status text) returns boolean
  language plpgsql security definer set search_path = public as
$$
begin
  if not is_app_admin() then raise exception 'forbidden'; end if;
  if p_status not in ('new', 'reviewed', 'closed') then raise exception 'bad_status'; end if;
  update user_reports set status = p_status where id = p_id;
  return found;
end
$$;
revoke all on function public.admin_user_reports(int) from public, anon;
revoke all on function public.admin_user_report_set(bigint, text) from public, anon;
grant execute on function public.admin_user_reports(int) to authenticated;
grant execute on function public.admin_user_report_set(bigint, text) to authenticated;

revoke all on function public.admin_stats() from public, anon;
revoke all on function public.my_stats() from public, anon;
grant execute on function public.admin_stats() to authenticated;
grant execute on function public.my_stats() to authenticated;

-- ---------- Kontu apvienošana un dzēšana (F1): arī statistikas skaitītāji ----------
-- Tās pašas funkcijas kā rides-9-ratings.sql, papildinātas ar user_stat_counters.
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
    -- F13: vērtējumi (dots un saņemtie). Ja abi konti novērtējuši vienu braucienu — paliek jaunā konta vērtējums.
    delete from ride_ratings t where t.rater_id = src
      and exists (select 1 from ride_ratings x where x.offer_id = t.offer_id and x.rater_id = me);
    update ride_ratings set rater_id = me where rater_id = src;
    update ride_ratings set rated_id = me where rated_id = src;
    delete from ride_ratings where rater_id = rated_id;            -- abi konti bija viena brauciena puses
  end if;

  -- F16: lietotāja statistikas skaitītāji (tikai skaitļi) — saskaita
  insert into user_stat_counters (user_id, kind, n) select me, kind, n from user_stat_counters where user_id = src
    on conflict (user_id, kind) do update set n = user_stat_counters.n + excluded.n;
  delete from user_stat_counters where user_id = src;

  -- F13: ziņojumi par lietotājiem
  update user_reports set reporter_id = me where reporter_id = src;
  update user_reports set reported_id = me where reported_id = src;

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

create or replace function public.delete_my_account(p_unclosed_acct text default null) returns boolean
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Nav pieteicies'; end if;
  if p_unclosed_acct is not null and exists (select 1 from driver_accounts where user_id = me and acct = p_unclosed_acct) then
    insert into account_closures (acct) values (p_unclosed_acct) on conflict do nothing;
  end if;
  delete from ride_ratings where rater_id = me or rated_id = me;
  delete from user_stat_counters where user_id = me;                -- F16
  delete from user_reports where reporter_id = me;
  update user_reports set reported_id = null where reported_id = me;
  delete from traffic_quota where uid = me;
  delete from account_transfers where from_user = me;
  delete from auth.users where id = me;
  return true;
end
$$;

revoke all on function public.account_transfer_claim(text) from public, anon;
revoke all on function public.delete_my_account(text) from public, anon;
grant execute on function public.account_transfer_claim(text) to authenticated;
grant execute on function public.delete_my_account(text) to authenticated;
