-- Scenario test for supabase/coins-2-presence.sql (local copy of the database, NOT production). Prints PASS / FAIL.
-- Run after coins-1.sql and coins-2-presence.sql on a fresh copy.
\set QUIET 1
reset role;
insert into auth.users (id, is_anonymous) values
 ('d0000000-0000-0000-0000-00000000000a', true), ('d0000000-0000-0000-0000-00000000000b', true),
 ('d0000000-0000-0000-0000-00000000000c', true) on conflict do nothing;
create or replace function pg_temp.as_(u text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claim.sub', coalesce(u, ''), false); end $$;
create or replace function pg_temp.ok(n text, c boolean) returns void language plpgsql as $$ begin raise notice '%: %', case when c then 'PASS' else 'FAIL' end, n; end $$;
-- A: new consent; B: only the older text; C: said no
insert into user_consents (user_id, kind, version, accepted) values
 ('d0000000-0000-0000-0000-00000000000a', 'speed_share', '2026-11-01', true),
 ('d0000000-0000-0000-0000-00000000000b', 'speed_share', '2026-10-23', true),
 ('d0000000-0000-0000-0000-00000000000c', 'speed_share', '2026-11-01', false);
insert into user_wallet (user_id, balance) values ('d0000000-0000-0000-0000-00000000000a', 500) on conflict (user_id) do nothing;
insert into user_skins (user_id, skin_id) values ('d0000000-0000-0000-0000-00000000000a', 'viking');
update user_wallet set equipped_skin = 'viking' where user_id = 'd0000000-0000-0000-0000-00000000000a';

set role authenticated;
select pg_temp.as_('d0000000-0000-0000-0000-00000000000a');
select pg_temp.ok('A driving 50 km/h → shown', (presence_update(56.951234, 24.105678, 91, 50)->>'shown')::boolean);
select pg_temp.ok('A cannot read the table directly', (select count(*) from user_presence) = 0);
select pg_temp.as_('d0000000-0000-0000-0000-00000000000b');
select pg_temp.ok('B with the older consent → not shown', not (presence_update(56.95, 24.10, 0, 50)->>'shown')::boolean);
select pg_temp.ok('B sees A with skin, rounded, no id', (select count(*) = 1 and min(skin) = 'viking' and min(heading) = 91
   and abs(min(lat) - 56.9512) < 0.0001 and abs(min(lat) - 56.951234) > 0 from presence_nearby(56.9, 24.0, 57.0, 24.2)));
select pg_temp.as_('d0000000-0000-0000-0000-00000000000c');
select pg_temp.ok('C said no → not shown', not (presence_update(56.95, 24.10, 0, 50)->>'shown')::boolean);
select pg_temp.as_('d0000000-0000-0000-0000-00000000000a');
select pg_temp.ok('A does not see self', (select count(*) = 0 from presence_nearby(56.9, 24.0, 57.0, 24.2)));
select pg_temp.ok('too large area → nothing', (select count(*) = 0 from presence_nearby(56.0, 23.0, 57.5, 25.5)));
select pg_temp.ok('A stops (5 km/h) → removed at once', not (presence_update(56.95, 24.10, 0, 5)->>'shown')::boolean);
select pg_temp.as_('d0000000-0000-0000-0000-00000000000b');
select pg_temp.ok('after stop B sees nobody', (select count(*) = 0 from presence_nearby(56.9, 24.0, 57.0, 24.2)));
reset role;
update user_presence set updated_at = now() - interval '3 minutes';
insert into user_presence (user_id, lat, lng, heading, updated_at) values ('d0000000-0000-0000-0000-00000000000a', 56.95, 24.1, 0, now() - interval '3 minutes');
set role authenticated;
select pg_temp.ok('older than 2 min → hidden', (select count(*) = 0 from presence_nearby(56.9, 24.0, 57.0, 24.2)));
set role anon;
select pg_temp.as_(null);
select pg_temp.ok('anon may look', (select count(*) >= 0 from presence_nearby(56.9, 24.0, 57.0, 24.2)));
do $$ begin perform presence_update(56.95, 24.1, 0, 50); raise notice 'FAIL: anon cannot send'; exception when others then raise notice 'PASS: anon cannot send'; end $$;
reset role;
