-- Scenario test for supabase/radars-2-votes.sql (audit 2, B08). Local copy only — never against production.
-- One transaction, rolled back. Prints PASS / FAIL.
\set QUIET 1
reset role;
create or replace function pg_temp.ok(n text, c boolean) returns void language plpgsql as $$ begin raise notice '%: %', case when c then 'PASS' else 'FAIL' end, n; end $$;
-- Runs q as the given role/user; returns the error text or null
create or replace function pg_temp.as_user(u uuid, q text, r text default 'authenticated') returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
  execute 'set local role ' || r;
  execute q;
  reset role;
  return null;
exception when others then
  reset role;
  return sqlerrm;
end $$;
create temp table res (n int);
grant all on res to authenticated, anon;
create or replace function pg_temp.last() returns int language sql as $$ select n from res order by ctid desc limit 1 $$;
create or replace function pg_temp.item(id text, lat float8 default 56.95, lng float8 default 24.1) returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'v', 'regulatory--speed-camera--g1', 'lat', lat, 'lng', lng) $$;

begin;
insert into auth.users (id, is_anonymous) values
  ('b0800000-0000-0000-0000-0000000000a1', true), ('b0800000-0000-0000-0000-0000000000a2', true),
  ('b0800000-0000-0000-0000-0000000000a3', true), ('b0800000-0000-0000-0000-0000000000a4', true);
delete from radar_signs where mly_id like '9080%';

-- 1) Without an account nothing works (anon has no execute right; authenticated without sub is refused)
select pg_temp.ok('B08: anon cannot call radar_report / radar_bad',
  pg_temp.as_user(null, $q$select radar_report('[{"id":"908000000001","v":"regulatory--speed-camera--g1","lat":56.95,"lng":24.1}]')$q$, 'anon') ~ 'permission denied'
  and pg_temp.as_user(null, $q$select radar_bad(array['908000000001'])$q$, 'anon') ~ 'permission denied');
select pg_temp.ok('B08: without a user id radar_report is refused',
  pg_temp.as_user(null, $q$select radar_report('[{"id":"908000000001","v":"regulatory--speed-camera--g1","lat":56.95,"lng":24.1}]')$q$) ~ 'pieteikšanās');
select pg_temp.ok('B08: anon can still read radar_list',
  pg_temp.as_user(null, 'select count(*) from radar_list()', 'anon') is null);
select pg_temp.ok('B08: radar_votes table is not readable by the app',
  pg_temp.as_user('b0800000-0000-0000-0000-0000000000a1', 'select count(*) from radar_votes') ~ 'permission denied'
  and pg_temp.as_user(null, 'select count(*) from radar_votes', 'anon') ~ 'permission denied');

-- 2) Report: a new radar, the same user again does not raise "good", another user does
select pg_temp.as_user('b0800000-0000-0000-0000-0000000000a1',
  $q$insert into res select radar_report(jsonb_build_array(pg_temp.item('908000000001'), pg_temp.item('908000000001')))$q$);
select pg_temp.ok('B08: new radar added once (duplicate in one request ignored)',
  pg_temp.last() = 1 and (select good from radar_signs where mly_id = '908000000001') = 1);
select pg_temp.as_user('b0800000-0000-0000-0000-0000000000a1', $q$insert into res select radar_report(jsonb_build_array(pg_temp.item('908000000001')))$q$);
select pg_temp.ok('B08: same account again — good stays 1 (only last_seen refreshed)',
  (select good from radar_signs where mly_id = '908000000001') = 1);
select pg_temp.as_user('b0800000-0000-0000-0000-0000000000a2', $q$insert into res select radar_report(jsonb_build_array(pg_temp.item('908000000001')))$q$);
select pg_temp.ok('B08: another account — good 2',
  (select good from radar_signs where mly_id = '908000000001') = 2);
select pg_temp.ok('B08: stats count only the new radar (F16)',
  (select n from user_stat_counters where user_id = 'b0800000-0000-0000-0000-0000000000a1' and kind = 'radars') = 1
  and not exists (select 1 from user_stat_counters where user_id = 'b0800000-0000-0000-0000-0000000000a2' and kind = 'radars'));

-- 3) "Not a radar": one vote per account; unknown ids do nothing
select pg_temp.as_user('b0800000-0000-0000-0000-0000000000a3', $q$insert into res select radar_bad(array['908000000001','908000000001','908000000001','908099999999','x'])$q$);
select pg_temp.as_user('b0800000-0000-0000-0000-0000000000a3', $q$insert into res select radar_bad(array['908000000001'])$q$);
select pg_temp.ok('B08: the same account votes "bad" only once (was unlimited)',
  (select bad from radar_signs where mly_id = '908000000001') = 1 and pg_temp.last() = 0);
