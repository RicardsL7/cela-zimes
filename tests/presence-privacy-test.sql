-- Scenario test for supabase/presence-2-privacy.sql (audit A16). Local copy only — never against production.
-- One transaction, rolled back. now() is constant inside a transaction, so "time passing" is simulated by moving
-- the stored timestamps back. Prints PASS / FAIL.
\set QUIET 1
reset role;
create or replace function pg_temp.ok(n text, c boolean) returns void language plpgsql as $$ begin raise notice '%: %', case when c then 'PASS' else 'FAIL' end, n; end $$;
create or replace function pg_temp.as_user(u uuid, q text) returns text language plpgsql as $$
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
create temp table res (j jsonb);
grant insert, select, delete on res to authenticated, anon;
create or replace function pg_temp.call(u uuid, q text) returns jsonb language plpgsql as $$
declare r jsonb; e text;
begin
  delete from res;
  e := pg_temp.as_user(u, 'insert into res (j) select ' || q);
  if e is not null then return jsonb_build_object('error', e); end if;
  select j into r from res; return r;
end $$;
-- viewer V drives along; returns the response
create or replace function pg_temp.look(u uuid, lat float8, lng float8, kmh float8 default 50) returns jsonb language sql as $$
  select pg_temp.call(u, format('presence_nearby(%s, %s, %s)', lat, lng, kmh)) $$;
create or replace function pg_temp.ago(u uuid, s int) returns void language sql as $$
  update presence_viewers set first_at = first_at - make_interval(secs => s), last_at = last_at - make_interval(secs => s) where user_id = u $$;

begin;
-- S = shown driver (opted in), N = speed sharing only (not opted in), V = viewer, W = second viewer
insert into auth.users (id) values ('5a16a000-0000-0000-0000-00000000000a'), ('5a16b000-0000-0000-0000-00000000000b'),
  ('5a16c000-0000-0000-0000-00000000000c'), ('5a16d000-0000-0000-0000-00000000000d');
insert into user_consents (user_id, kind, version, accepted) values
  ('5a16a000-0000-0000-0000-00000000000a', 'show_on_map', '2026-11-08', true),
  ('5a16b000-0000-0000-0000-00000000000b', 'speed_share', '2026-11-01', true);

select pg_temp.ok('consent kind show_on_map is accepted by the table', exists (select 1 from user_consents where kind = 'show_on_map'));
select pg_temp.ok('A16: old public bbox function is gone', to_regprocedure('public.presence_nearby(float8, float8, float8, float8)') is null);
select pg_temp.ok('A16: anon cannot read other drivers', not has_function_privilege('anon', 'public.presence_nearby(float8, float8, float8)', 'execute')
  and pg_temp.call(null, 'presence_nearby(56.95, 24.1, 50)') ? 'error');
select pg_temp.ok('nobody can read presence_viewers / user_presence tables directly',
  not has_table_privilege('authenticated', 'public.presence_viewers', 'SELECT') and not has_table_privilege('anon', 'public.presence_viewers', 'SELECT'));

-- ---------- Being shown ----------
select pg_temp.ok('A16: speed sharing alone no longer shows you',
  (pg_temp.call('5a16b000-0000-0000-0000-00000000000b', 'presence_update(56.95, 24.10, 90, 60)')->>'stored')::boolean = false
  and not exists (select 1 from user_presence where user_id = '5a16b000-0000-0000-0000-00000000000b'));
select pg_temp.ok('opted in, driving: stored but not yet shown (first 60 s)',
  (select (j->>'stored')::boolean and not (j->>'shown')::boolean from (select pg_temp.call('5a16a000-0000-0000-0000-00000000000a', 'presence_update(56.951234, 24.105678, 90, 60)') j) x));
select pg_temp.ok('A16: position rounded to ~150 m (1/700°, 1/400°)',
  (select lat = round(56.951234 * 700) / 700.0 and lng = round(24.105678 * 400) / 400.0 from user_presence where user_id = '5a16a000-0000-0000-0000-00000000000a'));
