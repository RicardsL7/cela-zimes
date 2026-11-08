-- Ceļa Zīmes — community road reports with confirmations, coins and the "Garāža" skin shop.
--
-- HOW TO RUN: Supabase → SQL Editor → New query → paste this whole file → Run.
-- Safe to re-run (tikai kamēr nav palaisti jaunāki faili — A09) (no data is deleted). Must run AFTER reports.sql, stats-f16.sql and rides-9-ratings.sql.
--
-- Overview
--   • report_types   — per-type config (label, lifetime, question, reward …). Adding a type = one row here
--                      (+ its icon/label in the client config, alerts.js REPORT_TYPE_CONFIG).
--   • reports        — existing table, extended with confidence, NO streak and "needs YES before shown widely".
--   • report_votes   — existing table (= confirmations), extended with the GPS evidence and coins paid.
--   • user_wallet    — coin balance, trust score, coins earned today, equipped skin, last verified position.
--   • coin_ledger    — every coin movement (answers, author bonuses, purchases) for auditing.
--   • skins / user_skins — the shop catalogue and what each user owns.
--
-- Security: all tables have RLS enabled with NO policies — clients can only use the functions below.
-- Every coin award is decided here, on the server, from the evidence the client sends (position, speed,
-- heading, accuracy) plus server-side history (one award per report, daily cap, trust, GPS jump check).
-- Coins can be EARNED by any account (also anonymous) but SPENT only by an account with a confirmed e-mail.

-- A09: aizsardzība. Šo vecāko failu nedrīkst palaist vēlreiz, ja pēc tā jau palaisti jaunāki — tas atjaunotu vecākas
-- funkciju versijas un atceltu vēlākos labojumus. Tukšā datubāzē (pirmā uzstādīšana pēc supabase/ORDER.txt) un pirms
-- rides-17-migrations.sql šī pārbaude neko nedara. Sk. supabase/MIGRATIONS.md.
do $$ begin
  if to_regclass('public.cz_migrations') is not null then   -- (atsevišķs if: tabulas var vēl nebūt)
    if exists (select 1 from public.cz_migrations where seq > 19)
       and coalesce(current_setting('cz.allow_rerun', true), '') <> 'on' then
      raise exception 'coins-1.sql (Nr. 19) ir vecs migrācijas fails, un pēc tā jau palaisti jaunāki — atkārtoti to palaist nedrīkst (atceltu vēlākos labojumus). Sk. supabase/MIGRATIONS.md.';
    end if;
  end if;
end $$;

-- ======================================================================================================
-- 1. Report types (config)
-- ======================================================================================================
create table if not exists public.report_types (
  id                    text primary key,                 -- same id as the client (alerts.js ALERT_TYPES)
  label                 text not null,                    -- Latvian UI label
  icon                  text not null,                    -- icon key in the client (ALERT_GLYPHS)
  default_lifetime_min  int  not null check (default_lifetime_min between 1 and 1440),
  max_lifetime_factor   numeric not null default 2 check (max_lifetime_factor >= 1),  -- YES never extends past factor × lifetime
  confirmation_question text not null,
  ask_confirmation      boolean not null default true,
  coin_reward           int  not null default 10 check (coin_reward between 0 and 100),
  author_bonus          int  not null default 5  check (author_bonus between 0 and 100),
  ask_repeat_min        int  check (ask_repeat_min is null or ask_repeat_min > 0),   -- null = ask a user only once per report
  ask_distance_m        int  not null default 300 check (ask_distance_m between 50 and 2000),
  in_picker             boolean not null default true,    -- shown in the "Ziņot" grid
  sort                  int  not null default 0
);
alter table public.report_types enable row level security;

insert into public.report_types (id, label, icon, default_lifetime_min, confirmation_question, sort, ask_distance_m) values
  ('police',        'Policija',   'police',        45, 'Vai policija vēl ir šeit?',     1, 300),
  ('camera-mobile', 'Radars',     'camera-mobile', 60, 'Vai radars vēl ir šeit?',       2, 300),
  ('jam',           'Sastrēgums', 'jam',           20, 'Vai sastrēgums vēl ir?',        3, 150),   -- asked when entering the jam
  ('accident',      'Avārija',    'accident',      60, 'Vai avārija vēl ir šeit?',      4, 300),
  ('obstacle',      'Šķērslis',   'obstacle',      30, 'Vai šķērslis vēl ir uz ceļa?',  5, 300)
