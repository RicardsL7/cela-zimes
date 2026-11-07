-- Scenario test for supabase/rides-13-guard.sql (audit A01). Local copy only — never against production.
-- Run after the full schema (rides*.sql … coins-3-skins.sql) and rides-13-guard.sql. Prints PASS / FAIL.
-- All people and phone numbers below are made up (TEST-ONLY-…).
\set QUIET 1
reset role;
create or replace function pg_temp.ok(n text, c boolean) returns void language plpgsql as $$ begin raise notice '%: %', case when c then 'PASS' else 'FAIL' end, n; end $$;
-- Run SQL as a given user (authenticated role, auth.uid() = u). Returns null on success, or the error text.
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
create or replace function pg_temp.count_as(u uuid, q text) returns int language plpgsql as $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
  execute q into n;
  reset role;
  return n;
end $$;

begin;
-- People: A passenger, B driver who really offers, C second driver, D unrelated, S anonymous driver, N new account
insert into auth.users (id, is_anonymous) values
  ('a0000000-0000-0000-0000-00000000000a', false), ('b0000000-0000-0000-0000-00000000000b', false),
  ('c0000000-0000-0000-0000-00000000000c', false), ('d0000000-0000-0000-0000-00000000000d', false),
  ('50000000-0000-0000-0000-000000000005', true),  ('e0000000-0000-0000-0000-00000000000e', false);
insert into profiles (id, name) values
  ('a0000000-0000-0000-0000-00000000000a', 'Pasažieris A'), ('b0000000-0000-0000-0000-00000000000b', 'Šoferis B'),
  ('c0000000-0000-0000-0000-00000000000c', 'Šoferis C'),    ('d0000000-0000-0000-0000-00000000000d', 'Svešais D'),
  ('50000000-0000-0000-0000-000000000005', 'Anonīmais S');
insert into contacts (id, phone) values
  ('a0000000-0000-0000-0000-00000000000a', 'TEST-ONLY-1'), ('b0000000-0000-0000-0000-00000000000b', 'TEST-ONLY-2'),
  ('c0000000-0000-0000-0000-00000000000c', 'TEST-ONLY-4'), ('d0000000-0000-0000-0000-00000000000d', 'TEST-ONLY-3');
insert into ride_requests (id, user_id, from_lat, from_lng, to_lat, to_lng, depart_at) values
  ('11111111-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 56.95, 24.10, 56.97, 24.15, now() + interval '1 hour'),
  ('11111111-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 56.95, 24.10, 56.90, 24.00, now() + interval '2 hours');

-- B offers on request 1, C offers on request 1, S offers on request 2 (each as themselves)
select pg_temp.ok('driver B can make an offer', pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
  $q$insert into ride_offers (id, request_id, driver_id, eta_min) values ('22222222-0000-0000-0000-00000000000b', '11111111-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 5)$q$) is null);
select pg_temp.ok('driver C can make an offer', pg_temp.as_user('c0000000-0000-0000-0000-00000000000c',
  $q$insert into ride_offers (id, request_id, driver_id, eta_min) values ('22222222-0000-0000-0000-00000000000c', '11111111-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-00000000000c', 7)$q$) is null);
select pg_temp.ok('anonymous driver S can make an offer', pg_temp.as_user('50000000-0000-0000-0000-000000000005',
  $q$insert into ride_offers (id, request_id, driver_id, eta_min) values ('22222222-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000005', 9)$q$) is null);

-- ---------- A01 attack: passenger swaps the driver to an unrelated person ----------
select pg_temp.ok('A01: passenger cannot change driver_id of an offer', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$update ride_offers set driver_id = 'd0000000-0000-0000-0000-00000000000d', status = 'accepted' where id = '22222222-0000-0000-0000-00000000000b'$q$) is not null);
select pg_temp.ok('A01: passenger cannot change driver_id even without changing status', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$update ride_offers set driver_id = 'd0000000-0000-0000-0000-00000000000d' where id = '22222222-0000-0000-0000-00000000000b'$q$) is not null);
select pg_temp.ok('A01: offer still belongs to B', (select driver_id from ride_offers where id = '22222222-0000-0000-0000-00000000000b') = 'b0000000-0000-0000-0000-00000000000b');
select pg_temp.ok('A01: passenger cannot move an offer to another request', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$update ride_offers set request_id = '11111111-0000-0000-0000-000000000002' where id = '22222222-0000-0000-0000-00000000000b'$q$) is not null);
select pg_temp.ok('A01: passenger cannot hand the request to someone else', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$update ride_requests set user_id = 'd0000000-0000-0000-0000-00000000000d' where id = '11111111-0000-0000-0000-000000000001'$q$) is not null);
select pg_temp.ok('A01: passenger cannot write the trip state directly', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$update ride_offers set trip = '' where id = '22222222-0000-0000-0000-00000000000b'$q$) is not null);
-- Even with the request set to matched, D's phone stays hidden from A
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', $q$update ride_requests set status = 'matched' where id = '11111111-0000-0000-0000-000000000001'$q$);
select pg_temp.ok('A01: passenger cannot read unrelated D''s phone', pg_temp.count_as('a0000000-0000-0000-0000-00000000000a',
  $q$select count(*) from contacts where id = 'd0000000-0000-0000-0000-00000000000d'$q$) = 0);
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', $q$update ride_requests set status = 'open' where id = '11111111-0000-0000-0000-000000000001'$q$);