select pg_temp.ok('A16: a second update within 25 s does not move the point',
  (pg_temp.call('5a16a000-0000-0000-0000-00000000000a', 'presence_update(56.99, 24.20, 90, 60)')->>'stored')::boolean
  and (select lat = round(56.951234 * 700) / 700.0 from user_presence where user_id = '5a16a000-0000-0000-0000-00000000000a'));
update user_presence set started_at = now() - interval '90 seconds', updated_at = now() - interval '30 seconds' where user_id = '5a16a000-0000-0000-0000-00000000000a';
select pg_temp.ok('after 60 s of continuous driving: shown',
  (pg_temp.call('5a16a000-0000-0000-0000-00000000000a', 'presence_update(56.952, 24.106, 90, 60)')->>'shown')::boolean);
update user_presence set started_at = now() - interval '10 minutes', updated_at = now() - interval '3 minutes' where user_id = '5a16a000-0000-0000-0000-00000000000a';
select pg_temp.call('5a16a000-0000-0000-0000-00000000000a', 'presence_update(56.952, 24.106, 90, 60)');
select pg_temp.ok('A16: after a gap > 2 min the 60 s wait starts again',
  (select started_at = now() from user_presence where user_id = '5a16a000-0000-0000-0000-00000000000a'));
update user_presence set started_at = now() - interval '5 minutes' where user_id = '5a16a000-0000-0000-0000-00000000000a';

-- ---------- Viewing ----------
select pg_temp.ok('A16: viewer standing still sees nothing', (pg_temp.look('5a16c000-0000-0000-0000-00000000000c', 56.95, 24.10, 0)->>'reason') = 'not_moving');
select pg_temp.ok('A16: viewer just started driving: warming up (empty)',
  (select j->>'reason' = 'warming_up' and jsonb_array_length(j->'points') = 0 from (select pg_temp.look('5a16c000-0000-0000-0000-00000000000c', 56.940, 24.10) j) x));
select pg_temp.ok('A16: asking again at once is throttled', (pg_temp.look('5a16c000-0000-0000-0000-00000000000c', 56.940, 24.10)->>'reason') = 'throttled');
select pg_temp.ago('5a16c000-0000-0000-0000-00000000000c', 70);
select pg_temp.ok('after 70 s but without moving 200 m: still warming up',
  (pg_temp.look('5a16c000-0000-0000-0000-00000000000c', 56.9401, 24.10)->>'reason') = 'warming_up');
select pg_temp.ago('5a16c000-0000-0000-0000-00000000000c', 20);
select pg_temp.ok('after ≥ 60 s and ≥ 200 m: sees S, rounded, no id',
  (select (j->>'ok')::boolean and jsonb_array_length(j->'points') = 1 and not (j->'points'->0 ? 'user_id')
          and (j->'points'->0->>'lat')::float8 = round(56.952 * 700) / 700.0 and ((j->'points'->0->>'age_s')::int % 10) = 0
   from (select pg_temp.look('5a16c000-0000-0000-0000-00000000000c', 56.943, 24.10) j) x));
select pg_temp.ok('A16: viewer position stored only ~50 m', (select lat = round(56.943 * 2000) / 2000.0 from presence_viewers where user_id = '5a16c000-0000-0000-0000-00000000000c'));
-- teleport: 100 km in 20 s → warming up again
select pg_temp.ago('5a16c000-0000-0000-0000-00000000000c', 20);
select pg_temp.ok('A16: impossible jump (≈100 km in 20 s) → warming up',
  (pg_temp.look('5a16c000-0000-0000-0000-00000000000c', 57.80, 24.10)->>'reason') = 'warming_up');
