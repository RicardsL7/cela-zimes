-- Scenario test for supabase/account-1-delete.sql (audit A15). Local copy only — never against production.
-- Runs in one transaction and rolls back. Prints PASS / FAIL.
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
create temp table res (j jsonb);
grant insert, select, delete on res to authenticated;
create or replace function pg_temp.check_as(u uuid) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  delete from res;
  perform pg_temp.as_user(u, 'insert into res (j) select account_delete_check()');
  select j into r from res; return r;
end $$;
create or replace function pg_temp.kinds(j jsonb) returns text language sql as $$
  select coalesce(string_agg(distinct x->>'kind', ',' order by x->>'kind'), '') from jsonb_array_elements(j->'blockers') x $$;
-- accepted ride that went all the way to 'done'
create or replace function pg_temp.finish(o uuid) returns void language plpgsql as $$
begin
  update ride_offers set trip = 'onboard' where id = o;
  update ride_offers set trip = 'done' where id = o;
  update ride_requests set status = 'done' where id = (select request_id from ride_offers where id = o);
end $$;
create or replace function pg_temp.pay(o uuid, st text) returns void language plpgsql as $$
begin
  insert into ride_payments (offer_id, session_id) values (o, 'cs_test_' || replace(o::text, '-', ''));
  perform set_config('cz.pay_mark', 'on', true);
  update ride_payments set status = st,
    refund_id = case when st = 'refunded' then 're_' || substr(replace(o::text, '-', ''), 1, 20) end,
    refunded_at = case when st = 'refunded' then now() end, refund_cents = case when st = 'refunded' then 500 end
  where offer_id = o;
  perform set_config('cz.pay_mark', 'off', true);
end $$;

begin;
-- A, D = passengers; B, C = drivers; E = stranger
insert into auth.users (id) values ('aa150000-0000-0000-0000-00000000000a'), ('ba150000-0000-0000-0000-00000000000b'),
  ('ca150000-0000-0000-0000-00000000000c'), ('da150000-0000-0000-0000-00000000000d'), ('ea150000-0000-0000-0000-00000000000e');
insert into profiles (id, name) values ('aa150000-0000-0000-0000-00000000000a', 'Pasažieris A'), ('ba150000-0000-0000-0000-00000000000b', 'Šoferis B'),
  ('ca150000-0000-0000-0000-00000000000c', 'Šoferis C'), ('da150000-0000-0000-0000-00000000000d', 'Pasažieris D'), ('ea150000-0000-0000-0000-00000000000e', 'Svešais E');
insert into contacts (id, phone) values ('aa150000-0000-0000-0000-00000000000a', '+37120000001'), ('ba150000-0000-0000-0000-00000000000b', '+37120000002');
insert into driver_accounts (user_id, acct) values ('ba150000-0000-0000-0000-00000000000b', 'acct_TESTdriverB1');

-- R1: A ↔ B, done and paid (history for both)
insert into ride_requests (id, user_id, from_lat, from_lng, from_name, to_lat, to_lng, to_name, depart_at, note) values
  ('11111111-0a15-0000-0000-000000000001', 'aa150000-0000-0000-0000-00000000000a', 56.951234, 24.105678, 'Brīvības iela 100', 56.971234, 24.155678, 'Mājas', now() - interval '1 day', 'ar suni');
insert into ride_offers (id, request_id, driver_id, status, note) values
  ('22222222-0a15-0000-0000-000000000001', '11111111-0a15-0000-0000-000000000001', 'ba150000-0000-0000-0000-00000000000b', 'accepted', 'balta Škoda');
