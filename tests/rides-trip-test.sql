-- Scenario test for supabase/rides-15-trip.sql (audit A03). Local copy only — never against production.
-- Run after the full schema, rides-13-guard.sql, rides-14-accept.sql and rides-15-trip.sql. Prints PASS / FAIL.
-- All people below are made up.
\set QUIET 1
reset role;
create or replace function pg_temp.ok(n text, c boolean) returns void language plpgsql as $$ begin raise notice '%: %', case when c then 'PASS' else 'FAIL' end, n; end $$;
create or replace function pg_temp.as_user(u uuid, q text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
  execute q;
  reset role;
  return null;
exception when others then
  reset role;
  return sqlerrm;
end $$;
-- Driver B moves trip of offer o via the real RPC
create or replace function pg_temp.drv(o uuid, t text) returns text language sql as $$
  select pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
    format('select ride_driver_update(%L, %L, 56.95, 24.10, 90)', o, t)) $$;

begin;
insert into auth.users (id) values
  ('a0000000-0000-0000-0000-00000000000a'), ('b0000000-0000-0000-0000-00000000000b'),
  ('c0000000-0000-0000-0000-00000000000c'), ('d0000000-0000-0000-0000-00000000000d');
insert into profiles (id, name) values
  ('a0000000-0000-0000-0000-00000000000a', 'Pasažieris A'), ('b0000000-0000-0000-0000-00000000000b', 'Šoferis B'),
  ('c0000000-0000-0000-0000-00000000000c', 'Šoferis C'),    ('d0000000-0000-0000-0000-00000000000d', 'Svešais D');
insert into ride_requests (id, user_id, from_lat, from_lng, to_lat, to_lng, depart_at) values
  ('11111111-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 56.95, 24.10, 56.97, 24.15, now() + interval '1 hour'),
  ('11111111-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 56.95, 24.10, 56.90, 24.00, now() + interval '2 hours'),
  ('11111111-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-00000000000a', 56.95, 24.10, 56.80, 24.30, now() + interval '3 hours');

-- ---------- New offer always starts clean ----------
select pg_temp.ok('driver B can make an offer (even sending trip/onboard values)', pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
  $q$insert into ride_offers (id, request_id, driver_id, eta_min, trip, onboard_at, done_at, drv_lat, drv_lng, drv_at)
     values ('22222222-0000-0000-0000-00000000000b', '11111111-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 5,
             'onboard', now(), now(), 1, 2, now())$q$) is null);
select pg_temp.ok('A03: new offer starts with empty trip', (select trip = '' and onboard_at is null and done_at is null and drv_lat is null and drv_at is null
  from ride_offers where id = '22222222-0000-0000-0000-00000000000b'));
insert into ride_offers (id, request_id, driver_id, eta_min) values
  ('22222222-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-00000000000c', 6);

-- ---------- Trip only for an accepted offer ----------
select pg_temp.drv('22222222-0000-0000-0000-00000000000b', 'coming');
select pg_temp.ok('pending offer: trip does not move', (select trip from ride_offers where id = '22222222-0000-0000-0000-00000000000b') = '');
select pg_temp.ok('passenger accepts B', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$select ride_offer_accept('22222222-0000-0000-0000-00000000000b')$q$) is null);

-- ---------- Forward steps work ----------
select pg_temp.ok('coming', pg_temp.drv('22222222-0000-0000-0000-00000000000b', 'coming') is null);
select pg_temp.ok('same step again is harmless (retry)', pg_temp.drv('22222222-0000-0000-0000-00000000000b', 'coming') is null);
select pg_temp.ok('location-only update works', pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
  $q$select ride_driver_update('22222222-0000-0000-0000-00000000000b', null, 56.96, 24.11, 45)$q$) is null);
select pg_temp.ok('arrived', pg_temp.drv('22222222-0000-0000-0000-00000000000b', 'arrived') is null);
select pg_temp.ok('A03: cannot finish before boarding', pg_temp.drv('22222222-0000-0000-0000-00000000000b', 'done') like '%trip_not_onboard%');
select pg_temp.ok('A03: going back arrived → coming is refused', pg_temp.drv('22222222-0000-0000-0000-00000000000b', 'coming') like '%trip_backwards%');
select pg_temp.ok('onboard_at still empty before boarding', (select onboard_at is null from ride_offers where id = '22222222-0000-0000-0000-00000000000b'));
select pg_temp.ok('onboard', pg_temp.drv('22222222-0000-0000-0000-00000000000b', 'onboard') is null);
select pg_temp.ok('A03: boarding time recorded by the database', (select onboard_at is not null from ride_offers where id = '22222222-0000-0000-0000-00000000000b'));
create temp table t0 as select onboard_at from ride_offers where id = '22222222-0000-0000-0000-00000000000b';