on conflict (id) do update set
  label = excluded.label, icon = excluded.icon, default_lifetime_min = excluded.default_lifetime_min,
  confirmation_question = excluded.confirmation_question, sort = excluded.sort, ask_distance_m = excluded.ask_distance_m;

-- Lifetime of a type in minutes: report_types first, otherwise the legacy per-type table (report_ttl).
create or replace function public.report_type_ttl(t text) returns int
  language sql stable set search_path = public as
$$ select coalesce((select default_lifetime_min from report_types where id = t), report_ttl(t)) $$;

-- Public read of the config (the client keeps a mirror in alerts.js; this lets it stay in sync).
create or replace function public.report_types_list() returns setof public.report_types
  language sql stable security definer set search_path = public as
$$ select * from report_types order by sort, id $$;

-- ======================================================================================================
-- 2. Reports and confirmations — new columns
-- ======================================================================================================
alter table public.reports add column if not exists confidence real not null default 0.5;   -- 0…1, (yes_w + 1) / (yes_w + no_w + 2)
alter table public.reports add column if not exists yes_w      real not null default 0;     -- trust-weighted YES
alter table public.reports add column if not exists no_w       real not null default 0;     -- trust-weighted NO
alter table public.reports add column if not exists no_streak  smallint not null default 0; -- NO answers in a row (YES resets)
alter table public.reports add column if not exists min_yes    smallint not null default 0; -- low-trust author: YES needed before shown widely

alter table public.report_votes add column if not exists weight    real not null default 0.7;  -- voter trust at the time of the vote
alter table public.report_votes add column if not exists lat       double precision;
alter table public.report_votes add column if not exists lng       double precision;
alter table public.report_votes add column if not exists speed_kmh real;
alter table public.report_votes add column if not exists heading   smallint;
alter table public.report_votes add column if not exists coins     int not null default 0;     -- coins paid for this answer
alter table public.report_votes add column if not exists agreed    boolean;                    -- matched the majority at the time

-- ======================================================================================================
-- 3. Wallet, ledger, skins
-- ======================================================================================================
create table if not exists public.skins (
  id         text primary key,
  name       text not null,                                   -- Latvian name shown in the shop
  price      int  not null check (price > 0),
  rarity     text generated always as (case when price >= 600 then 'epic' when price >= 400 then 'rare' else 'common' end) stored,
  shop_image text not null,                                   -- card image (relative URL in the app)
  map_image  text not null,                                   -- small map version (~48 px)
  sort       int  not null default 0,
  active     boolean not null default true
);
alter table public.skins enable row level security;

insert into public.skins (id, name, price, shop_image, map_image, sort) values
  ('chef',    'Pavārs',     200, 'skins/chef.svg',    'skins/chef-map.svg',    1),
  ('cowboy',  'Kovbojs',    300, 'skins/cowboy.svg',  'skins/cowboy-map.svg',  2),
  ('pilot',   'Pilots',     350, 'skins/pilot.svg',   'skins/pilot-map.svg',   3),
  ('viking',  'Vikings',    400, 'skins/viking.svg',  'skins/viking-map.svg',  4),
  ('ninja',   'Ninja',      450, 'skins/ninja.svg',   'skins/ninja-map.svg',   5),
  ('wizard',  'Burvis',     500, 'skins/wizard.svg',  'skins/wizard-map.svg',  6),
  ('rally',   'Rallijs',    600, 'skins/rally.svg',   'skins/rally-map.svg',   7),
  ('rainbow', 'Varavīksne', 800, 'skins/rainbow.svg', 'skins/rainbow-map.svg', 8)
on conflict (id) do update set name = excluded.name, price = excluded.price, shop_image = excluded.shop_image,
  map_image = excluded.map_image, sort = excluded.sort;

create table if not exists public.user_wallet (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  balance       int  not null default 0 check (balance >= 0),
  trust         real not null default 0.7 check (trust between 0 and 1),
  earned_day    date,                                         -- Riga calendar day of earned_today
  earned_today  int  not null default 0,
  lifetime      int  not null default 0,                      -- all coins ever earned
  equipped_skin text references public.skins(id),
  last_lat      double precision,                             -- last position accepted with an answer (GPS jump check)
  last_lng      double precision,
  last_fix_at   timestamptz,
  gps_flags     int  not null default 0,                      -- suspicious GPS events (jumps / mock location)
  updated_at    timestamptz not null default now()
);
alter table public.user_wallet enable row level security;

