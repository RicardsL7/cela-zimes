-- Scenario test for supabase/rides-14-accept.sql (audit A02). Local copy only — never against production.
-- Run after the full schema, rides-13-guard.sql and rides-14-accept.sql. Prints PASS / FAIL.
-- All people below are made up. The parallel case (two sessions at once) is in tests/rides-accept-parallel.sh.
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

begin;
insert into auth.users (id) values
  ('a0000000-0000-0000-0000-00000000000a'), ('b0000000-0000-0000-0000-00000000000b'),
  ('c0000000-0000-0000-0000-00000000000c'), ('d0000000-0000-0000-0000-00000000000d'), ('e0000000-0000-0000-0000-00000000000e');
insert into profiles (id, name) values
  ('a0000000-0000-0000-0000-00000000000a', 'Pasažieris A'), ('b0000000-0000-0000-0000-00000000000b', 'Šoferis B'),
  ('c0000000-0000-0000-0000-00000000000c', 'Šoferis C'),    ('d0000000-0000-0000-0000-00000000000d', 'Svešais D'),
  ('e0000000-0000-0000-0000-00000000000e', 'Šoferis E');
insert into ride_requests (id, user_id, from_lat, from_lng, to_lat, to_lng, depart_at) values
  ('11111111-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 56.95, 24.10, 56.97, 24.15, now() + interval '1 hour'),
  ('11111111-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 56.95, 24.10, 56.90, 24.00, now() + interval '2 hours');
insert into ride_offers (id, request_id, driver_id, eta_min) values
  ('22222222-0000-0000-0000-00000000000b', '11111111-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 5),
  ('22222222-0000-0000-0000-00000000000c', '11111111-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-00000000000c', 7),
  ('22222222-0000-0000-0000-0000000000b2', '11111111-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-00000000000b', 5);

-- ---------- Old way (direct writes) is closed ----------
select pg_temp.ok('A02: direct PATCH status=accepted is refused', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$update ride_offers set status = 'accepted' where id = '22222222-0000-0000-0000-00000000000b'$q$) is not null);
select pg_temp.ok('A02: direct PATCH request status=matched is refused', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$update ride_requests set status = 'matched' where id = '11111111-0000-0000-0000-000000000001'$q$) is not null);
select pg_temp.ok('nothing changed by the refused writes', (select status from ride_offers where id = '22222222-0000-0000-0000-00000000000b') = 'pending'
  and (select status from ride_requests where id = '11111111-0000-0000-0000-000000000001') = 'open');

-- ---------- Accept via the server function ----------
select pg_temp.ok('stranger D cannot accept A''s offer', pg_temp.as_user('d0000000-0000-0000-0000-00000000000d',
  $q$select ride_offer_accept('22222222-0000-0000-0000-00000000000b')$q$) like '%offer_not_found%');
select pg_temp.ok('driver B cannot accept own offer', pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
  $q$select ride_offer_accept('22222222-0000-0000-0000-00000000000b')$q$) like '%offer_not_found%');
select pg_temp.ok('unknown offer → offer_not_found', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$select ride_offer_accept('22222222-0000-0000-0000-000000000999')$q$) like '%offer_not_found%');
select pg_temp.ok('passenger A accepts B''s offer', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$select ride_offer_accept('22222222-0000-0000-0000-00000000000b')$q$) is null);
select pg_temp.ok('offer B accepted', (select status from ride_offers where id = '22222222-0000-0000-0000-00000000000b') = 'accepted');
select pg_temp.ok('request matched in the same step', (select status from ride_requests where id = '11111111-0000-0000-0000-000000000001') = 'matched');
select pg_temp.ok('other pending offer C declined in the same step', (select status from ride_offers where id = '22222222-0000-0000-0000-00000000000c') = 'declined');
select pg_temp.ok('declined time recorded (F12 still works)', (select responded_at is not null from ride_offers where id = '22222222-0000-0000-0000-00000000000c'));
select pg_temp.ok('was_accepted set (history still works)', (select was_accepted from ride_offers where id = '22222222-0000-0000-0000-00000000000b'));
select pg_temp.ok('offer on A''s other request untouched', (select status from ride_offers where id = '22222222-0000-0000-0000-0000000000b2') = 'pending');
-- Repeat click / lost answer: same offer again is safe
create temp table res (j jsonb);
grant insert on res to authenticated;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', $q$insert into res select ride_offer_accept('22222222-0000-0000-0000-00000000000b')$q$);
select pg_temp.ok('accepting the same offer again is safe (already=true)', (select (j->>'ok')::boolean and (j->>'already')::boolean from res));
select pg_temp.ok('second offer cannot be accepted (request_not_open)', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$select ride_offer_accept('22222222-0000-0000-0000-00000000000c')$q$) like '%request_not_open%');
select pg_temp.ok('still exactly one accepted offer', (select count(*) from ride_offers where request_id = '11111111-0000-0000-0000-000000000001' and status = 'accepted') = 1);
-- Unique index is a hard backstop, even for server code
select pg_temp.ok('unique index ride_offers_one_accepted exists', (select count(*) from pg_indexes where indexname = 'ride_offers_one_accepted') = 1);
do $$ begin
  update ride_offers set status = 'accepted' where id = '22222222-0000-0000-0000-00000000000c';
  raise notice 'FAIL: unique index did not stop a second accepted offer';
