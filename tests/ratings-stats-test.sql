-- Scenario test (audit 2, B17 — behaviour instead of reading the SQL text): ratings and reports about a ride (F13),
-- owner statistics (F16, F23), "helping now" counter (F15), payment status protection (F14, F17).
-- Runs against the final schema. Local copy only — never against production. All people below are made up.
\set QUIET 1
reset role;
create or replace function pg_temp.ok(n text, c boolean) returns void language plpgsql as $$ begin raise notice '%: %', case when c then 'PASS' else 'FAIL' end, n; end $$;
create or replace function pg_temp.as_role(r text, u uuid, q text) returns text language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), true); execute 'set local role ' || r; execute q; reset role; return null;
exception when others then reset role; return sqlerrm; end $$;
create temp table res (j jsonb); grant all on res to authenticated, anon, service_role;
begin;
insert into auth.users (id) values ('b17a0000-0000-0000-0000-00000000000a'), ('b17d0000-0000-0000-0000-00000000000d'),
  ('b17e0000-0000-0000-0000-00000000000e'), ('b17f0000-0000-0000-0000-00000000000f');
insert into profiles (id, name) values ('b17a0000-0000-0000-0000-00000000000a', 'Pasažiere'), ('b17d0000-0000-0000-0000-00000000000d', 'Šoferis'),
  ('b17e0000-0000-0000-0000-00000000000e', 'Svešais');
insert into ride_requests (id, user_id, from_lat, from_lng, to_lat, to_lng, depart_at) values
  ('b1711111-0000-0000-0000-000000000001', 'b17a0000-0000-0000-0000-00000000000a', 56.95, 24.10, 56.97, 24.15, now() + interval '1 hour');
select pg_temp.as_role('authenticated', 'b17d0000-0000-0000-0000-00000000000d',
  $q$insert into ride_offers (id, request_id, driver_id, eta_min) values ('b1722222-0000-0000-0000-000000000001', 'b1711111-0000-0000-0000-000000000001', 'b17d0000-0000-0000-0000-00000000000d', 5)$q$);
select pg_temp.as_role('authenticated', 'b17a0000-0000-0000-0000-00000000000a', $q$select ride_offer_accept('b1722222-0000-0000-0000-000000000001')$q$);

-- ---------- F12: response time is set by the database ----------
select pg_temp.ok('F12: accepting sets responded_at on the server', (select responded_at is not null from ride_offers where id = 'b1722222-0000-0000-0000-000000000001'));

-- ---------- F13: rating only after a finished ride, only by its two people, once, 1–5 stars, ≤ 200 chars ----------
select pg_temp.ok('F13: cannot rate before the ride is finished',
  pg_temp.as_role('authenticated', 'b17a0000-0000-0000-0000-00000000000a', $q$insert into ride_ratings (offer_id, stars) values ('b1722222-0000-0000-0000-000000000001', 5)$q$) like '%pabeigtu%');
select pg_temp.as_role('authenticated', 'b17d0000-0000-0000-0000-00000000000d', format('select ride_driver_update(%L, %L, 56.95, 24.10, 90)', 'b1722222-0000-0000-0000-000000000001', t))
  from unnest(array['coming', 'arrived', 'onboard', 'done']) t;
select pg_temp.ok('… ride finished (trip done)', (select trip = 'done' from ride_offers where id = 'b1722222-0000-0000-0000-000000000001'));
select pg_temp.ok('F13: a stranger cannot rate the ride',
  pg_temp.as_role('authenticated', 'b17e0000-0000-0000-0000-00000000000e', $q$insert into ride_ratings (offer_id, stars) values ('b1722222-0000-0000-0000-000000000001', 1)$q$) like '%dalībnieks%');
select pg_temp.ok('F13: stars outside 1–5 are refused',
  pg_temp.as_role('authenticated', 'b17a0000-0000-0000-0000-00000000000a', $q$insert into ride_ratings (offer_id, stars) values ('b1722222-0000-0000-0000-000000000001', 6)$q$) is not null);
select pg_temp.ok('F13: comment longer than 200 characters is refused',
  pg_temp.as_role('authenticated', 'b17a0000-0000-0000-0000-00000000000a', format($q$insert into ride_ratings (offer_id, stars, comment) values ('b1722222-0000-0000-0000-000000000001', 4, %L)$q$, repeat('x', 201))) is not null);
select pg_temp.ok('F13: passenger rates the driver',
  pg_temp.as_role('authenticated', 'b17a0000-0000-0000-0000-00000000000a', $q$insert into ride_ratings (offer_id, stars, rated_id, rater_id) values ('b1722222-0000-0000-0000-000000000001', 5, 'b17e0000-0000-0000-0000-00000000000e', 'b17e0000-0000-0000-0000-00000000000e')$q$) is null);