create table if not exists public.user_skins (
  user_id     uuid not null references auth.users(id) on delete cascade,
  skin_id     text not null references public.skins(id),
  acquired_at timestamptz not null default now(),
  primary key (user_id, skin_id)
);
alter table public.user_skins enable row level security;

create table if not exists public.coin_ledger (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  delta      int  not null,
  reason     text not null check (reason in ('answer', 'author_bonus', 'purchase', 'merge', 'admin')),
  report_id  uuid,
  skin_id    text,
  created_at timestamptz not null default now()
);
create index if not exists coin_ledger_user_time on public.coin_ledger (user_id, created_at);
alter table public.coin_ledger enable row level security;

-- ======================================================================================================
-- 4. Helpers (internal — not callable by clients)
-- ======================================================================================================
create or replace function public.coin_daily_cap() returns int language sql immutable as $$ select 100 $$;
create or replace function public.coin_today() returns date language sql stable as $$ select (now() at time zone 'Europe/Riga')::date $$;

-- Coin multiplier from trust: users who often disagree with the majority earn half, then nothing.
create or replace function public.coin_trust_factor(t real) returns numeric
  language sql immutable as
$$ select case when t >= 0.6 then 1.0 when t >= 0.4 then 0.5 else 0 end $$;

-- Wallet row for a user (created on first use). Returns the row locked for update.
create or replace function public.wallet_lock(u uuid) returns public.user_wallet
  language plpgsql security definer set search_path = public as
$$
declare w user_wallet;
begin
  insert into user_wallet (user_id) values (u) on conflict (user_id) do nothing;
  select * into w from user_wallet where user_id = u for update;
  if w.earned_day is distinct from coin_today() then        -- new day: reset the daily counter
    update user_wallet set earned_day = coin_today(), earned_today = 0 where user_id = u returning * into w;
  end if;
  return w;
end
$$;

-- Award coins (trust factor + daily cap applied). Returns the number of coins actually paid.
create or replace function public.wallet_award(u uuid, amount int, why text, rid uuid) returns int
  language plpgsql security definer set search_path = public as
$$
declare w user_wallet; paid int;
begin
  if u is null or amount <= 0 then return 0; end if;
  w := wallet_lock(u);
  paid := floor(amount * coin_trust_factor(w.trust))::int;
  paid := greatest(0, least(paid, coin_daily_cap() - w.earned_today));
  if paid > 0 then
    update user_wallet set balance = balance + paid, earned_today = earned_today + paid,
      lifetime = lifetime + paid, updated_at = now() where user_id = u;
    insert into coin_ledger (user_id, delta, reason, report_id) values (u, paid, why, rid);
  end if;
  return paid;
end
$$;

-- Trust moves slowly: +0.03 when agreeing with the majority, −0.08 when disagreeing (bounded 0…1).
create or replace function public.wallet_trust_adjust(u uuid, delta real) returns void
  language sql security definer set search_path = public as
$$
  insert into user_wallet (user_id) values (u) on conflict (user_id) do nothing;
  update user_wallet set trust = greatest(0, least(1, trust + delta)), updated_at = now() where user_id = u;
$$;