-- ---------- The real flow still works (the app only sends {status}) ----------
-- After rides-14-accept.sql (A02) accepting goes only through ride_offer_accept; before it — a direct {status} write.
select pg_temp.ok('passenger can accept B''s offer', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  case when to_regprocedure('public.ride_offer_accept(uuid)') is null
       then $q$update ride_offers set status = 'accepted' where id = '22222222-0000-0000-0000-00000000000b'$q$
       else $q$select ride_offer_accept('22222222-0000-0000-0000-00000000000b')$q$ end) is null);
select pg_temp.ok('passenger can mark the request matched', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$update ride_requests set status = 'matched' where id = '11111111-0000-0000-0000-000000000001'$q$) is null);
select pg_temp.ok('passenger can decline the other pending offers', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$update ride_offers set status = 'declined' where request_id = '11111111-0000-0000-0000-000000000001' and status = 'pending' and id <> '22222222-0000-0000-0000-00000000000b'$q$) is null);
select pg_temp.ok('C''s offer is declined', (select status from ride_offers where id = '22222222-0000-0000-0000-00000000000c') = 'declined');
select pg_temp.ok('matched pair: A sees B''s phone', pg_temp.count_as('a0000000-0000-0000-0000-00000000000a',
  $q$select count(*) from contacts where id = 'b0000000-0000-0000-0000-00000000000b'$q$) = 1);
select pg_temp.ok('matched pair: B sees A''s phone', pg_temp.count_as('b0000000-0000-0000-0000-00000000000b',
  $q$select count(*) from contacts where id = 'a0000000-0000-0000-0000-00000000000a'$q$) = 1);
select pg_temp.ok('A still cannot read D''s phone', pg_temp.count_as('a0000000-0000-0000-0000-00000000000a',
  $q$select count(*) from contacts where id = 'd0000000-0000-0000-0000-00000000000d'$q$) = 0);
select pg_temp.ok('unrelated D cannot read B''s phone', pg_temp.count_as('d0000000-0000-0000-0000-00000000000d',
  $q$select count(*) from contacts where id = 'b0000000-0000-0000-0000-00000000000b'$q$) = 0);
select pg_temp.ok('declined driver C cannot read A''s phone', pg_temp.count_as('c0000000-0000-0000-0000-00000000000c',
  $q$select count(*) from contacts where id = 'a0000000-0000-0000-0000-00000000000a'$q$) = 0);
select pg_temp.ok('driver B cannot change the passenger of the request', pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
  $q$update ride_offers set driver_id = 'c0000000-0000-0000-0000-00000000000c', status = 'cancelled' where id = '22222222-0000-0000-0000-00000000000b'$q$) is not null);
-- Server functions (security definer) keep working
-- (call and check are separate statements: an uncorrelated subquery would run before the call)
select pg_temp.ok('driver trip update via RPC still works', pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
  $q$select ride_driver_update('22222222-0000-0000-0000-00000000000b', 'coming', 56.95, 24.10, 90)$q$) is null);
select pg_temp.ok('driver trip update via RPC saved', (select trip from ride_offers where id = '22222222-0000-0000-0000-00000000000b') = 'coming');
select pg_temp.ok('passenger location via RPC still works', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$select ride_passenger_update('22222222-0000-0000-0000-00000000000b', 56.951, 24.101)$q$) is null);
select pg_temp.ok('passenger location via RPC saved', (select pas_lat from ride_offers where id = '22222222-0000-0000-0000-00000000000b') = 56.951);
select pg_temp.ok('driver can still cancel own offer (status only)', pg_temp.as_user('c0000000-0000-0000-0000-00000000000c',
  $q$update ride_offers set status = 'cancelled' where id = '22222222-0000-0000-0000-00000000000c'$q$) is null);
-- Account merge (anonymous S → new account N) still moves S's offer to N
insert into account_transfers (code_hash, from_user, expires_at)
  values (encode(sha256(convert_to('TEST-CODE', 'UTF8')), 'hex'), '50000000-0000-0000-0000-000000000005', now() + interval '10 minutes');
select pg_temp.ok('account merge still works', pg_temp.as_user('e0000000-0000-0000-0000-00000000000e',
  $q$select account_transfer_claim('TEST-CODE')$q$) is null);
select pg_temp.ok('account merge moved the offer to the new account', (select driver_id from ride_offers where id = '22222222-0000-0000-0000-000000000005') = 'e0000000-0000-0000-0000-00000000000e');
-- Privileges: the app needs only UPDATE (status) on these two tables
select pg_temp.ok('authenticated may update status of offers', has_column_privilege('authenticated', 'public.ride_offers', 'status', 'UPDATE'));
select pg_temp.ok('authenticated may not update driver_id/trip directly', not has_column_privilege('authenticated', 'public.ride_offers', 'driver_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.ride_offers', 'trip', 'UPDATE'));
select pg_temp.ok('anon may not update offers or requests', not has_table_privilege('anon', 'public.ride_offers', 'UPDATE')
  and not has_column_privilege('anon', 'public.ride_requests', 'status', 'UPDATE'));
rollback;