select pg_temp.ok('F13: … the server fills who rated whom (the app sent someone else)',
  (select rated_id = 'b17d0000-0000-0000-0000-00000000000d' and rater_id = 'b17a0000-0000-0000-0000-00000000000a' from ride_ratings where offer_id = 'b1722222-0000-0000-0000-000000000001'));
select pg_temp.ok('F13: one rating per person per ride',
  pg_temp.as_role('authenticated', 'b17a0000-0000-0000-0000-00000000000a', $q$insert into ride_ratings (offer_id, stars) values ('b1722222-0000-0000-0000-000000000001', 3)$q$) is not null);
select pg_temp.ok('F13: the driver rates the passenger',
  pg_temp.as_role('authenticated', 'b17d0000-0000-0000-0000-00000000000d', $q$insert into ride_ratings (offer_id, stars) values ('b1722222-0000-0000-0000-000000000001', 4)$q$) is null);
select pg_temp.ok('F13: … two ratings for the ride',
  (select count(*) = 2 from ride_ratings where offer_id = 'b1722222-0000-0000-0000-000000000001'));

-- ---------- F13: report about a ride — only its people, about the other one, ≤ 10 a day ----------
select pg_temp.ok('F13: a stranger cannot report about the ride',
  pg_temp.as_role('authenticated', 'b17e0000-0000-0000-0000-00000000000e', $q$insert into user_reports (offer_id, reason) values ('b1722222-0000-0000-0000-000000000001', 'other')$q$) like '%dalībnieks%');
select pg_temp.ok('F13: passenger reports about the ride',
  pg_temp.as_role('authenticated', 'b17a0000-0000-0000-0000-00000000000a', $q$insert into user_reports (offer_id, reason, reported_id) values ('b1722222-0000-0000-0000-000000000001', 'other', 'b17e0000-0000-0000-0000-00000000000e')$q$) is null);
select pg_temp.ok('F13: … reported is the driver (filled by the server, not the app)',
  (select reported_id = 'b17d0000-0000-0000-0000-00000000000d' and status = 'new' from user_reports where reporter_id = 'b17a0000-0000-0000-0000-00000000000a'));
select pg_temp.as_role('authenticated', 'b17a0000-0000-0000-0000-00000000000a', $q$insert into user_reports (offer_id, reason) values ('b1722222-0000-0000-0000-000000000001', 'other')$q$) from generate_series(2, 10);
select pg_temp.ok('F13: 10 reports a day are accepted', (select count(*) = 10 from user_reports where reporter_id = 'b17a0000-0000-0000-0000-00000000000a'));
select pg_temp.ok('F13: the 11th report within a day is refused',
  pg_temp.as_role('authenticated', 'b17a0000-0000-0000-0000-00000000000a', $q$insert into user_reports (offer_id, reason) values ('b1722222-0000-0000-0000-000000000001', 'other')$q$) like '%Pārāk daudz%');
select pg_temp.ok('F13: a person cannot read reports about them',
  coalesce(pg_temp.as_role('authenticated', 'b17d0000-0000-0000-0000-00000000000d', $q$do $d$ begin if (select count(*) from user_reports) <> 0 then raise exception 'visible'; end if; end $d$$q$), 'permission denied') like '%permission denied%');

-- ---------- F16 / F23: owner statistics only for the owner; my_stats — only my own numbers ----------
select pg_temp.ok('F16: without an account — no statistics',
  pg_temp.as_role('anon', null, 'select admin_stats()') like '%permission denied%' and pg_temp.as_role('anon', null, 'select my_stats()') like '%permission denied%');
select pg_temp.ok('F16: a normal account cannot see owner statistics',
  pg_temp.as_role('authenticated', 'b17a0000-0000-0000-0000-00000000000a', 'select admin_stats()') like '%forbidden%');
insert into app_admins (user_id) values ('b17f0000-0000-0000-0000-00000000000f');
select pg_temp.ok('F16: the owner can',
  pg_temp.as_role('authenticated', 'b17f0000-0000-0000-0000-00000000000f', 'insert into res select admin_stats()') is null);
select pg_temp.ok('F16: … and gets the numbers', (select count(*) = 1 and bool_and(j ? 'requests') from res));
select pg_temp.ok('F16: accounts cannot read or add owners themselves',
  coalesce(pg_temp.as_role('authenticated', 'b17a0000-0000-0000-0000-00000000000a', $q$do $d$ begin if (select count(*) from app_admins) <> 0 then raise exception 'visible'; end if; end $d$$q$), 'permission denied') like '%permission denied%'
  and pg_temp.as_role('authenticated', 'b17a0000-0000-0000-0000-00000000000a', $q$insert into app_admins (user_id) values ('b17a0000-0000-0000-0000-00000000000a')$q$) is not null);