-- ---------- After boarding nobody can cancel or rewind ----------
select pg_temp.ok('A03: driver cannot rewind onboard → arrived', pg_temp.drv('22222222-0000-0000-0000-00000000000b', 'arrived') like '%trip_backwards%');
select pg_temp.ok('A03: driver cannot rewind onboard → empty', pg_temp.drv('22222222-0000-0000-0000-00000000000b', '') like '%trip_backwards%');
select pg_temp.ok('A03: driver cannot cancel after boarding', pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
  $q$update ride_offers set status = 'cancelled' where id = '22222222-0000-0000-0000-00000000000b'$q$) like '%trip_started%');
select pg_temp.ok('A03: passenger cannot cancel the request after boarding', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$update ride_requests set status = 'cancelled' where id = '11111111-0000-0000-0000-000000000001'$q$) like '%trip_started%');
select pg_temp.ok('A03: passenger cannot touch trip or onboard_at directly', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$update ride_offers set trip = '', onboard_at = null where id = '22222222-0000-0000-0000-00000000000b'$q$) is not null);
update ride_offers set onboard_at = null where id = '22222222-0000-0000-0000-00000000000b';   -- as postgres (server code)
select pg_temp.ok('A03: even server code cannot clear the boarding time', (select o.onboard_at = t.onboard_at from ride_offers o, t0 t where o.id = '22222222-0000-0000-0000-00000000000b'));
do $$ begin
  update ride_offers set trip = 'arrived' where id = '22222222-0000-0000-0000-00000000000b';
  raise notice 'FAIL: server code could rewind trip';
exception when insufficient_privilege then raise notice 'PASS: server code cannot rewind trip either';
end $$;
select pg_temp.ok('state unchanged: accepted, onboard, request matched',
  (select status = 'accepted' and trip = 'onboard' from ride_offers where id = '22222222-0000-0000-0000-00000000000b')
  and (select status from ride_requests where id = '11111111-0000-0000-0000-000000000001') = 'matched');
select pg_temp.ok('A03: not a refund candidate after boarding', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$do $d$ begin if exists (select 1 from ride_refund_candidates() x where x = '22222222-0000-0000-0000-00000000000b') then raise exception 'listed'; end if; end $d$$q$) is null);

-- ---------- Finish ----------
select pg_temp.ok('stranger D cannot finish B''s ride', pg_temp.as_user('d0000000-0000-0000-0000-00000000000d',
  $q$select ride_driver_update('22222222-0000-0000-0000-00000000000b', 'done', null, null, null)$q$) is null
  and (select trip from ride_offers where id = '22222222-0000-0000-0000-00000000000b') = 'onboard');
select pg_temp.ok('done', pg_temp.drv('22222222-0000-0000-0000-00000000000b', 'done') is null);
select pg_temp.ok('done: finish time recorded, request done', (select done_at is not null and trip = 'done' from ride_offers where id = '22222222-0000-0000-0000-00000000000b')
  and (select status from ride_requests where id = '11111111-0000-0000-0000-000000000001') = 'done');
select pg_temp.ok('A03: finished ride cannot be rewound', pg_temp.drv('22222222-0000-0000-0000-00000000000b', 'coming') is not null
  and (select trip from ride_offers where id = '22222222-0000-0000-0000-00000000000b') = 'done');
select pg_temp.ok('A03: finished ride cannot be cancelled by the driver', pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
  $q$update ride_offers set status = 'cancelled' where id = '22222222-0000-0000-0000-00000000000b'$q$) is not null);
select pg_temp.ok('rating still works after done', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$insert into ride_ratings (offer_id, stars) values ('22222222-0000-0000-0000-00000000000b', 5)$q$) is null);