select pg_temp.ok('B08: unknown radar id is not stored',
  not exists (select 1 from radar_votes where mly_id = '908099999999'));
select pg_temp.as_user('b0800000-0000-0000-0000-0000000000a4', $q$insert into res select radar_bad(array['908000000001'])$q$);
select pg_temp.as_user('b0800000-0000-0000-0000-0000000000a1', $q$insert into res select radar_bad(array['908000000001'])$q$);
select pg_temp.ok('B08: three different accounts → bad 3; radar still listed while good > bad × 2 is false → hidden',
  (select bad from radar_signs where mly_id = '908000000001') = 3
  and not exists (select 1 from radar_list() where mly_id = '908000000001'));

-- 4) Limits: ≤ 100 new radars per account per day, ≤ 120 reports per hour, ≤ 100 "bad" per hour
insert into radar_votes (mly_id, user_id, kind, created, at)
  select 'x' || g, 'b0800000-0000-0000-0000-0000000000a2', 'g', true, now() - interval '2 hours' from generate_series(1, 99) g;
select pg_temp.as_user('b0800000-0000-0000-0000-0000000000a2',
  $q$insert into res select radar_report(jsonb_build_array(pg_temp.item('908000000101'), pg_temp.item('908000000102'), pg_temp.item('908000000001')))$q$);
select pg_temp.ok('B08: 100 new radars a day per account — the 101st is not added, known radars still confirmed',
  exists (select 1 from radar_signs where mly_id = '908000000101') and not exists (select 1 from radar_signs where mly_id = '908000000102')
  and pg_temp.last() = 2);
insert into radar_votes (mly_id, user_id, kind, at)
  select 'h' || g, 'b0800000-0000-0000-0000-0000000000a3', 'g', now() - interval '10 minutes' from generate_series(1, 110) g;
select pg_temp.as_user('b0800000-0000-0000-0000-0000000000a3',
  $q$insert into res select radar_report((select jsonb_agg(pg_temp.item('9080000002' || lpad(g::text, 2, '0'))) from generate_series(1, 11) g))$q$);
select pg_temp.ok('B08: more than 120 reports an hour — request refused (0), nothing added',
  pg_temp.last() = 0 and not exists (select 1 from radar_signs where mly_id like '90800000020%'));
insert into radar_signs (mly_id, value, lat, lng) select '9080000003' || lpad(g::text, 2, '0'), 'regulatory--speed-camera--g1', 56.9, 24.0 from generate_series(1, 12) g;
insert into radar_votes (mly_id, user_id, kind, at)
  select 'b' || g, 'b0800000-0000-0000-0000-0000000000a4', 'b', now() - interval '10 minutes' from generate_series(1, 95) g;
select pg_temp.as_user('b0800000-0000-0000-0000-0000000000a4',
  $q$insert into res select radar_bad((select array_agg('9080000003' || lpad(g::text, 2, '0')) from generate_series(1, 12) g))$q$);
select pg_temp.ok('B08: "bad" votes — at most 100 an hour (1 + 95 earlier, 4 now)',
  pg_temp.last() = 4 and (select sum(bad) from radar_signs where mly_id like '9080000003%') = 4);

-- 5) Old votes are deleted after 30 days; deleting the account deletes its votes
insert into radar_votes (mly_id, user_id, kind, at) values ('908000000001', 'b0800000-0000-0000-0000-0000000000a2', 'b', now() - interval '31 days');
insert into res select public.cz_radar_votes_cleanup();
select pg_temp.ok('B08: cz_radar_votes_cleanup deletes votes older than 30 days, keeps newer',
  pg_temp.last() = 1 and not exists (select 1 from radar_votes where at < now() - interval '30 days')
  and exists (select 1 from radar_votes where user_id = 'b0800000-0000-0000-0000-0000000000a4'));
select public.account_erase('b0800000-0000-0000-0000-0000000000a1');
select pg_temp.ok('B08: account deletion removes its votes (radar itself stays)',
  not exists (select 1 from radar_votes where user_id = 'b0800000-0000-0000-0000-0000000000a1')
  and exists (select 1 from radar_signs where mly_id = '908000000001'));
select pg_temp.ok('B08: nightly job scheduled',
  exists (select 1 from cron.job where jobname = 'cz-radar-votes' and schedule = '37 2 * * *'));
rollback;