update ride_requests set status = 'matched' where id = '11111111-0a15-0000-0000-000000000001';
update ride_offers set drv_lat = 56.95, drv_lng = 24.1, drv_at = now(), pas_lat = 56.95, pas_lng = 24.1, pas_at = now() where id = '22222222-0a15-0000-0000-000000000001';
select pg_temp.finish('22222222-0a15-0000-0000-000000000001');
select pg_temp.pay('22222222-0a15-0000-0000-000000000001', 'paid');
insert into ride_messages (offer_id, sender, body) values
  ('22222222-0a15-0000-0000-000000000001', 'aa150000-0000-0000-0000-00000000000a', 'Esmu pie veikala'),
  ('22222222-0a15-0000-0000-000000000001', 'ba150000-0000-0000-0000-00000000000b', 'Būšu pēc 5 min');
select pg_temp.as_user('aa150000-0000-0000-0000-00000000000a', $q$insert into ride_ratings (offer_id, stars, comment) values ('22222222-0a15-0000-0000-000000000001', 5, 'Lielisks šoferis')$q$);
select pg_temp.as_user('ba150000-0000-0000-0000-00000000000b', $q$insert into ride_ratings (offer_id, stars, comment) values ('22222222-0a15-0000-0000-000000000001', 4, 'Ok')$q$);
select pg_temp.ok('setup: two ratings on R1', (select count(*) from ride_ratings where offer_id = '22222222-0a15-0000-0000-000000000001') = 2);

-- R2: A's open request with C's pending offer (no history)
insert into ride_requests (id, user_id, from_lat, from_lng, to_lat, to_lng, depart_at) values
  ('11111111-0a15-0000-0000-000000000002', 'aa150000-0000-0000-0000-00000000000a', 56.95, 24.10, 56.90, 24.00, now() + interval '3 hours');
insert into ride_offers (id, request_id, driver_id) values
  ('22222222-0a15-0000-0000-000000000002', '11111111-0a15-0000-0000-000000000002', 'ca150000-0000-0000-0000-00000000000c');

-- R3: A ↔ B accepted, driver on the way (active)
insert into ride_requests (id, user_id, from_lat, from_lng, to_lat, to_lng, depart_at) values
  ('11111111-0a15-0000-0000-000000000003', 'aa150000-0000-0000-0000-00000000000a', 56.95, 24.10, 56.97, 24.15, now() + interval '1 hour');
insert into ride_offers (id, request_id, driver_id) values
  ('22222222-0a15-0000-0000-000000000003', '11111111-0a15-0000-0000-000000000003', 'ba150000-0000-0000-0000-00000000000b');
select pg_temp.as_user('aa150000-0000-0000-0000-00000000000a', $q$select ride_offer_accept('22222222-0a15-0000-0000-000000000003')$q$);
update ride_offers set trip = 'coming' where id = '22222222-0a15-0000-0000-000000000003';

