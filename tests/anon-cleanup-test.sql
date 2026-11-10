-- Scenario test for supabase/account-2-anon-cleanup.sql (audit 2, B07). Local copy only — never against production.
-- One transaction, rolled back. Prints PASS / FAIL.
\set QUIET 1
reset role;
create or replace function pg_temp.ok(n text, c boolean) returns void language plpgsql as $$ begin raise notice '%: %', case when c then 'PASS' else 'FAIL' end, n; end $$;
create or replace function pg_temp.gone(u uuid) returns boolean language sql as $$ select not exists (select 1 from auth.users where id = u) $$;

begin;
-- O1 old anon, no session            → deleted (also profile + contacts)
-- O2 old anon, session refreshed 10 d → kept
-- O3 old anon, session updated 5 d    → kept
-- O4 old anon, session refreshed 200 d → deleted
-- N1 anon created 10 d ago            → kept
-- E1 old account with e-mail          → kept
-- D1 old anon with Stripe account     → skipped
-- R1 old anon passenger, ride under way → skipped (and the driver K1 is untouched)
insert into auth.users (id, is_anonymous, email, created_at, last_sign_in_at) values
  ('b0700000-0000-0000-0000-0000000000a1', true,  null, now() - interval '400 days', now() - interval '400 days'),
  ('b0700000-0000-0000-0000-0000000000a2', true,  null, now() - interval '400 days', now() - interval '400 days'),
  ('b0700000-0000-0000-0000-0000000000a3', true,  null, now() - interval '400 days', now() - interval '400 days'),
  ('b0700000-0000-0000-0000-0000000000a4', true,  null, now() - interval '400 days', now() - interval '400 days'),
  ('b0700000-0000-0000-0000-0000000000b1', true,  null, now() - interval '10 days',  now() - interval '10 days'),
  ('b0700000-0000-0000-0000-0000000000c1', false, 'someone@example.org', now() - interval '400 days', now() - interval '400 days'),
  ('b0700000-0000-0000-0000-0000000000d1', true,  null, now() - interval '400 days', now() - interval '400 days'),
  ('b0700000-0000-0000-0000-0000000000e1', true,  null, now() - interval '400 days', now() - interval '400 days'),
  ('b0700000-0000-0000-0000-0000000000f1', false, 'driver@example.org', now() - interval '400 days', now() - interval '1 day');
insert into auth.sessions (user_id, created_at, updated_at, refreshed_at) values
  ('b0700000-0000-0000-0000-0000000000a2', now() - interval '300 days', now() - interval '300 days', (now() - interval '10 days') at time zone 'UTC'),
  ('b0700000-0000-0000-0000-0000000000a3', now() - interval '300 days', now() - interval '5 days', null),
  ('b0700000-0000-0000-0000-0000000000a4', now() - interval '300 days', now() - interval '300 days', (now() - interval '200 days') at time zone 'UTC');
insert into profiles (id, name) values ('b0700000-0000-0000-0000-0000000000a1', 'Vecais anonīmais'),
  ('b0700000-0000-0000-0000-0000000000e1', 'Pasažieris R'), ('b0700000-0000-0000-0000-0000000000f1', 'Šoferis K'),
  ('b0700000-0000-0000-0000-0000000000d1', 'Šoferis D');
insert into contacts (id, phone) values ('b0700000-0000-0000-0000-0000000000a1', '+37120000071');
insert into driver_accounts (user_id, acct) values ('b0700000-0000-0000-0000-0000000000d1', 'acct_TESTb07d1');
insert into ride_requests (id, user_id, from_lat, from_lng, to_lat, to_lng, depart_at, status) values
  ('b0711111-0000-0000-0000-000000000001', 'b0700000-0000-0000-0000-0000000000e1', 56.95, 24.1, 56.97, 24.15, now() + interval '1 hour', 'matched');
insert into ride_offers (id, request_id, driver_id, status) values
  ('b0722222-0000-0000-0000-000000000001', 'b0711111-0000-0000-0000-000000000001', 'b0700000-0000-0000-0000-0000000000f1', 'accepted');

do $$ begin
  perform public.cz_anon_cleanup(30);
  raise notice 'FAIL: B07: p_days < 90 must raise';
exception when others then raise notice 'PASS: B07: p_days < 90 raises (%)', sqlerrm;
end $$;

create temp table r as select public.cz_anon_cleanup() as j;
select pg_temp.ok('B07: result — 2 deleted, 2 skipped, no errors',
  (select (j->>'deleted')::int = 2 and (j->>'skipped')::int = 2 and (j->>'ok')::boolean from r));
select pg_temp.ok('B07: idle anonymous accounts deleted (no session / session older than 180 d)',
  pg_temp.gone('b0700000-0000-0000-0000-0000000000a1') and pg_temp.gone('b0700000-0000-0000-0000-0000000000a4'));
select pg_temp.ok('B07: their data is gone too (profile, phone, sessions)',
  not exists (select 1 from profiles where id = 'b0700000-0000-0000-0000-0000000000a1')
  and not exists (select 1 from contacts where id = 'b0700000-0000-0000-0000-0000000000a1')
  and not exists (select 1 from auth.sessions where user_id = 'b0700000-0000-0000-0000-0000000000a4'));
select pg_temp.ok('B07: recently refreshed / updated sessions keep the account',
  not pg_temp.gone('b0700000-0000-0000-0000-0000000000a2') and not pg_temp.gone('b0700000-0000-0000-0000-0000000000a3'));
select pg_temp.ok('B07: new anonymous and e-mail accounts are kept',
  not pg_temp.gone('b0700000-0000-0000-0000-0000000000b1') and not pg_temp.gone('b0700000-0000-0000-0000-0000000000c1'));
select pg_temp.ok('B07: Stripe driver account and active ride are skipped',
  not pg_temp.gone('b0700000-0000-0000-0000-0000000000d1') and not pg_temp.gone('b0700000-0000-0000-0000-0000000000e1')
  and (select status from ride_offers where id = 'b0722222-0000-0000-0000-000000000001') = 'accepted');
select pg_temp.ok('B07: run is logged for admin (cz_cleanup_runs)',
  exists (select 1 from cz_cleanup_runs where ok and deleted = '{"anon_accounts": 2, "anon_skipped": 2}'::jsonb));
select pg_temp.ok('B07: second run deletes nothing more', (public.cz_anon_cleanup()->>'deleted')::int = 0);
select pg_temp.ok('B07: nightly job scheduled', exists (select 1 from cron.job where jobname = 'cz-anon-cleanup' and schedule = '23 2 * * *' and active));
select pg_temp.ok('B07: app roles cannot call cleanup or erase',
  not has_function_privilege('anon', 'public.cz_anon_cleanup(int, int)', 'execute')
  and not has_function_privilege('authenticated', 'public.cz_anon_cleanup(int, int)', 'execute')
  and not has_function_privilege('authenticated', 'public.account_erase(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.delete_my_account(text)', 'execute'));
rollback;