exception when unique_violation then
  raise notice 'PASS: unique index stops a second accepted offer (even server side)';
end $$;

-- ---------- Allowed direct transitions still work ----------
select pg_temp.ok('passenger can decline a pending offer', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$update ride_offers set status = 'declined' where id = '22222222-0000-0000-0000-0000000000b2'$q$) is null);
select pg_temp.ok('passenger cannot turn a declined offer back to pending', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$update ride_offers set status = 'pending' where id = '22222222-0000-0000-0000-0000000000b2'$q$) is not null);
select pg_temp.ok('passenger cannot decline the accepted offer directly', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$update ride_offers set status = 'declined' where id = '22222222-0000-0000-0000-00000000000b'$q$) is not null);
-- Race: passenger already declined C, C presses „Atcelt” — allowed, and the matched request stays matched
select pg_temp.ok('driver C can cancel an already declined offer', pg_temp.as_user('c0000000-0000-0000-0000-00000000000c',
  $q$update ride_offers set status = 'cancelled' where id = '22222222-0000-0000-0000-00000000000c'$q$) is null);
select pg_temp.ok('…and that does not reopen the matched request', (select status from ride_requests where id = '11111111-0000-0000-0000-000000000001') = 'matched');
-- Driver cancels the accepted offer → request reopens (existing trigger) → passenger may accept again later
select pg_temp.ok('driver can cancel the accepted offer', pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
  $q$update ride_offers set status = 'cancelled' where id = '22222222-0000-0000-0000-00000000000b'$q$) is null);
select pg_temp.ok('request reopened after driver cancel', (select status from ride_requests where id = '11111111-0000-0000-0000-000000000001') = 'open');
insert into ride_offers (id, request_id, driver_id, eta_min) values
  ('22222222-0000-0000-0000-0000000000d1', '11111111-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-00000000000d', 4);
select pg_temp.ok('passenger can accept a new offer after the reopen', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$select ride_offer_accept('22222222-0000-0000-0000-0000000000d1')$q$) is null);
select pg_temp.ok('…and the request is matched again with one accepted offer',
  (select status from ride_requests where id = '11111111-0000-0000-0000-000000000001') = 'matched');
select pg_temp.ok('passenger can cancel a matched request', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$update ride_requests set status = 'cancelled' where id = '11111111-0000-0000-0000-000000000001'$q$) is null);
select pg_temp.ok('passenger cannot reopen a cancelled request', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$update ride_requests set status = 'open' where id = '11111111-0000-0000-0000-000000000001'$q$) is not null);
insert into ride_offers (id, request_id, driver_id, eta_min) values
  ('22222222-0000-0000-0000-0000000000e1', '11111111-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000000e', 6);
select pg_temp.ok('offer on a cancelled request cannot be accepted', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$select ride_offer_accept('22222222-0000-0000-0000-0000000000e1')$q$) like '%request_not_open%');
-- Server housekeeping still runs
select pg_temp.ok('ride_expire still runs', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', $q$select ride_expire()$q$) is null);
select pg_temp.ok('anon may not call ride_offer_accept', not has_function_privilege('anon', 'public.ride_offer_accept(uuid)', 'execute'));
rollback;