select pg_temp.ok('A16: … and the 60 s wait starts again', (select first_at = now() from presence_viewers where user_id = '5a16c000-0000-0000-0000-00000000000c'));
-- a drive that ends 30 km away from S
update presence_viewers set first_at = now() - interval '5 minutes', last_at = now() - interval '30 minutes', first_lat = 57.2, first_lng = 24.1
  where user_id = '5a16c000-0000-0000-0000-00000000000c';
select pg_temp.look('5a16c000-0000-0000-0000-00000000000c', 57.22, 24.10);
select pg_temp.ago('5a16c000-0000-0000-0000-00000000000c', 70);
select pg_temp.ok('A16: 30 km away (after warm-up): S not visible',
  (select (j->>'ok')::boolean and jsonb_array_length(j->'points') = 0 from (select pg_temp.look('5a16c000-0000-0000-0000-00000000000c', 57.225, 24.10) j) x));
-- S is not shown to itself; a fresh (< 60 s) driver is not shown
insert into user_consents (user_id, kind, version, accepted) values ('5a16d000-0000-0000-0000-00000000000d', 'show_on_map', '2026-11-08', true);
select pg_temp.call('5a16d000-0000-0000-0000-00000000000d', 'presence_update(56.945, 24.101, 0, 40)');
insert into presence_viewers (user_id, lat, lng, first_lat, first_lng, first_at, last_at) values
  ('5a16a000-0000-0000-0000-00000000000a', 56.95, 24.10, 56.90, 24.10, now() - interval '5 minutes', now() - interval '20 seconds');
select pg_temp.ok('A16: S sees neither itself nor D who started < 60 s ago',
  (select (j->>'ok')::boolean and jsonb_array_length(j->'points') = 0 from (select pg_temp.look('5a16a000-0000-0000-0000-00000000000a', 56.951, 24.10) j) x));

-- ---------- Turning it off / stopping ----------
insert into user_consents (user_id, kind, version, accepted) values ('5a16a000-0000-0000-0000-00000000000a', 'show_on_map', '2026-11-08', false);
select pg_temp.ok('A16: switching off (newest consent = no) → not stored',
  (pg_temp.call('5a16a000-0000-0000-0000-00000000000a', 'presence_update(56.952, 24.106, 90, 60)')->>'stored')::boolean = false);
select pg_temp.ok('A16: … and the point is removed at once', not exists (select 1 from user_presence where user_id = '5a16a000-0000-0000-0000-00000000000a'));
select pg_temp.ok('A16: an older consent text (before 2026-11-08) is not enough',
  (select not presence_allowed(u) from (values ('5a16b000-0000-0000-0000-00000000000b'::uuid)) t(u))
  and (select pg_temp.as_user('5a16b000-0000-0000-0000-00000000000b', $q$insert into user_consents (user_id, kind, version, accepted) values ('5a16b000-0000-0000-0000-00000000000b', 'show_on_map', '2026-11-01', true)$q$) is null)
  and not presence_allowed('5a16b000-0000-0000-0000-00000000000b'));
select pg_temp.as_user('5a16c000-0000-0000-0000-00000000000c', 'select presence_clear()');
select pg_temp.ok('presence_clear also forgets the viewer position', not exists (select 1 from presence_viewers where user_id = '5a16c000-0000-0000-0000-00000000000c'));
select pg_temp.look('5a16d000-0000-0000-0000-00000000000d', 56.95, 24.10, 5);
select pg_temp.ok('stopping as a viewer forgets the position', not exists (select 1 from presence_viewers where user_id = '5a16d000-0000-0000-0000-00000000000d'));
update presence_viewers set last_at = now() - interval '11 minutes';
select pg_temp.ok('cz_cleanup has a presence_viewers step', (cz_cleanup()->'deleted'->>'presence_viewers') is not null);
select pg_temp.ok('cz_cleanup removed viewer positions older than 10 min', not exists (select 1 from presence_viewers where last_at < now() - interval '10 minutes'));
rollback;
