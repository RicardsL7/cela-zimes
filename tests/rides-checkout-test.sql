-- Scenario test for supabase/rides-16-checkout.sql (audit A04). Local copy only — never against production.
-- Run after the full schema, rides-13…15 and rides-16-checkout.sql. Prints PASS / FAIL.
-- The Stripe side (one session for simultaneous clicks) is tested in tests/run.js with the <checkout-flow> block of supabase/functions/ride-pay/index.ts.
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
create temp table res (j jsonb, b boolean);
grant insert, select, delete on res to authenticated;
-- A = passenger, B = driver, D = stranger
create or replace function pg_temp.begin_as(u uuid, o uuid) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  delete from res;
  perform pg_temp.as_user(u, format('insert into res (j) select ride_checkout_begin(%L)', o));
  select j into r from res; return r;
end $$;
create or replace function pg_temp.save_as(u uuid, o uuid, s text, n int) returns text language plpgsql as $$
declare e text; r boolean;
begin
  delete from res;
  e := pg_temp.as_user(u, format('insert into res (b) select ride_checkout_save(%L, %L, %s)', o, s, n));
  if e is not null then return 'ERR ' || e; end if;
  select b into r from res; return r::text;
end $$;

begin;
insert into auth.users (id) values ('a0000000-0000-0000-0000-00000000000a'), ('b0000000-0000-0000-0000-00000000000b'), ('d0000000-0000-0000-0000-00000000000d');
insert into profiles (id, name) values ('a0000000-0000-0000-0000-00000000000a', 'Pasažieris A'), ('b0000000-0000-0000-0000-00000000000b', 'Šoferis B'),
  ('d0000000-0000-0000-0000-00000000000d', 'Svešais D');
insert into ride_requests (id, user_id, from_lat, from_lng, to_lat, to_lng, depart_at) values
  ('11111111-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 56.95, 24.10, 56.97, 24.15, now() + interval '1 hour'),
  ('11111111-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 56.95, 24.10, 56.90, 24.00, now() + interval '2 hours');
insert into ride_offers (id, request_id, driver_id, eta_min) values
  ('22222222-0000-0000-0000-00000000000b', '11111111-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 5),
  ('22222222-0000-0000-0000-0000000000b2', '11111111-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-00000000000b', 5);

-- ---------- Who may start ----------
select pg_temp.ok('pending offer: begin refused', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$select ride_checkout_begin('22222222-0000-0000-0000-00000000000b')$q$) like '%offer_not_found%');
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', $q$select ride_offer_accept('22222222-0000-0000-0000-00000000000b')$q$);
select pg_temp.ok('driver cannot begin passenger''s checkout', pg_temp.as_user('b0000000-0000-0000-0000-00000000000b',
  $q$select ride_checkout_begin('22222222-0000-0000-0000-00000000000b')$q$) like '%offer_not_found%');
select pg_temp.ok('stranger cannot save a session', pg_temp.save_as('d0000000-0000-0000-0000-00000000000d', '22222222-0000-0000-0000-00000000000b', 'cs_test_STRANGERxxxxxx', 1) like '%offer_not_found%');
select pg_temp.ok('anon has no access', not has_function_privilege('anon', 'public.ride_checkout_begin(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.ride_checkout_save(uuid, text, int)', 'execute'));
select pg_temp.ok('first begin: no session, attempt 0',
  (select j->>'session_id' is null and (j->>'attempt')::int = 0 from (select pg_temp.begin_as('a0000000-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-00000000000b') j) x));

-- ---------- Saving: same session twice is fine, older never overwrites newer ----------
select pg_temp.ok('save attempt 1', pg_temp.save_as('a0000000-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-00000000000b', 'cs_test_FIRSTsession01', 1) = 'true');
select pg_temp.ok('A04: same session saved again (simultaneous click) → true, still one row',
  pg_temp.save_as('a0000000-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-00000000000b', 'cs_test_FIRSTsession01', 1) = 'true'
  and (select count(*) from ride_payments where offer_id = '22222222-0000-0000-0000-00000000000b') = 1);
select pg_temp.ok('A04: a different session with the same attempt is refused',
  pg_temp.save_as('a0000000-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-00000000000b', 'cs_test_OTHERsession01', 1) = 'false'
  and (select session_id from ride_payments where offer_id = '22222222-0000-0000-0000-00000000000b') = 'cs_test_FIRSTsession01');
select pg_temp.ok('begin returns the saved session and attempt 1',
  (select j->>'session_id' = 'cs_test_FIRSTsession01' and (j->>'attempt')::int = 1 from (select pg_temp.begin_as('a0000000-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-00000000000b') j) x));
select pg_temp.ok('newer attempt replaces an unpaid session', pg_temp.save_as('a0000000-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-00000000000b', 'cs_test_SECONDsession1', 2) = 'true');
select pg_temp.ok('A04: an older attempt never overwrites a newer one',
  pg_temp.save_as('a0000000-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-00000000000b', 'cs_test_FIRSTsession01', 1) = 'false'
  and (select session_id = 'cs_test_SECONDsession1' and attempt = 2 from ride_payments where offer_id = '22222222-0000-0000-0000-00000000000b'));
select pg_temp.ok('bad session id refused', pg_temp.save_as('a0000000-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-00000000000b', 'not-a-session', 3) like '%bad_session%');

-- ---------- Client cannot fiddle with the attempt number directly ----------
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$update ride_payments set attempt = 1 where offer_id = '22222222-0000-0000-0000-00000000000b'$q$);
select pg_temp.ok('A04: client cannot lower the attempt number', (select attempt from ride_payments where offer_id = '22222222-0000-0000-0000-00000000000b') = 2);

-- ---------- Paid payment is never replaced ----------
select set_config('cz.pay_mark', 'on', true);
update ride_payments set status = 'paid' where offer_id = '22222222-0000-0000-0000-00000000000b';
select set_config('cz.pay_mark', 'off', true);
select pg_temp.ok('A04: paid payment cannot be replaced by a new session',
  pg_temp.save_as('a0000000-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-00000000000b', 'cs_test_THIRDsession01', 3) = 'false'
  and (select session_id from ride_payments where offer_id = '22222222-0000-0000-0000-00000000000b') = 'cs_test_SECONDsession1');

-- ---------- Old rows (before this file) keep working: attempt defaults to 1 ----------
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', $q$select ride_offer_accept('22222222-0000-0000-0000-0000000000b2')$q$);
select pg_temp.ok('old app path (direct insert) still works', pg_temp.as_user('a0000000-0000-0000-0000-00000000000a',
  $q$insert into ride_payments (offer_id, session_id, attempt) values ('22222222-0000-0000-0000-0000000000b2', 'cs_test_OLDAPPsession1', 99)$q$) is null);
select pg_temp.ok('…attempt forced to 1 for client inserts', (select attempt from ride_payments where offer_id = '22222222-0000-0000-0000-0000000000b2') = 1);
select pg_temp.ok('new flow continues with attempt 2', pg_temp.save_as('a0000000-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-0000000000b2', 'cs_test_NEWFLOWsession', 2) = 'true');
rollback;