-- Can this account spend coins? Only a real (non-anonymous) account with a confirmed e-mail.
create or replace function public.wallet_can_spend(u uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select coalesce((select not coalesce(is_anonymous, false) and email is not null and email_confirmed_at is not null
                    from auth.users where id = u), false) $$;

-- ======================================================================================================
-- 5. Votes: applying an answer to a report (shared by report_confirm, the legacy report_vote and merges)
-- ======================================================================================================
-- p_vote: 'still' (YES) or 'gone' (NO). Weighted by the voter's trust. Updates counts, confidence, the
-- NO streak (2 NO in a row hides the report) and the lifetime (YES extends, capped at factor × lifetime).
create or replace function public.report_vote_apply(p_id uuid, p_user uuid, p_vote text) returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare r reports; t report_types; ttl int; s int; g int; yw real; nw real; wt real; streak int; maxexp timestamptz;
begin
  select * into r from reports where id = p_id for update;
  if not found or r.hidden or r.expires_at <= now() then raise exception 'not_found'; end if;
  select trust into wt from user_wallet where user_id = p_user;
  wt := coalesce(wt, 0.7);
  insert into report_votes (report_id, user_id, vote, weight) values (p_id, p_user, p_vote, wt)
    on conflict (report_id, user_id) do update set vote = excluded.vote, weight = excluded.weight, created_at = now();
  select count(*) filter (where vote = 'still'), count(*) filter (where vote = 'gone'),
         coalesce(sum(weight) filter (where vote = 'still'), 0), coalesce(sum(weight) filter (where vote = 'gone'), 0)
    into s, g, yw, nw from report_votes where report_id = p_id;
  select * into t from report_types where id = r.type;
  ttl := report_type_ttl(r.type);
  maxexp := r.created_at + make_interval(mins => (ttl * coalesce(t.max_lifetime_factor, 2))::int);
  streak := case when p_vote = 'still' then 0 else r.no_streak + 1 end;
  update reports set
      still_count = s, gone_count = g, yes_w = yw, no_w = nw,
      confidence  = round(((yw + 1) / (yw + nw + 2))::numeric, 3),
      no_streak   = streak,
      hidden      = hidden or streak >= 2,
      expires_at  = case when p_vote = 'still'
                         then greatest(expires_at, least(now() + make_interval(mins => ttl), maxexp))
                         else expires_at end
    where id = p_id
    returning * into r;
  return jsonb_build_object('id', r.id, 'still', s, 'gone', g, 'hidden', r.hidden, 'expires_at', r.expires_at,
                            'confidence', r.confidence);
end
$$;

-- ======================================================================================================
-- 6. Confirming a report (the "Vai … vēl ir šeit?" prompt) — validated, pays coins
-- ======================================================================================================
-- The client sends what it measured at the moment of the answer. The server checks that the user really
-- is driving past: near the report, moving, same direction, decent accuracy, no impossible GPS jump.
-- Errors (raised as plain codes): no_auth, bad_answer, not_found, not_askable, own_report, already_answered,
-- vote_limit, not_nearby, not_driving, wrong_direction, poor_gps, gps_suspect.
create or replace function public.report_confirm(p_id uuid, p_answer text, p_lat float8, p_lng float8,
    p_heading int, p_speed_kmh float8, p_accuracy float8 default null, p_mock boolean default false) returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); r reports; t report_types; w user_wallet; v text; d float8; n int;
        prev_yes real; prev_no real; v_agreed boolean := null; res jsonb; paid int := 0; bonus int := 0;
        dt float8; jump float8; h smallint;
