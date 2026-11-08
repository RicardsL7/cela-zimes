-- Scenario test for supabase/cleanup-1.sql (audit A11). Local copy only — never against production.
-- Run after the full schema and cleanup-1.sql. Prints PASS / FAIL. Everything happens in one transaction (rollback).
\set QUIET 1
reset role;
create or replace function pg_temp.ok(n text, c boolean) returns void language plpgsql as $$ begin raise notice '%: %', case when c then 'PASS' else 'FAIL' end, n; end $$;
-- Run a query as a role (authenticated with auth.uid() = u, or anon when u is null). Returns null or the error text.
create or replace function pg_temp.as_role(u uuid, q text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
  if u is null then set local role anon; else set local role authenticated; end if;
  execute q;
  reset role;
  return null;
exception when others then
  reset role;
  return sqlerrm;
end $$;
create or replace function pg_temp.json_as(u uuid, q text) returns jsonb language plpgsql as $$
declare j jsonb;
begin
  perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
  if u is null then set local role anon; else set local role authenticated; end if;
  execute q into j;
  reset role;
  return j;
end $$;

begin;
insert into auth.users (id) values ('a1100000-0000-0000-0000-00000000000a'), ('a1100000-0000-0000-0000-00000000000b'),
                                   ('a1100000-0000-0000-0000-0000000000ad');
insert into profiles (id, name) values ('a1100000-0000-0000-0000-00000000000a', 'Tīrīšana A');
insert into app_admins (user_id) values ('a1100000-0000-0000-0000-0000000000ad');

-- Old (expired) and fresh rows in every table with a retention period
insert into reports (id, user_id, type, lat, lng, expires_at) values
  ('a1110000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-00000000000a', 'police', 56.95, 24.10, now() - interval '3 days'),
  ('a1110000-0000-0000-0000-000000000002', 'a1100000-0000-0000-0000-00000000000a', 'police', 56.95, 24.10, now() - interval '1 day'),
  ('a1110000-0000-0000-0000-000000000003', 'a1100000-0000-0000-0000-00000000000a', 'police', 56.95, 24.10, now() + interval '1 hour');
insert into report_votes (report_id, user_id, vote, lat, lng, speed_kmh) values
  ('a1110000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-00000000000b', 'still', 56.95, 24.10, 50),
  ('a1110000-0000-0000-0000-000000000003', 'a1100000-0000-0000-0000-00000000000b', 'still', 56.95, 24.10, 50);
insert into traffic_samples (cell, dir, kmh, at) values ('1_1', 0, 40, now() - interval '29 days'), ('1_1', 0, 40, now() - interval '27 days');
insert into traffic_quota (uid, window_start, n) values ('a1100000-0000-0000-0000-00000000000a', now() - interval '2 days', 3),
                                                        ('a1100000-0000-0000-0000-00000000000b', now() - interval '10 minutes', 3);
insert into user_presence (user_id, lat, lng, updated_at) values ('a1100000-0000-0000-0000-00000000000a', 56.95, 24.10, now() - interval '6 minutes'),
                                                                 ('a1100000-0000-0000-0000-00000000000b', 56.95, 24.10, now() - interval '1 minute');
insert into account_transfers (code_hash, from_user, expires_at) values ('test-old', 'a1100000-0000-0000-0000-00000000000a', now() - interval '1 minute'),
                                                                        ('test-new', 'a1100000-0000-0000-0000-00000000000b', now() + interval '1 hour');
insert into stripe_events (id, type, created_at) values ('evt_TESTold000001', 'checkout.session.completed', now() - interval '91 days'),
                                                        ('evt_TESTnew000001', 'checkout.session.completed', now() - interval '1 day');
insert into ride_requests (id, user_id, from_lat, from_lng, to_lat, to_lng, depart_at) values
  ('a1120000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-00000000000a', 56.95, 24.10, 56.97, 24.15, now() - interval '2 hours'),
  ('a1120000-0000-0000-0000-000000000002', 'a1100000-0000-0000-0000-00000000000a', 56.95, 24.10, 56.97, 24.15, now() + interval '2 hours');
insert into cron.job_run_details (jobid, status, start_time, end_time) values (1, 'succeeded', now() - interval '8 days', now() - interval '8 days'),
                                                                               (1, 'succeeded', now() - interval '1 day', now() - interval '1 day');
insert into cz_cleanup_runs (started_at, finished_at, ok) values (now() - interval '8 days', now() - interval '8 days', true);

-- ---------- The cleanup itself ----------
create temp table r as select public.cz_cleanup() j;
select pg_temp.ok('cz_cleanup: ok, no errors', (select (j->>'ok')::boolean and jsonb_array_length(j->'errors') = 0 from r));
select pg_temp.ok('reports: expired > 2 days ago deleted', not exists (select 1 from reports where id = 'a1110000-0000-0000-0000-000000000001'));
select pg_temp.ok('reports: expired < 2 days ago kept', exists (select 1 from reports where id = 'a1110000-0000-0000-0000-000000000002'));
select pg_temp.ok('reports: active kept', exists (select 1 from reports where id = 'a1110000-0000-0000-0000-000000000003'));
select pg_temp.ok('report_votes (location, speed) of a deleted report deleted too', not exists (select 1 from report_votes where report_id = 'a1110000-0000-0000-0000-000000000001'));
select pg_temp.ok('report_votes of an active report kept', exists (select 1 from report_votes where report_id = 'a1110000-0000-0000-0000-000000000003'));
select pg_temp.ok('traffic_samples: > 28 days deleted, newer kept', (select count(*) from traffic_samples where cell = '1_1') = 1
  and not exists (select 1 from traffic_samples where cell = '1_1' and at < now() - interval '28 days'));
select pg_temp.ok('traffic_quota: > 1 day deleted, recent kept', not exists (select 1 from traffic_quota where uid = 'a1100000-0000-0000-0000-00000000000a')
  and exists (select 1 from traffic_quota where uid = 'a1100000-0000-0000-0000-00000000000b'));
select pg_temp.ok('user_presence: > 5 min without update deleted, live kept', not exists (select 1 from user_presence where user_id = 'a1100000-0000-0000-0000-00000000000a')
  and exists (select 1 from user_presence where user_id = 'a1100000-0000-0000-0000-00000000000b'));
select pg_temp.ok('account_transfers: expired codes deleted, valid kept', not exists (select 1 from account_transfers where code_hash = 'test-old')
  and exists (select 1 from account_transfers where code_hash = 'test-new'));
select pg_temp.ok('stripe_events: > 90 days deleted, recent kept', not exists (select 1 from stripe_events where id = 'evt_TESTold000001')
  and exists (select 1 from stripe_events where id = 'evt_TESTnew000001'));
select pg_temp.ok('ride_expire: departed unanswered request cancelled, future one open',
  (select status from ride_requests where id = 'a1120000-0000-0000-0000-000000000001') = 'cancelled'
  and (select status from ride_requests where id = 'a1120000-0000-0000-0000-000000000002') = 'open');
select pg_temp.ok('cron history: > 7 days deleted, recent kept', (select count(*) from cron.job_run_details where jobid = 1) = 1
  and not exists (select 1 from cron.job_run_details where end_time < now() - interval '7 days'));
select pg_temp.ok('run logged: ok, finished, counts', exists (select 1 from cz_cleanup_runs where ok and finished_at is not null
  and (deleted->>'reports')::int >= 1 and (deleted->>'user_presence')::int >= 1 and (deleted->>'traffic_samples')::int >= 1));
select pg_temp.ok('run log older than 7 days removed', not exists (select 1 from cz_cleanup_runs where started_at < now() - interval '7 days'));
select pg_temp.ok('second run immediately: ok, nothing more to delete', (select (j->>'ok')::boolean and (j->'deleted'->>'reports')::int = 0 and (j->'deleted'->>'user_presence')::int = 0 from (select public.cz_cleanup() j) x));

-- ---------- Scheduler ----------
select pg_temp.ok('pg_cron job cz-cleanup every 5 minutes runs cz_cleanup()', exists (select 1 from cron.job where jobname = 'cz-cleanup'
  and schedule = '*/5 * * * *' and command = 'select public.cz_cleanup()' and active));
select pg_temp.ok('re-running the file did not duplicate the job', (select count(*) from cron.job where jobname = 'cz-cleanup') = 1);

-- ---------- Who can do what ----------
select pg_temp.ok('anon cannot run cz_cleanup', pg_temp.as_role(null, 'select public.cz_cleanup()') is not null);
select pg_temp.ok('a user cannot run cz_cleanup', pg_temp.as_role('a1100000-0000-0000-0000-00000000000a', 'select public.cz_cleanup()') is not null);
select pg_temp.ok('a user cannot read cz_cleanup_runs', pg_temp.as_role('a1100000-0000-0000-0000-00000000000a', 'select count(*) from public.cz_cleanup_runs') is not null);
select pg_temp.ok('anon cannot read cz_cleanup_runs', pg_temp.as_role(null, 'select count(*) from public.cz_cleanup_runs') is not null);
select pg_temp.ok('a non-admin gets forbidden from cz_cleanup_status', pg_temp.as_role('a1100000-0000-0000-0000-00000000000a', 'select public.cz_cleanup_status()') like '%forbidden%');
select pg_temp.ok('anon cannot call cz_cleanup_status', pg_temp.as_role(null, 'select public.cz_cleanup_status()') is not null);
select pg_temp.ok('admin: status healthy, scheduled, last run ok, 24 h counts',
  (select (j->>'healthy')::boolean and (j->>'scheduled')::boolean and (j->>'last_ok')::boolean and j->>'schedule' = '*/5 * * * *'
          and (j->>'runs_24h')::int >= 2 and (j->'deleted_24h'->>'reports')::int >= 1
   from (select pg_temp.json_as('a1100000-0000-0000-0000-0000000000ad', 'select public.cz_cleanup_status()') j) x));
select pg_temp.ok('anon: cz_health says cleanup works (no data in the answer)',
  (select (j->>'cleanup_ok')::boolean and (j->>'cleanup_minutes')::int = 0 and (select count(*) from jsonb_object_keys(j)) = 2
   from (select pg_temp.json_as(null, 'select public.cz_health()') j) x));

-- ---------- A failing step does not stop the others and is reported ----------
savepoint broken;
alter table traffic_quota rename to traffic_quota_moved;
insert into user_presence (user_id, lat, lng, updated_at) values ('a1100000-0000-0000-0000-00000000000a', 56.95, 24.10, now() - interval '6 minutes');
create temp table r2 as select public.cz_cleanup() j;
select pg_temp.ok('failing step: ok = false, error names the step', (select not (j->>'ok')::boolean and (j->'errors'->>0) like 'traffic_quota:%' from r2));
select pg_temp.ok('failing step: other steps still ran', not exists (select 1 from user_presence where user_id = 'a1100000-0000-0000-0000-00000000000a'));
select pg_temp.ok('failing step: logged with the error', exists (select 1 from cz_cleanup_runs where not ok and errors like 'traffic_quota:%' and finished_at is not null));
select pg_temp.ok('admin status shows the last error, still healthy (a good run < 20 min ago)',
  (select not (j->>'last_ok')::boolean and j->>'last_errors' like 'traffic_quota:%' and (j->>'failed_24h')::int = 1 and (j->>'healthy')::boolean
   from (select pg_temp.json_as('a1100000-0000-0000-0000-0000000000ad', 'select public.cz_cleanup_status()') j) x));
rollback to savepoint broken;

-- ---------- Alert: no good run for > 20 minutes / not scheduled ----------
update cz_cleanup_runs set finished_at = now() - interval '1 hour', started_at = now() - interval '1 hour';
select pg_temp.ok('no good run for 1 h: cz_health cleanup_ok = false', (select not (j->>'cleanup_ok')::boolean and (j->>'cleanup_minutes')::int >= 59
  from (select pg_temp.json_as(null, 'select public.cz_health()') j) x));
select pg_temp.ok('no good run for 1 h: admin status not healthy', (select not (j->>'healthy')::boolean
  from (select pg_temp.json_as('a1100000-0000-0000-0000-0000000000ad', 'select public.cz_cleanup_status()') j) x));
select public.cz_cleanup();
select cron.unschedule('cz-cleanup');
select pg_temp.ok('job removed: admin status not scheduled, not healthy', (select not (j->>'scheduled')::boolean and not (j->>'healthy')::boolean
  from (select pg_temp.json_as('a1100000-0000-0000-0000-0000000000ad', 'select public.cz_cleanup_status()') j) x));
delete from cz_cleanup_runs;
select pg_temp.ok('never ran: cz_health cleanup_ok = false', (select not (j->>'cleanup_ok')::boolean and j->'cleanup_minutes' = 'null'::jsonb
  from (select pg_temp.json_as(null, 'select public.cz_health()') j) x));
rollback;
