-- Scenario test for supabase/rides-20-profiles-privacy.sql (audit 2, B09). Local copy only — never against production.
-- One transaction, rolled back. Prints PASS / FAIL.
\set QUIET 1
reset role;
create or replace function pg_temp.ok(n text, c boolean) returns void language plpgsql as $$ begin raise notice '%: %', case when c then 'PASS' else 'FAIL' end, n; end $$;
create temp table res (j jsonb);
grant insert, select, delete on res to authenticated, anon;
create or replace function pg_temp.q(u uuid, sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  delete from res;
  perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
  if u is null then set local role anon; else set local role authenticated; end if;
  begin
    execute 'insert into res (j) select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from (' || sql || ') x';
  exception when others then reset role; return jsonb_build_object('error', sqlerrm); end;
  reset role;
  select j into r from res; return r;
end $$;
create or replace function pg_temp.ex(u uuid, sql text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
  begin execute sql; exception when others then reset role; return sqlerrm; end;
  reset role; return null;
end $$;
create or replace function pg_temp.names(u uuid) returns text language sql as $$
  select coalesce(string_agg(e->>'name', ',' order by e->>'name'), '') from jsonb_array_elements(pg_temp.q(u, 'select name from profiles')) e $$;

begin;
-- P = passenger, D = driver (offers, gets accepted), E = other driver (offers, declined), X = stranger
insert into auth.users (id) values ('b09a0000-0000-0000-0000-00000000000a'), ('b09d0000-0000-0000-0000-00000000000d'),
  ('b09e0000-0000-0000-0000-00000000000e'), ('b09f0000-0000-0000-0000-00000000000f');
insert into profiles (id, name, car) values ('b09a0000-0000-0000-0000-00000000000a', 'Pasažiere', ''),
  ('b09d0000-0000-0000-0000-00000000000d', 'Šoferis D', 'Škoda'), ('b09e0000-0000-0000-0000-00000000000e', 'Šoferis E', 'VW'),
  ('b09f0000-0000-0000-0000-00000000000f', 'Svešais', '');
insert into ride_requests (id, user_id, from_lat, from_lng, from_name, to_lat, to_lng, to_name, depart_at) values
  ('b0911111-0000-0000-0000-000000000001', 'b09a0000-0000-0000-0000-00000000000a', 56.95, 24.1, 'Rīga', 56.97, 24.15, 'Mežaparks', now() + interval '1 hour');

select pg_temp.ok('B09: stranger sees only own profile (was: all profiles)',
  pg_temp.names('b09f0000-0000-0000-0000-00000000000f') = 'Svešais');
select pg_temp.ok('B09: stranger cannot read a profile by id',
  jsonb_array_length(pg_temp.q('b09f0000-0000-0000-0000-00000000000f', $s$select * from profiles where id = 'b09a0000-0000-0000-0000-00000000000a'$s$)) = 0);
select pg_temp.ok('B09: anon sees no profiles',
  coalesce(jsonb_array_length(pg_temp.q(null, 'select * from profiles')), 0) = 0);
create temp table e1 as select pg_temp.ex('b09f0000-0000-0000-0000-00000000000f', $s$insert into profiles (id, name, car) values ('b09f0000-0000-0000-0000-00000000000f', 'Svešais 2', 'Opel')
      on conflict (id) do update set name = excluded.name, car = excluded.car$s$) as err;
select pg_temp.ok('B09: own profile can still be saved (upsert, as the app does)',
  (select err is null from e1) and (select name from profiles where id = 'b09f0000-0000-0000-0000-00000000000f') = 'Svešais 2');
update profiles set name = 'Svešais' where id = 'b09f0000-0000-0000-0000-00000000000f';
create temp table e2 as select pg_temp.ex('b09f0000-0000-0000-0000-00000000000f', $s$insert into profiles (id, name, car) values ('b09a0000-0000-0000-0000-00000000000a', 'Hack', '')
      on conflict (id) do update set name = excluded.name$s$) as err;
select pg_temp.ok('B09: cannot overwrite someone else''s profile by upsert',
  (select err is not null from e2) and (select name from profiles where id = 'b09a0000-0000-0000-0000-00000000000a') = 'Pasažiere');

-- drivers make offers
select set_config('request.jwt.claim.sub', 'b09d0000-0000-0000-0000-00000000000d', true);
set local role authenticated;
insert into ride_offers (id, request_id, driver_id) values ('b0922222-0000-0000-0000-00000000000d', 'b0911111-0000-0000-0000-000000000001', 'b09d0000-0000-0000-0000-00000000000d');
reset role;
select set_config('request.jwt.claim.sub', 'b09e0000-0000-0000-0000-00000000000e', true);
set local role authenticated;
insert into ride_offers (id, request_id, driver_id) values ('b0922222-0000-0000-0000-00000000000e', 'b0911111-0000-0000-0000-000000000001', 'b09e0000-0000-0000-0000-00000000000e');
reset role;

select pg_temp.ok('B09: passenger sees the drivers who offered (name, car) — to choose',
  pg_temp.names('b09a0000-0000-0000-0000-00000000000a') = 'Pasažiere,Šoferis D,Šoferis E');
select pg_temp.ok('B09: passenger offers list embeds driver name and car',
  (select count(*) = 2 and bool_and(e->'driver'->>'name' like 'Šoferis%' and e->'driver'->>'car' <> '')
   from jsonb_array_elements(pg_temp.q('b09a0000-0000-0000-0000-00000000000a',
     $s$select o.id, (select to_jsonb(p) from (select name, car from profiles where id = o.driver_id) p) as driver from ride_offers o$s$)) e));
select pg_temp.ok('B09: a driver with a pending offer does not see the passenger name',
  pg_temp.names('b09d0000-0000-0000-0000-00000000000d') = 'Šoferis D');
select pg_temp.ok('B09: drivers do not see each other',
  position('Šoferis D' in pg_temp.names('b09e0000-0000-0000-0000-00000000000e')) = 0);

-- passenger accepts D
select set_config('request.jwt.claim.sub', 'b09a0000-0000-0000-0000-00000000000a', true);
set local role authenticated;
select ride_offer_accept('b0922222-0000-0000-0000-00000000000d');
reset role;
select pg_temp.ok('B09: the accepted driver sees the passenger',
  pg_temp.names('b09d0000-0000-0000-0000-00000000000d') = 'Pasažiere,Šoferis D');
select pg_temp.ok('B09: the declined driver still does not',
  pg_temp.names('b09e0000-0000-0000-0000-00000000000e') = 'Šoferis E');
select pg_temp.ok('B09: stranger still sees only own profile',
  pg_temp.names('b09f0000-0000-0000-0000-00000000000f') = 'Svešais');

-- after cancellation the history keeps the names (was_accepted)
update ride_offers set status = 'cancelled' where id = 'b0922222-0000-0000-0000-00000000000d';
select pg_temp.ok('B09: after cancellation the accepted driver still sees the passenger (history)',
  pg_temp.names('b09d0000-0000-0000-0000-00000000000d') = 'Pasažiere,Šoferis D');
select pg_temp.ok('B09: profile_visible not callable by anon',
  pg_temp.q(null, $s$select public.profile_visible('b09a0000-0000-0000-0000-00000000000a')$s$) ? 'error');
rollback;