begin
  if me is null then raise exception 'no_auth'; end if;
  if p_answer not in ('yes', 'no') then raise exception 'bad_answer'; end if;
  v := case when p_answer = 'yes' then 'still' else 'gone' end;
  select * into r from reports where id = p_id;
  if not found or r.hidden or r.expires_at <= now() then raise exception 'not_found'; end if;
  select * into t from report_types where id = r.type;
  if not found or not t.ask_confirmation then raise exception 'not_askable'; end if;
  if r.user_id = me then raise exception 'own_report'; end if;
  if exists (select 1 from report_votes where report_id = p_id and user_id = me) then raise exception 'already_answered'; end if;
  select count(*) into n from report_votes where user_id = me and created_at > now() - interval '1 hour';
  if n >= 60 then raise exception 'vote_limit'; end if;

  -- Physically driving past?
  if p_lat is null or p_lng is null then raise exception 'not_nearby'; end if;
  d := report_dist_m(r.lat, r.lng, p_lat, p_lng);
  if d > t.ask_distance_m + 250 then raise exception 'not_nearby'; end if;                  -- prompt at ~300 m, answered within ~7 s
  if p_speed_kmh is null or p_speed_kmh < 5 or p_speed_kmh > 220 then raise exception 'not_driving'; end if;
  if p_accuracy is not null and p_accuracy > 80 then raise exception 'poor_gps'; end if;
  h := case when p_heading is null then null else ((p_heading % 360) + 360) % 360 end;
  if h is null then raise exception 'wrong_direction'; end if;
  if r.heading is not null and least(abs(r.heading - h), 360 - abs(r.heading - h)) > 60 then raise exception 'wrong_direction'; end if;

  -- GPS jump check against the last accepted position (impossible speed ⇒ spoofed / teleported GPS)
  w := wallet_lock(me);
  if w.last_fix_at is not null and now() - w.last_fix_at < interval '15 minutes' then
    dt := greatest(extract(epoch from now() - w.last_fix_at), 1);
    jump := report_dist_m(w.last_lat, w.last_lng, p_lat, p_lng);
    if jump > 1000 and jump / dt * 3.6 > 250 then
      -- Returned (not raised) so the flag is stored; the client treats "error" like a raised code.
      update user_wallet set gps_flags = gps_flags + 1 where user_id = me;
      return jsonb_build_object('error', 'gps_suspect');
    end if;
  end if;
  update user_wallet set last_lat = p_lat, last_lng = p_lng, last_fix_at = now(),
    gps_flags = gps_flags + case when p_mock then 1 else 0 end where user_id = me;

  -- Agreement with the majority so far (needs at least ~2 earlier answers) → trust
  prev_yes := r.yes_w; prev_no := r.no_w;
  if prev_yes + prev_no >= 1.2 then
    v_agreed := (v = 'still') = (prev_yes >= prev_no);
    perform wallet_trust_adjust(me, case when v_agreed then 0.03 else -0.08 end);
  end if;

  res := report_vote_apply(p_id, me, v);
  update report_votes set lat = p_lat, lng = p_lng, speed_kmh = p_speed_kmh, heading = h, agreed = v_agreed
    where report_id = p_id and user_id = me;

  -- Coins: the answerer (once per report — guaranteed by the vote primary key) …
  if not p_mock then paid := wallet_award(me, t.coin_reward, 'answer', p_id); end if;
  update report_votes set coins = paid where report_id = p_id and user_id = me;
  -- … and the author gets a bonus for every YES from someone else
  if v = 'still' and r.user_id is not null and not p_mock then
    bonus := wallet_award(r.user_id, t.author_bonus, 'author_bonus', p_id);
    perform wallet_trust_adjust(r.user_id, 0.01);
  end if;
  -- A report hidden by NO answers before anyone said YES looks fake → the author's trust drops
  if (res->>'hidden')::boolean and r.still_count = 0 and r.user_id is not null then
    perform wallet_trust_adjust(r.user_id, -0.1);
  end if;

  perform stat_bump('report_confirm');
  perform stat_user_bump(me, 'confirms');
  if v = 'still' then perform stat_user_bump(r.user_id, 'confirmed'); end if;

  select * into w from user_wallet where user_id = me;
  return res || jsonb_build_object('coins', paid, 'balance', w.balance,
    'daily_left', greatest(0, coin_daily_cap() - w.earned_today), 'author_bonus', bonus);
end
$$;

-- Legacy "Vēl ir / Vairs nav" (older app versions): still works, but never pays coins.
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
  if p_vote = 'still' and prev is distinct from 'still' then
    perform stat_bump('report_confirm');
    perform stat_user_bump(me, 'confirms');
    perform stat_user_bump(owner, 'confirmed');
  end if;
  return res;
end
$$;

-- ======================================================================================================
-- 7. Creating reports — lifetime from report_types, low-trust authors need YES before shown widely
-- ======================================================================================================
create or replace function public.report_create(p_type text, p_lat float8, p_lng float8,
                                                p_heading int default null, p_minutes int default null) returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); ttl int; h smallint; dup reports; n int; new_id uuid; exp timestamptz; prev text;
        tr real; need smallint;
begin
  if me is null then raise exception 'no_auth'; end if;
  ttl := report_type_ttl(p_type);
  if ttl is null then raise exception 'bad_type'; end if;
  if p_lat is null or p_lng is null or p_lat not between 55.6 and 58.1 or p_lng not between 20.9 and 28.3 then
    raise exception 'outside_latvia';
  end if;
  h := case when p_heading is null then null else ((p_heading % 360) + 360) % 360 end;
  if p_minutes is not null then ttl := least(ttl, greatest(1, p_minutes)); end if;

  delete from reports where expires_at < now() - interval '2 days';   -- housekeeping

  -- Duplicate: same type, active, ≤ 150 m, not the opposite direction → merge as a confirmation (no coins)
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
      if prev is distinct from 'still' then
        perform stat_bump('report_confirm');
        perform stat_user_bump(me, 'confirms');
        perform stat_user_bump(dup.user_id, 'confirmed');
      end if;
    end if;
    return jsonb_build_object('id', dup.id, 'merged', true);
  end if;

  select count(*) into n from reports where user_id = me and created_at > now() - interval '1 hour';
  if n >= 10 then raise exception 'rate_limit'; end if;

  select trust into tr from user_wallet where user_id = me;
  need := case when coalesce(tr, 0.7) < 0.4 then 2 when coalesce(tr, 0.7) < 0.6 then 1 else 0 end;

  exp := now() + make_interval(mins => ttl);
  insert into reports (user_id, type, lat, lng, heading, expires_at, min_yes)
    values (me, p_type, round(p_lat::numeric, 6), round(p_lng::numeric, 6), h, exp, need)
    returning id into new_id;
  perform stat_bump('report:' || p_type);
  perform stat_user_bump(me, 'reports');
  return jsonb_build_object('id', new_id, 'merged', false, 'expires_at', exp, 'pending', need > 0);