-- ---------- Before boarding cancel still works and refunds stay possible ----------
insert into ride_offers (id, request_id, driver_id, eta_min) values
  ('22222222-0000-0000-0000-0000000000b2', '11111111-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-00000000000b', 5);
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', $q$select ride_offer_accept('22222222-0000-0000-0000-0000000000b2')$q$);
select pg_temp.drv('22222222-0000-0000-0000-0000000000b2', 'arrived');
insert into ride_payments (offer_id, session_id) values ('22222222-0000-0000-0000-0000000000b2', 'cs_test_A03fixturefixture');
select pg_temp.ok('driver can cancel before boarding', pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
  $q$update ride_offers set status = 'cancelled' where id = '22222222-0000-0000-0000-0000000000b2'$q$) is null);
select pg_temp.ok('request reopened after cancel before boarding', (select status from ride_requests where id = '11111111-0000-0000-0000-000000000002') = 'open');
create temp table cand (id uuid);
grant insert on cand to authenticated;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', $q$insert into cand select * from ride_refund_candidates()$q$);
select pg_temp.ok('cancelled before boarding is a refund candidate', exists (select 1 from cand where id = '22222222-0000-0000-0000-0000000000b2'));
select pg_temp.ok('A03: trip of a cancelled offer cannot move', pg_temp.drv('22222222-0000-0000-0000-0000000000b2', 'onboard') is null
  and (select trip from ride_offers where id = '22222222-0000-0000-0000-0000000000b2') = 'arrived');

-- Passenger cancels the matched request before boarding → driver can no longer advance the trip
insert into ride_offers (id, request_id, driver_id, eta_min) values
  ('22222222-0000-0000-0000-0000000000b3', '11111111-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-00000000000b', 5);
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', $q$select ride_offer_accept('22222222-0000-0000-0000-0000000000b3')$q$);
select pg_temp.drv('22222222-0000-0000-0000-0000000000b3', 'coming');
select pg_temp.ok('passenger can cancel before boarding', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$update ride_requests set status = 'cancelled' where id = '11111111-0000-0000-0000-000000000003'$q$) is null);
select pg_temp.ok('A03: driver cannot board a passenger on a cancelled request', pg_temp.drv('22222222-0000-0000-0000-0000000000b3', 'onboard') like '%trip_not_active%');
select pg_temp.ok('…but can still send location', pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
  $q$select ride_driver_update('22222222-0000-0000-0000-0000000000b3', null, 56.97, 24.12, 10)$q$) is null);

-- ---------- Server housekeeping ----------
-- An old onboard ride with no news for 4 h is finished by ride_expire (forward step, allowed)
insert into ride_requests (id, user_id, from_lat, from_lng, to_lat, to_lng, depart_at) values
  ('11111111-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-00000000000a', 56.95, 24.10, 56.97, 24.15, now() + interval '1 hour');
insert into ride_offers (id, request_id, driver_id, eta_min) values
  ('22222222-0000-0000-0000-0000000000b4', '11111111-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-00000000000b', 5);
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', $q$select ride_offer_accept('22222222-0000-0000-0000-0000000000b4')$q$);
select pg_temp.drv('22222222-0000-0000-0000-0000000000b4', 'onboard');
alter table ride_requests disable trigger user;
update ride_requests set depart_at = now() - interval '6 hours' where id = '11111111-0000-0000-0000-000000000004';
alter table ride_requests enable trigger user;
alter table ride_offers disable trigger ride_offers_guard_trip;
update ride_offers set drv_at = now() - interval '5 hours' where id = '22222222-0000-0000-0000-0000000000b4';
alter table ride_offers enable trigger ride_offers_guard_trip;
select pg_temp.ok('ride_expire still runs', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', $q$select ride_expire()$q$) is null);
select pg_temp.ok('ride_expire finished the stale onboard ride', (select trip = 'done' and done_at is not null and onboard_at is not null
  from ride_offers where id = '22222222-0000-0000-0000-0000000000b4'));
-- Owner repair switch works only for the owner (SQL editor), not for app users
set local cz.trip_repair = 'on';
update ride_offers set trip = 'onboard' where id = '22222222-0000-0000-0000-0000000000b4';
select pg_temp.ok('owner repair switch can fix a trip by hand', (select trip from ride_offers where id = '22222222-0000-0000-0000-0000000000b4') = 'onboard');
select pg_temp.ok('A03: repair switch does nothing for app users', pg_temp.drv('22222222-0000-0000-0000-0000000000b4', 'arrived') is not null
  and (select trip from ride_offers where id = '22222222-0000-0000-0000-0000000000b4') = 'onboard');
set local cz.trip_repair = 'off';
rollback;