-- R4: D ↔ B done, paid (B's other passenger)
insert into ride_requests (id, user_id, from_lat, from_lng, from_name, to_lat, to_lng, depart_at) values
  ('11111111-0a15-0000-0000-000000000004', 'da150000-0000-0000-0000-00000000000d', 56.95, 24.10, 'Darbs', 56.97, 24.15, now() - interval '2 days');
insert into ride_offers (id, request_id, driver_id, status) values
  ('22222222-0a15-0000-0000-000000000004', '11111111-0a15-0000-0000-000000000004', 'ba150000-0000-0000-0000-00000000000b', 'accepted');
select pg_temp.finish('22222222-0a15-0000-0000-000000000004');
select pg_temp.pay('22222222-0a15-0000-0000-000000000004', 'paid');

-- ---------- Access ----------
select pg_temp.ok('anon cannot call account_delete_check / delete_my_account',
  not has_function_privilege('anon', 'public.account_delete_check()', 'execute')
  and not has_function_privilege('anon', 'public.delete_my_account(text)', 'execute'));
select pg_temp.ok('nobody can call account_delete_blockers(uuid) for another user',
  not has_function_privilege('authenticated', 'public.account_delete_blockers(uuid)', 'execute'));
select pg_temp.ok('stranger E: nothing blocks', (pg_temp.check_as('ea150000-0000-0000-0000-00000000000e')->>'ok')::boolean);

-- ---------- Blockers ----------
select pg_temp.ok('A: active ride blocks', pg_temp.kinds(pg_temp.check_as('aa150000-0000-0000-0000-00000000000a')) = 'active_ride');
select pg_temp.ok('B (driver of the same ride): active ride blocks', pg_temp.kinds(pg_temp.check_as('ba150000-0000-0000-0000-00000000000b')) = 'active_ride');
select pg_temp.ok('A: delete_my_account refused with account_busy',
  pg_temp.as_user('aa150000-0000-0000-0000-00000000000a', 'select delete_my_account()') like 'account_busy:%');
select pg_temp.ok('A: nothing deleted after the refusal',
  exists (select 1 from profiles where id = 'aa150000-0000-0000-0000-00000000000a')
  and (select count(*) from ride_requests where user_id = 'aa150000-0000-0000-0000-00000000000a') = 3);
-- paid, then cancelled before pickup → refund due
select pg_temp.pay('22222222-0a15-0000-0000-000000000003', 'paid');
select pg_temp.as_user('aa150000-0000-0000-0000-00000000000a', $q$update ride_requests set status = 'cancelled' where id = '11111111-0a15-0000-0000-000000000003'$q$);
select pg_temp.as_user('aa150000-0000-0000-0000-00000000000a', $q$update ride_offers set status = 'declined' where id = '22222222-0a15-0000-0000-000000000003'$q$);
update ride_offers set status = 'cancelled' where id = '22222222-0a15-0000-0000-000000000003' and status = 'accepted';
select pg_temp.ok('A: cancelled before pickup, paid, not refunded → refund_due', pg_temp.kinds(pg_temp.check_as('aa150000-0000-0000-0000-00000000000a')) = 'refund_due');
select pg_temp.ok('B: the same refund blocks the driver too', pg_temp.kinds(pg_temp.check_as('ba150000-0000-0000-0000-00000000000b')) = 'refund_due');
select set_config('cz.pay_mark', 'on', true);
update ride_payments set status = 'refunded', refund_id = 're_TESTrefund0003', refunded_at = now(), refund_cents = 800
  where offer_id = '22222222-0a15-0000-0000-000000000003';
select set_config('cz.pay_mark', 'off', true);
select pg_temp.ok('after full refund: A may delete', (pg_temp.check_as('aa150000-0000-0000-0000-00000000000a')->>'ok')::boolean);
-- an open checkout session (could still be paid) blocks for 24 h
update ride_payments set created_at = now() - interval '2 hours' where offer_id = '22222222-0a15-0000-0000-000000000004';
insert into ride_requests (id, user_id, from_lat, from_lng, to_lat, to_lng, depart_at) values
  ('11111111-0a15-0000-0000-000000000005', 'da150000-0000-0000-0000-00000000000d', 56.95, 24.10, 56.97, 24.15, now() - interval '3 hours');
insert into ride_offers (id, request_id, driver_id, status) values
  ('22222222-0a15-0000-0000-000000000005', '11111111-0a15-0000-0000-000000000005', 'ca150000-0000-0000-0000-00000000000c', 'accepted');
select pg_temp.finish('22222222-0a15-0000-0000-000000000005');
insert into ride_payments (offer_id, session_id) values ('22222222-0a15-0000-0000-000000000005', 'cs_test_OPENsession0005');
select pg_temp.ok('D: open checkout session → payment_open with until',
  (select pg_temp.kinds(j) = 'payment_open' and (j->'blockers'->0->>'until') is not null from (select pg_temp.check_as('da150000-0000-0000-0000-00000000000d') j) x));
update ride_payments set created_at = now() - interval '25 hours' where offer_id = '22222222-0a15-0000-0000-000000000005';
select pg_temp.ok('D: session older than 24 h no longer blocks', (pg_temp.check_as('da150000-0000-0000-0000-00000000000d')->>'ok')::boolean);

-- ---------- Passenger A deletes the account ----------
select pg_temp.ok('A: delete_my_account succeeds', pg_temp.as_user('aa150000-0000-0000-0000-00000000000a', 'select delete_my_account()') is null);
select pg_temp.ok('A: auth user, profile and phone gone',
  not exists (select 1 from auth.users where id = 'aa150000-0000-0000-0000-00000000000a')
  and not exists (select 1 from profiles where id = 'aa150000-0000-0000-0000-00000000000a')
  and not exists (select 1 from contacts where id = 'aa150000-0000-0000-0000-00000000000a'));
select pg_temp.ok('A15: R1 stays for driver B, passenger anonymous',
  (select user_id is null from ride_requests where id = '11111111-0a15-0000-0000-000000000001')
  and (select driver_id = 'ba150000-0000-0000-0000-00000000000b' and status = 'accepted' and trip = 'done'
       from ride_offers where id = '22222222-0a15-0000-0000-000000000001'));
select pg_temp.ok('A15: payment record of R1 kept (Stripe session link)',
  (select status = 'paid' and session_id like 'cs_test_%' from ride_payments where offer_id = '22222222-0a15-0000-0000-000000000001'));
select pg_temp.ok('A15: address, note and exact coordinates removed (~1 km)',
  (select from_name = '' and to_name = '' and note = '' and from_lat = 56.95 and from_lng = 24.11 and to_lat = 56.97 and to_lng = 24.16
   from ride_requests where id = '11111111-0a15-0000-0000-000000000001'));
select pg_temp.ok('A15: last positions removed, driver''s own note kept',
  (select drv_lat is null and pas_lat is null and drv_at is null and pas_at is null and note = 'balta Škoda'
   from ride_offers where id = '22222222-0a15-0000-0000-000000000001'));
select pg_temp.ok('A15: A''s chat messages gone, B''s kept',
  (select count(*) from ride_messages where offer_id = '22222222-0a15-0000-0000-000000000001') = 1
  and (select sender from ride_messages where offer_id = '22222222-0a15-0000-0000-000000000001') = 'ba150000-0000-0000-0000-00000000000b');
select pg_temp.ok('A15: A''s rating of B kept (stars, no author, no comment), rating about A gone',
  (select count(*) from ride_ratings where offer_id = '22222222-0a15-0000-0000-000000000001') = 1
  and (select rater_id is null and rated_id = 'ba150000-0000-0000-0000-00000000000b' and stars = 5 and comment = ''
       from ride_ratings where offer_id = '22222222-0a15-0000-0000-000000000001'));
select pg_temp.ok('B''s average rating unchanged', (select avg = 5.0 and count = 1 from rating_summary(array['ba150000-0000-0000-0000-00000000000b'::uuid])));
select pg_temp.ok('A15: A''s open request without history deleted (with C''s pending offer)',
  not exists (select 1 from ride_requests where id = '11111111-0a15-0000-0000-000000000002')
  and not exists (select 1 from ride_offers where id = '22222222-0a15-0000-0000-000000000002'));
select pg_temp.ok('A15: refunded, cancelled R3 kept for B with its refund record',
  (select user_id is null and status = 'cancelled' from ride_requests where id = '11111111-0a15-0000-0000-000000000003')
  and (select status = 'refunded' from ride_payments where offer_id = '22222222-0a15-0000-0000-000000000003'));
delete from res;
select pg_temp.as_user('ba150000-0000-0000-0000-00000000000b', $q$insert into res (j) select to_jsonb(h) from my_ride_history() h where h.offer_id = '22222222-0a15-0000-0000-000000000001'$q$);
select pg_temp.ok('B''s history: ride shown, other side deleted (other_id / name null), price & payment kept',
  (select j->>'role' = 'driver' and j->>'status' = 'done' and j->>'other_id' is null and j->>'other_name' is null and j->>'pay_status' = 'paid' from res));
delete from res;
select pg_temp.as_user('ba150000-0000-0000-0000-00000000000b', $q$insert into res (j) select my_stats()$q$);
select pg_temp.ok('B''s my_stats: both done rides counted', (select (j->>'driver_done')::int = 2 from res));
select pg_temp.ok('stranger E cannot see the anonymous ride',
  pg_temp.as_user('ea150000-0000-0000-0000-00000000000e', $q$do $d$ begin if exists (select 1 from ride_requests where id = '11111111-0a15-0000-0000-000000000001') or exists (select 1 from ride_offers where id = '22222222-0a15-0000-0000-000000000001') then raise exception 'visible'; end if; end $d$$q$) is null);
-- R1 is done → the rating attempt must say "other_deleted"
delete from ride_ratings where offer_id = '22222222-0a15-0000-0000-000000000001' and rater_id = 'ba150000-0000-0000-0000-00000000000b';
select pg_temp.ok('A15: rating a deleted user → other_deleted',
  pg_temp.as_user('ba150000-0000-0000-0000-00000000000b', $q$insert into ride_ratings (offer_id, stars) values ('22222222-0a15-0000-0000-000000000001', 3)$q$) like 'other_deleted:%');
select pg_temp.ok('A15: reporting a ride with a deleted user: accepted',
  pg_temp.as_user('ba150000-0000-0000-0000-00000000000b', $q$insert into user_reports (offer_id, reason) values ('22222222-0a15-0000-0000-000000000001', 'no_show')$q$) is null);
select pg_temp.ok('A15: report stored with reported_id null',
  (select reported_id is null and reporter_id = 'ba150000-0000-0000-0000-00000000000b' from user_reports where offer_id = '22222222-0a15-0000-0000-000000000001'));
select pg_temp.ok('Stripe notifications can still mark R1 via the driver',
  ride_payment_mark('ba150000-0000-0000-0000-00000000000b', '22222222-0a15-0000-0000-000000000001', 'refunded', 're_TESTlater00001', 'stripe_dashboard', 1000));

-- ---------- Driver B deletes the account ----------
select pg_temp.ok('B: nothing blocks now', (pg_temp.check_as('ba150000-0000-0000-0000-00000000000b')->>'ok')::boolean);
select pg_temp.ok('B: delete_my_account with an unclosed Stripe account succeeds',
  pg_temp.as_user('ba150000-0000-0000-0000-00000000000b', $q$select delete_my_account('acct_TESTdriverB1')$q$) is null);
select pg_temp.ok('B: unclosed Stripe account recorded for the owner, driver account link gone',
  exists (select 1 from account_closures where acct = 'acct_TESTdriverB1')
  and not exists (select 1 from driver_accounts where user_id = 'ba150000-0000-0000-0000-00000000000b'));
select pg_temp.ok('A15: both sides of R1 / R3 deleted → rides removed completely',
  not exists (select 1 from ride_requests where id in ('11111111-0a15-0000-0000-000000000001', '11111111-0a15-0000-0000-000000000003'))
  and not exists (select 1 from ride_offers where id in ('22222222-0a15-0000-0000-000000000001', '22222222-0a15-0000-0000-000000000003'))
  and not exists (select 1 from ride_payments where offer_id in ('22222222-0a15-0000-0000-000000000001', '22222222-0a15-0000-0000-000000000003')));
select pg_temp.ok('A15: D''s ride R4 with B stays for D (driver anonymous, payment kept)',
  (select driver_id is null and trip = 'done' from ride_offers where id = '22222222-0a15-0000-0000-000000000004')
  and (select user_id = 'da150000-0000-0000-0000-00000000000d' and from_name = 'Darbs' from ride_requests where id = '11111111-0a15-0000-0000-000000000004')
  and exists (select 1 from ride_payments where offer_id = '22222222-0a15-0000-0000-000000000004'));
delete from res;
select pg_temp.as_user('da150000-0000-0000-0000-00000000000d', $q$insert into res (j) select to_jsonb(h) from my_ride_history() h where h.offer_id = '22222222-0a15-0000-0000-000000000004'$q$);
select pg_temp.ok('D''s history: role passenger, driver deleted', (select j->>'role' = 'passenger' and j->>'other_id' is null from res));
select pg_temp.ok('Stripe notifications can still mark R4 via the passenger',
  ride_payment_mark('da150000-0000-0000-0000-00000000000d', '22222222-0a15-0000-0000-000000000004', 'refunded', 're_TESTlater00004', 'stripe_dashboard', 500));

-- ---------- Owner deletes a user in the Supabase panel during a ride (no checks) ----------
insert into ride_requests (id, user_id, from_lat, from_lng, to_lat, to_lng, depart_at) values
  ('11111111-0a15-0000-0000-000000000006', 'da150000-0000-0000-0000-00000000000d', 56.95, 24.10, 56.97, 24.15, now() + interval '30 minutes');
insert into ride_offers (id, request_id, driver_id) values
  ('22222222-0a15-0000-0000-000000000006', '11111111-0a15-0000-0000-000000000006', 'ca150000-0000-0000-0000-00000000000c');
select pg_temp.as_user('da150000-0000-0000-0000-00000000000d', $q$select ride_offer_accept('22222222-0a15-0000-0000-000000000006')$q$);
delete from auth.users where id = 'ca150000-0000-0000-0000-00000000000c';
select pg_temp.ok('panel deletion of driver C: D''s accepted ride cancelled, request reopened, D keeps it',
  (select status = 'cancelled' and driver_id is null from ride_offers where id = '22222222-0a15-0000-0000-000000000006')
  and (select status = 'open' and user_id = 'da150000-0000-0000-0000-00000000000d' from ride_requests where id = '11111111-0a15-0000-0000-000000000006'));
select pg_temp.ok('panel deletion: D''s other ride R5 with C kept (driver anonymous)',
  (select driver_id is null from ride_offers where id = '22222222-0a15-0000-0000-000000000005'));

-- ---------- Anonymous account merge still moves rides (not erased) ----------
insert into auth.users (id, is_anonymous) values ('fa150000-0000-0000-0000-00000000000f', true);
insert into profiles (id, name) values ('fa150000-0000-0000-0000-00000000000f', 'Anonīmais F');
insert into ride_requests (id, user_id, from_lat, from_lng, from_name, to_lat, to_lng, depart_at) values
  ('11111111-0a15-0000-0000-000000000007', 'fa150000-0000-0000-0000-00000000000f', 56.951234, 24.10, 'Skola', 56.97, 24.15, now() + interval '2 hours');
delete from res;
select pg_temp.as_user('fa150000-0000-0000-0000-00000000000f', $q$insert into res (j) select to_jsonb(account_transfer_start())$q$);
select pg_temp.as_user('ea150000-0000-0000-0000-00000000000e', format('select account_transfer_claim(%L)', (select j #>> '{}' from res)));
select pg_temp.ok('merge: F''s request moved to E unchanged (not anonymised)',
  (select user_id = 'ea150000-0000-0000-0000-00000000000e' and from_name = 'Skola' and from_lat = 56.951234
   from ride_requests where id = '11111111-0a15-0000-0000-000000000007')
  and not exists (select 1 from auth.users where id = 'fa150000-0000-0000-0000-00000000000f'));

select pg_temp.ok('foreign keys: ON DELETE SET NULL for participants',
  (select count(*) from pg_constraint where conname in ('ride_requests_user_id_fkey', 'ride_offers_driver_id_fkey', 'ride_ratings_rater_id_fkey')
     and pg_get_constraintdef(oid) like '%ON DELETE SET NULL%') = 3);
rollback;