end
$$;

-- Reports in an area. "pending" = from a low-trust author and not yet confirmed: the client does not draw
-- it on the map (except for the author), but still asks passing drivers to confirm it.
drop function if exists public.report_list(float8, float8, float8, float8);
create or replace function public.report_list(min_lat float8, min_lng float8, max_lat float8, max_lng float8)
returns table (id uuid, type text, lat double precision, lng double precision, heading smallint,
               created_at timestamptz, expires_at timestamptz, still_count int, mine boolean, my_vote text,
               confidence real, pending boolean)
  language sql stable security definer set search_path = public as
$$
  select r.id, r.type, r.lat, r.lng, r.heading, r.created_at, r.expires_at, r.still_count,
         coalesce(r.user_id = auth.uid(), false) as mine,
         (select v.vote from report_votes v where v.report_id = r.id and v.user_id = auth.uid()) as my_vote,
         r.confidence, r.still_count < r.min_yes as pending
  from reports r
  where not r.hidden and r.expires_at > now()
    and r.lat between least(min_lat, max_lat) and greatest(min_lat, max_lat)
    and r.lng between least(min_lng, max_lng) and greatest(min_lng, max_lng)
    and abs(max_lat - min_lat) <= 3 and abs(max_lng - min_lng) <= 8
  order by r.created_at desc
  limit 500
$$;

-- ======================================================================================================
-- 8. Wallet and Garage (skin shop)
-- ======================================================================================================
-- Shop catalogue (cheapest first). Readable without an account.
create or replace function public.skins_list() returns table (id text, name text, price int, rarity text,
    shop_image text, map_image text)
  language sql stable security definer set search_path = public as
$$ select id, name, price, rarity, shop_image, map_image from skins where active order by price, sort $$;

-- My wallet: balance, today's earnings, owned and equipped skins, whether I may spend.
create or replace function public.wallet_get() returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); w user_wallet;
begin
  if me is null then raise exception 'no_auth'; end if;
  w := wallet_lock(me);
  return jsonb_build_object(
    'balance', w.balance, 'earned_today', w.earned_today, 'daily_cap', coin_daily_cap(),
    'equipped', w.equipped_skin, 'can_spend', wallet_can_spend(me), 'low_trust', w.trust < 0.4,
    'owned', coalesce((select jsonb_agg(skin_id order by acquired_at) from user_skins where user_id = me), '[]'::jsonb));
end
$$;

-- Buy a skin atomically: lock the wallet row, check balance, deduct, grant, log. Errors: no_auth,
-- need_account (anonymous / unconfirmed e-mail), bad_skin, already_owned, not_enough.
create or replace function public.skin_buy(p_skin text) returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); s skins; w user_wallet;
begin
  if me is null then raise exception 'no_auth'; end if;
  if not wallet_can_spend(me) then raise exception 'need_account'; end if;
  select * into s from skins where id = p_skin and active;
  if not found then raise exception 'bad_skin'; end if;
  w := wallet_lock(me);                                             -- row lock: concurrent buys run one after another
  if exists (select 1 from user_skins where user_id = me and skin_id = p_skin) then raise exception 'already_owned'; end if;
  if w.balance < s.price then raise exception 'not_enough'; end if;
  update user_wallet set balance = balance - s.price, updated_at = now() where user_id = me;
  insert into user_skins (user_id, skin_id) values (me, p_skin);
  insert into coin_ledger (user_id, delta, reason, skin_id) values (me, -s.price, 'purchase', p_skin);
  return wallet_get();