delete from res;
select pg_temp.as_role('authenticated', 'b17d0000-0000-0000-0000-00000000000d', 'insert into res select my_stats()');
select pg_temp.ok('F23: my_stats — the driver sees their own finished ride', (select (j->>'driver_done')::int = 1 and (j->>'passenger_done')::int = 0 from res));

-- ---------- F15: "helping now" — only a number, without an account too, only the last 15 minutes ----------
insert into traffic_quota (uid, window_start, n, last_at) values
  ('b17a0000-0000-0000-0000-00000000000a', now(), 1, now() - interval '5 minutes'),
  ('b17d0000-0000-0000-0000-00000000000d', now(), 1, now() - interval '20 minutes');
delete from res;
select pg_temp.ok('F15: readable without an account', pg_temp.as_role('anon', null, $q$insert into res select to_jsonb(traffic_helpers())$q$) is null);
select pg_temp.ok('F15: counts who sent data in the last 15 minutes', (select (j #>> '{}')::int = 1 from res));
select pg_temp.ok('F15: who they are is not readable',
  coalesce(pg_temp.as_role('anon', null, $q$do $d$ begin if (select count(*) from traffic_quota) <> 0 then raise exception 'visible'; end if; end $d$$q$), 'permission denied') like '%permission denied%');

-- ---------- F14 / F17: payment status — only the server (service_role) via ride_payment_mark ----------
insert into ride_payments (offer_id, session_id) values ('b1722222-0000-0000-0000-000000000001', 'cs_test_b17b17b17b17');
select pg_temp.as_role('authenticated', 'b17a0000-0000-0000-0000-00000000000a', $q$update ride_payments set status = 'paid'$q$);
select pg_temp.ok('F14: the app cannot change a payment status directly',
  (select status = 'created' from ride_payments where offer_id = 'b1722222-0000-0000-0000-000000000001'));
select pg_temp.ok('F17: the app cannot call ride_payment_mark',
  pg_temp.as_role('authenticated', 'b17a0000-0000-0000-0000-00000000000a', $q$select ride_payment_mark('b17a0000-0000-0000-0000-00000000000a', 'b1722222-0000-0000-0000-000000000001', 'paid')$q$) like '%permission denied%');
select pg_temp.ok('F17: the server — only for a person of this ride',
  pg_temp.as_role('service_role', null, $q$select ride_payment_mark('b17e0000-0000-0000-0000-00000000000e', 'b1722222-0000-0000-0000-000000000001', 'paid')$q$) like '%nav atrasts%');
select pg_temp.ok('F17: the server marks it paid',
  pg_temp.as_role('service_role', null, $q$select ride_payment_mark('b17a0000-0000-0000-0000-00000000000a', 'b1722222-0000-0000-0000-000000000001', 'paid')$q$) is null);
select pg_temp.ok('F17: … status paid',
  (select status = 'paid' from ride_payments where offer_id = 'b1722222-0000-0000-0000-000000000001'));
select pg_temp.ok('F17: a paid payment keeps its checkout session',
  pg_temp.as_role('service_role', null, $q$update ride_payments set session_id = 'cs_other' where offer_id = 'b1722222-0000-0000-0000-000000000001'$q$) like '%Samaksātu%');
select pg_temp.ok('F14: refund needs Stripe refund data; then refunded with reason',
  pg_temp.as_role('service_role', null, $q$select ride_payment_mark('b17d0000-0000-0000-0000-00000000000d', 'b1722222-0000-0000-0000-000000000001', 'refunded')$q$) like '%Trūkst%'
  and pg_temp.as_role('service_role', null, $q$select ride_payment_mark('b17d0000-0000-0000-0000-00000000000d', 'b1722222-0000-0000-0000-000000000001', 'refunded', 're_test123', 'driver_refund', 300)$q$) is null);
select pg_temp.ok('F14: … refunded with reason, amount and time',
  (select status = 'refunded' and refund_reason = 'driver_refund' and refund_cents = 300 and refunded_at is not null from ride_payments where offer_id = 'b1722222-0000-0000-0000-000000000001'));
select pg_temp.ok('F14: an unknown refund reason is refused',
  pg_temp.as_role('service_role', null, $q$select ride_payment_mark('b17d0000-0000-0000-0000-00000000000d', 'b1722222-0000-0000-0000-000000000001', 'refunded', 're_test456', 'because', 100)$q$) is not null);
select pg_temp.ok('F19: payment events (Stripe webhook) are not readable by the app',
  pg_temp.as_role('authenticated', 'b17a0000-0000-0000-0000-00000000000a', 'select count(*) from stripe_events') like '%permission denied%'
  and pg_temp.as_role('anon', null, 'select count(*) from stripe_events') like '%permission denied%');
rollback;
