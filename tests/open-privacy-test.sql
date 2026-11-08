-- Scenario test for supabase/rides-18-open-privacy.sql (audit 2, B02). Local copy only — never against production.
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

begin;
-- P = passenger, D = driver (offers, gets accepted), E = other driver (pending offer), X = stranger
insert into auth.users (id) values ('b02a0000-0000-0000-0000-00000000000a'), ('b02d0000-0000-0000-0000-00000000000d'),
  ('b02e0000-0000-0000-0000-00000000000e'), ('b02f0000-0000-0000-0000-00000000000f');
insert into profiles (id, name, car) values ('b02a0000-0000-0000-0000-00000000000a', 'Anna Bērziņa', ''),
  ('b02d0000-0000-0000-0000-00000000000d', 'Dāvis', 'Škoda'), ('b02e0000-0000-0000-0000-00000000000e', 'Edgars', 'VW'),
  ('b02f0000-0000-0000-0000-00000000000f', 'Svešais', '');
insert into ride_requests (id, user_id, from_lat, from_lng, from_name, to_lat, to_lng, to_name, depart_at, note) values
  ('b0211111-0000-0000-0000-000000000001', 'b02a0000-0000-0000-0000-00000000000a', 56.951234, 24.105678, 'Brīvības iela 100, Rīga',
   56.971234, 24.155678, 'Mežaparks', now() + interval '1 hour', 'zvani pie vārtiem, dzīvoklis 12');

select pg_temp.ok('A: stranger no longer reads open requests from the table',
  jsonb_array_length(pg_temp.q('b02f0000-0000-0000-0000-00000000000f', 'select * from ride_requests')) = 0);
select pg_temp.ok('A: anon cannot call the coarse list', pg_temp.q(null, 'select * from ride_requests_open()') ? 'error');
select pg_temp.ok('B02: stranger sees the request in the coarse list',
  (select jsonb_array_length(j) = 1 from (select pg_temp.q('b02f0000-0000-0000-0000-00000000000f', 'select * from ride_requests_open(56.9, 24.0, 57.0, 24.2)') j) x));
select pg_temp.ok('B02: coarse list — ~1 km rounding (1/100°, 1/60°)',
  (select (j->0->>'from_lat')::numeric = 56.95 and (j->0->>'from_lng')::numeric = round(24.105678 * 60) / 60.0
          and (j->0->>'to_lat')::numeric = 56.97 from (select pg_temp.q('b02f0000-0000-0000-0000-00000000000f', 'select * from ride_requests_open()') j) x));
select pg_temp.ok('B02: coarse list — no address, note, name or user id; only the locality',
  (select j->0->>'from_area' = 'Rīga' and j->0->>'to_area' = '' and not (j->0 ? 'note') and not (j->0 ? 'user_id')
          and not (j->0 ? 'from_name') and j::text !~ 'Brīvības|Anna|dzīvoklis'
   from (select pg_temp.q('b02f0000-0000-0000-0000-00000000000f', 'select * from ride_requests_open()') j) x));
select pg_temp.ok('B02: box filter works', jsonb_array_length(pg_temp.q('b02f0000-0000-0000-0000-00000000000f', 'select * from ride_requests_open(57.5, 25.0, 57.6, 25.1)')) = 0);
select pg_temp.ok('passenger sees own request in full and as mine',
  (select j->0->>'note' like 'zvani%' from (select pg_temp.q('b02a0000-0000-0000-0000-00000000000a', 'select * from ride_requests') j) x)
  and (select (j->0->>'mine')::boolean from (select pg_temp.q('b02a0000-0000-0000-0000-00000000000a', 'select * from ride_requests_open()') j) x));

-- drivers make offers
select set_config('request.jwt.claim.sub', 'b02d0000-0000-0000-0000-00000000000d', true);
set local role authenticated;
insert into ride_offers (id, request_id, driver_id) values ('b0222222-0000-0000-0000-00000000000d', 'b0211111-0000-0000-0000-000000000001', 'b02d0000-0000-0000-0000-00000000000d');
reset role;
select set_config('request.jwt.claim.sub', 'b02e0000-0000-0000-0000-00000000000e', true);
set local role authenticated;
insert into ride_offers (id, request_id, driver_id) values ('b0222222-0000-0000-0000-00000000000e', 'b0211111-0000-0000-0000-000000000001', 'b02e0000-0000-0000-0000-00000000000e');
reset role;
select pg_temp.ok('B02: a pending offer no longer opens the exact request',
  jsonb_array_length(pg_temp.q('b02d0000-0000-0000-0000-00000000000d', 'select * from ride_requests')) = 0
  and (select j->0->'request' = 'null'::jsonb from (select pg_temp.q('b02d0000-0000-0000-0000-00000000000d',
       'select o.id, (select to_jsonb(r) from ride_requests r where r.id = o.request_id) as request from ride_offers o') j) x));
select pg_temp.ok('driver with a pending offer gets the coarse request by id',
  (select jsonb_array_length(j) = 1 and j->0->>'from_area' = 'Rīga' and not (j->0 ? 'note')
   from (select pg_temp.q('b02d0000-0000-0000-0000-00000000000d', $s$select * from ride_requests_coarse(array['b0211111-0000-0000-0000-000000000001'::uuid])$s$) j) x));

-- passenger accepts D
select set_config('request.jwt.claim.sub', 'b02a0000-0000-0000-0000-00000000000a', true);
set local role authenticated;
select ride_offer_accept('b0222222-0000-0000-0000-00000000000d');
reset role;
select pg_temp.ok('B02: the accepted driver sees the exact pickup, address and note',
  (select (j->0->>'from_lat')::float8 = 56.951234 and j->0->>'from_name' = 'Brīvības iela 100, Rīga' and j->0->>'note' like 'zvani%'
   from (select pg_temp.q('b02d0000-0000-0000-0000-00000000000d', 'select * from ride_requests') j) x));
select pg_temp.ok('B02: the declined driver still sees nothing exact',
  jsonb_array_length(pg_temp.q('b02e0000-0000-0000-0000-00000000000e', 'select * from ride_requests')) = 0);
select pg_temp.ok('declined driver: coarse request still available for the "declined" card (matched)',
  (select jsonb_array_length(j) = 1 and j->0->>'status' = 'matched'
   from (select pg_temp.q('b02e0000-0000-0000-0000-00000000000e', $s$select * from ride_requests_coarse(array['b0211111-0000-0000-0000-000000000001'::uuid])$s$) j) x));
select pg_temp.ok('stranger: a matched request is gone from the coarse list and not available by id',
  jsonb_array_length(pg_temp.q('b02f0000-0000-0000-0000-00000000000f', 'select * from ride_requests_open()')) = 0
  and jsonb_array_length(pg_temp.q('b02f0000-0000-0000-0000-00000000000f', $s$select * from ride_requests_coarse(array['b0211111-0000-0000-0000-000000000001'::uuid])$s$)) = 0);
select pg_temp.ok('ride_area: locality only when the last part has no digits',
  ride_area('Brīvības iela 100, Rīga') = 'Rīga' and ride_area('Mana atrašanās vieta') = '' and ride_area('Rīga, LV-1010') = '' and ride_area(null) = '');
rollback;