end
$$;

-- Equip an owned skin (null = back to the default arrow).
create or replace function public.skin_equip(p_skin text) returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'no_auth'; end if;
  if p_skin is not null and not exists (select 1 from user_skins where user_id = me and skin_id = p_skin) then
    raise exception 'not_owned';
  end if;
  perform wallet_lock(me);
  update user_wallet set equipped_skin = p_skin, updated_at = now() where user_id = me;
  return wallet_get();
end
$$;

-- ======================================================================================================
-- 9. Moving an anonymous account into a signed-in one also moves coins and skins
-- ======================================================================================================
create or replace function public.wallet_merge(src uuid, dst uuid) returns void
  language plpgsql security definer set search_path = public as
$$
declare ws user_wallet;
begin
  select * into ws from user_wallet where user_id = src;
  if found then
    perform wallet_lock(dst);
    update user_wallet d set balance = d.balance + ws.balance, lifetime = d.lifetime + ws.lifetime,
      trust = least(d.trust, ws.trust), gps_flags = d.gps_flags + ws.gps_flags,
      equipped_skin = coalesce(d.equipped_skin, ws.equipped_skin), updated_at = now()
      where d.user_id = dst;
    if ws.balance <> 0 then insert into coin_ledger (user_id, delta, reason) values (dst, ws.balance, 'merge'); end if;
  end if;
  insert into user_skins (user_id, skin_id, acquired_at) select dst, skin_id, acquired_at from user_skins where user_id = src
    on conflict do nothing;
  update coin_ledger set user_id = dst where user_id = src;
end
$$;

-- Wrap the existing account transfer: after the rest of the data moves, move the wallet too.
-- (The original body lives in rides-9-ratings.sql; here we only add the wallet step via a trigger-free hook.)
create or replace function public.wallet_on_alias() returns trigger
  language plpgsql security definer set search_path = public as
$$ begin perform wallet_merge(new.old_user, new.new_user); return new; end $$;
drop trigger if exists account_aliases_wallet on public.account_aliases;
create trigger account_aliases_wallet after insert or update on public.account_aliases
  for each row execute function public.wallet_on_alias();

-- ======================================================================================================
-- 10. Permissions
-- ======================================================================================================
revoke all on function public.report_type_ttl(text) from public;
revoke all on function public.coin_trust_factor(real) from public;
revoke all on function public.wallet_lock(uuid) from public, anon, authenticated;
revoke all on function public.wallet_award(uuid, int, text, uuid) from public, anon, authenticated;
revoke all on function public.wallet_trust_adjust(uuid, real) from public, anon, authenticated;
revoke all on function public.wallet_can_spend(uuid) from public, anon, authenticated;
revoke all on function public.wallet_merge(uuid, uuid) from public, anon, authenticated;
revoke all on function public.wallet_on_alias() from public, anon, authenticated;
revoke all on function public.report_vote_apply(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.report_types_list() from public;
revoke all on function public.skins_list() from public;
revoke all on function public.report_list(float8, float8, float8, float8) from public;
revoke all on function public.report_confirm(uuid, text, float8, float8, int, float8, float8, boolean) from public, anon;
revoke all on function public.report_create(text, float8, float8, int, int) from public, anon;
revoke all on function public.report_vote(uuid, text) from public, anon;
revoke all on function public.wallet_get() from public, anon;
revoke all on function public.skin_buy(text) from public, anon;
revoke all on function public.skin_equip(text) from public, anon;
grant execute on function public.report_types_list() to anon, authenticated;
grant execute on function public.skins_list() to anon, authenticated;
grant execute on function public.report_list(float8, float8, float8, float8) to anon, authenticated;
grant execute on function public.report_confirm(uuid, text, float8, float8, int, float8, float8, boolean) to authenticated;
grant execute on function public.report_create(text, float8, float8, int, int) to authenticated;
grant execute on function public.report_vote(uuid, text) to authenticated;
grant execute on function public.wallet_get() to authenticated;
grant execute on function public.skin_buy(text) to authenticated;
grant execute on function public.skin_equip(text) to authenticated;

-- Check after running:
--   select * from report_types_list();  select * from skins_list();
--   select has_function_privilege('anon', 'public.skin_buy(text)', 'execute');   -- false
