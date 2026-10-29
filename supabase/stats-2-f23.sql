-- Ceļa Zīmes — F23 (v119): „Mana statistika” un īpašnieka statistika skaita atceltos tāpat kā „Mani braucieni”.
-- Palaist PĒC stats-f16.sql. Dati netiek mainīti — tikai divas funkcijas ar jauniem laukiem:
--   my_stats():    + passenger_withdrawn — mani atsauktie / beigušies pieprasījumi bez pieņemta šofera
--                  (passenger_cancelled paliek: atcelti braucieni ar saskaņotu šoferi). Kopā = atceltie „Mani braucieni”.
--   admin_stats(): + cancelled_rides (atcelti braucieni ar saskaņotu šoferi) un withdrawn (atsaukti pieprasījumi);
--                  vecais 'cancelled' (visi atceltie pieprasījumi) paliek saderībai.
-- Tiesības tās pašas: my_stats — tikai pieteikušais lietotājs (auth.uid()), admin_stats — tikai is_app_admin().

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
    -- F23: tas pats sadalījums kā „Mana statistika” / „Mani braucieni”
    'cancelled_rides',(select jsonb_build_array(count(*) filter (where r.depart_at >= d0), count(*) filter (where r.depart_at >= m0), count(*))
                   from ride_offers o join ride_requests r on r.id = o.request_id
                   where o.was_accepted and not (o.status = 'accepted' and o.trip = 'done')
                     and (r.status in ('done', 'cancelled') or o.status = 'cancelled')),
    'withdrawn',(select jsonb_build_array(count(*) filter (where r.depart_at >= d0), count(*) filter (where r.depart_at >= m0), count(*))
                   from ride_requests r where r.status = 'cancelled'
                     and not exists (select 1 from ride_offers o where o.request_id = r.id and o.was_accepted)),
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
    -- F23: atsaukti / beigušies pieprasījumi, kurus neviens šoferis nebija pieņēmis (tāpat kā „Mani braucieni”)
    'passenger_withdrawn', (select count(*) from ride_requests r where r.user_id = me and r.status = 'cancelled'
                              and not exists (select 1 from ride_offers o where o.request_id = r.id and o.was_accepted)),
    'reports',   coalesce((select n from user_stat_counters where user_id = me and kind = 'reports'), 0),
    'confirms',  coalesce((select n from user_stat_counters where user_id = me and kind = 'confirms'), 0),
    'confirmed', coalesce((select n from user_stat_counters where user_id = me and kind = 'confirmed'), 0),
    'traffic',   coalesce((select n from user_stat_counters where user_id = me and kind = 'traffic'), 0),
    'radars',    coalesce((select n from user_stat_counters where user_id = me and kind = 'radars'), 0),
    'rating',    (select jsonb_build_object('avg', s.avg, 'count', s.count, 'rides', s.rides) from rating_summary(array[me]) s),
    'since',     (select value from stat_meta where key = 'since'));
end
$$;

revoke all on function public.admin_stats() from public, anon;
revoke all on function public.my_stats() from public, anon;
grant execute on function public.admin_stats() to authenticated;
grant execute on function public.my_stats() to authenticated;
