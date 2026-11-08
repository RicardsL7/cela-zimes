-- Scenario test for supabase/rides-19-cost-share.sql (audit 2, B03). Local copy only — never against production.
\set QUIET 1
reset role;
create or replace function pg_temp.ok(n text, c boolean) returns void language plpgsql as $$ begin raise notice '%: %', case when c then 'PASS' else 'FAIL' end, n; end $$;
create or replace function pg_temp.as_user(u uuid, q text) returns text language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', u::text, true); set local role authenticated; execute q; reset role; return null;
exception when others then reset role; return sqlerrm; end $$;
create temp table res (j jsonb); grant all on res to authenticated;
begin;
insert into auth.users (id) values ('b03a0000-0000-0000-0000-00000000000a'), ('b03d0000-0000-0000-0000-00000000000d');
insert into profiles (id, name) values ('b03a0000-0000-0000-0000-00000000000a', 'Pasažieris'), ('b03d0000-0000-0000-0000-00000000000d', 'Dāvis');
-- Rīga → Liepāja (~190 km taisnā līnijā) and a short city ride
insert into ride_requests (id, user_id, from_lat, from_lng, to_lat, to_lng, depart_at) values
  ('b0311111-0000-0000-0000-000000000001', 'b03a0000-0000-0000-0000-00000000000a', 56.9496, 24.1052, 56.5047, 21.0108, now() + interval '1 hour'),
  ('b0311111-0000-0000-0000-000000000002', 'b03a0000-0000-0000-0000-00000000000a', 56.9496, 24.1052, 56.9600, 24.1300, now() + interval '2 hours');
select pg_temp.ok('B03: Rīga → Liepāja cap ≈ 29–30 € (distance × 1.3 × 12 c/km)', ride_fare_cap_cents('b0311111-0000-0000-0000-000000000001') between 2850 and 3050);
select pg_temp.ok('B03: short ride cap is the 2 € minimum', ride_fare_cap_cents('b0311111-0000-0000-0000-000000000002') = 200);
select pg_temp.ok('B03: a price above the cost share is refused',
  pg_temp.as_user('b03d0000-0000-0000-0000-00000000000d', $q$insert into ride_offers (request_id, driver_id, price_cents) values ('b0311111-0000-0000-0000-000000000001', 'b03d0000-0000-0000-0000-00000000000d', 5000)$q$) like '%pārsniedz%');
select pg_temp.ok('B03: a price within the cost share is accepted',
  pg_temp.as_user('b03d0000-0000-0000-0000-00000000000d', $q$insert into ride_offers (request_id, driver_id, price_cents) values ('b0311111-0000-0000-0000-000000000001', 'b03d0000-0000-0000-0000-00000000000d', 2500)$q$) is null);
select pg_temp.ok('B03: short ride — 3 € refused, 2 € accepted',
  pg_temp.as_user('b03d0000-0000-0000-0000-00000000000d', $q$insert into ride_offers (request_id, driver_id, price_cents) values ('b0311111-0000-0000-0000-000000000002', 'b03d0000-0000-0000-0000-00000000000d', 300)$q$) like '%pārsniedz%');
select pg_temp.ok('… 2 € accepted',
  pg_temp.as_user('b03d0000-0000-0000-0000-00000000000d', $q$insert into ride_offers (request_id, driver_id, price_cents) values ('b0311111-0000-0000-0000-000000000002', 'b03d0000-0000-0000-0000-00000000000d', 200)$q$) is null);
select pg_temp.as_user('b03d0000-0000-0000-0000-00000000000d', $q$insert into res select coalesce(jsonb_agg(to_jsonb(x)), '[]') from ride_requests_coarse(array['b0311111-0000-0000-0000-000000000001'::uuid]) x$q$);
select pg_temp.ok('B03: driver list returns the exact cap (cap_cents) with the rounded place',
  (select (j->0->>'cap_cents')::int = ride_fare_cap_cents('b0311111-0000-0000-0000-000000000001') and (j->0->>'from_lat')::numeric = 56.95 from res));
delete from res;
select pg_temp.as_user('b03d0000-0000-0000-0000-00000000000d', $q$insert into res select coalesce(jsonb_agg(to_jsonb(x)), '[]') from ride_requests_open() x$q$);
select pg_temp.ok('B03: open list has cap_cents too', (select (j->0 ? 'cap_cents') from res));
select pg_temp.ok('B02 still holds: no note / name / user id in the list', (select not (j->0 ? 'note') and not (j->0 ? 'user_id') from res));
rollback;
