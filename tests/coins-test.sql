-- Scenario test for supabase/coins-1.sql (run on a local copy of the database, NOT production).
-- Prints PASS / FAIL lines. Users: A author, B/C/D/F drivers, E e-mail account (buyer), G anonymous.
\set ON_ERROR_STOP 0
\set QUIET 1
reset role;
delete from reports;   -- local copy only: start from a clean report table
insert into auth.users (id, is_anonymous, email, email_confirmed_at) values
 ('c0000000-0000-0000-0000-00000000000a', true,  null, null),
 ('c0000000-0000-0000-0000-00000000000b', true,  null, null),
 ('c0000000-0000-0000-0000-00000000000c', true,  null, null),
 ('c0000000-0000-0000-0000-00000000000d', true,  null, null),
 ('c0000000-0000-0000-0000-0000000000f0', true,  null, null),
 ('c0000000-0000-0000-0000-00000000000e', false, 'e@example.com', now()),
 ('c0000000-0000-0000-0000-0000000000a9', true,  null, null)
on conflict do nothing;

create or replace function pg_temp.as_(u text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claim.sub', coalesce(u, ''), false); end $$;
create or replace function pg_temp.ok(n text, c boolean) returns void language plpgsql as $$ begin raise notice '%: %', case when c then 'PASS' else 'FAIL' end, n; end $$;
create or replace function pg_temp.err(n text, q text, code text) returns void language plpgsql as $$
begin
  begin execute q; raise notice 'FAIL: % (no error)', n;
  exception when others then raise notice '%: % (%)', case when sqlerrm = code then 'PASS' else 'FAIL' end, n, sqlerrm; end;
end $$;
create temp table t_ids (k text primary key, id uuid);
grant all on t_ids to authenticated;

\set A '''c0000000-0000-0000-0000-00000000000a'''
\set B '''c0000000-0000-0000-0000-00000000000b'''
\set C '''c0000000-0000-0000-0000-00000000000c'''
\set D '''c0000000-0000-0000-0000-00000000000d'''
\set F '''c0000000-0000-0000-0000-0000000000f0'''
\set E '''c0000000-0000-0000-0000-00000000000e'''
\set G '''c0000000-0000-0000-0000-0000000000a9'''

set role authenticated;
-- ===== Config =====
select pg_temp.ok('config: 5 types in the picker', (select count(*) from report_types_list() where in_picker) = 5);
select pg_temp.ok('config: police 45 min, jam 20, radar 60, accident 60, obstacle 30',
  (select string_agg(id || '=' || default_lifetime_min, ',' order by sort) from report_types_list()) = 'police=45,camera-mobile=60,jam=20,accident=60,obstacle=30');
select pg_temp.ok('config: Latvian questions', (select confirmation_question from report_types_list() where id = 'police') = 'Vai policija vēl ir šeit?');
select pg_temp.ok('skins: 8, cheapest first, rarity tiers',
  (select string_agg(name || ':' || price || ':' || rarity, ',') from skins_list()) =
  'Pavārs:200:common,Kovbojs:300:common,Pilots:350:common,Vikings:400:rare,Ninja:450:rare,Burvis:500:rare,Rallijs:600:epic,Varavīksne:800:epic');

-- ===== Create (author A, heading east) =====
select pg_temp.as_(:A);
insert into t_ids select 'p1', (report_create('police', 56.95, 24.10, 90)->>'id')::uuid;
insert into t_ids select 'm1', (report_create('police', 56.9502, 24.1005, 95)->>'id')::uuid;   -- same spot again
reset role;
select pg_temp.ok('create: police lives 45 min', (select abs(extract(epoch from expires_at - created_at) / 60 - 45) < 1 from reports where id = (select id from t_ids where k = 'p1')));
select pg_temp.ok('create: same type ≤150 m same direction merges', (select id from t_ids where k='m1') = (select id from t_ids where k='p1')
  and (select count(*) from reports where type = 'police' and not hidden) = 1);
set role authenticated; select pg_temp.as_(:A);

-- Positions: report at 24.10; ~200 m before it (west) = 24.0967; ~2 km away = 24.067
-- ===== Validation =====
select pg_temp.err('own report cannot be confirmed', format($q$select report_confirm(%L, 'yes', 56.95, 24.0967, 90, 50, 10)$q$, (select id from t_ids where k='p1')), 'own_report');
select pg_temp.as_(:B);
select pg_temp.err('too far away', format($q$select report_confirm(%L, 'yes', 56.95, 24.067, 90, 50, 10)$q$, (select id from t_ids where k='p1')), 'not_nearby');
select pg_temp.err('not driving (3 km/h)', format($q$select report_confirm(%L, 'yes', 56.95, 24.0967, 90, 3, 10)$q$, (select id from t_ids where k='p1')), 'not_driving');
select pg_temp.err('opposite direction', format($q$select report_confirm(%L, 'yes', 56.95, 24.0967, 270, 50, 10)$q$, (select id from t_ids where k='p1')), 'wrong_direction');
select pg_temp.err('poor GPS accuracy', format($q$select report_confirm(%L, 'yes', 56.95, 24.0967, 90, 50, 200)$q$, (select id from t_ids where k='p1')), 'poor_gps');

-- ===== YES from B: 10 coins, author +5, lifetime extended =====
select pg_temp.ok('B YES → 10 coins', (report_confirm((select id from t_ids where k='p1'), 'yes', 56.95, 24.0967, 88, 50, 10)->>'coins')::int = 10);
select pg_temp.err('B again → once per report', format($q$select report_confirm(%L, 'no', 56.95, 24.0967, 90, 50, 10)$q$, (select id from t_ids where k='p1')), 'already_answered');
reset role;
select pg_temp.ok('author A got +5 bonus', (select balance from user_wallet where user_id = :A) = 5);
select pg_temp.ok('ledger: answer + author_bonus', (select count(*) from coin_ledger where report_id = (select id from t_ids where k='p1')) = 2);
select pg_temp.ok('YES raised confidence', (select confidence from reports where id = (select id from t_ids where k='p1')) > 0.5);
select pg_temp.ok('vote stores GPS evidence', (select speed_kmh = 50 and heading = 88 and coins = 10 from report_votes where report_id = (select id from t_ids where k='p1') and user_id = :B));
-- lifetime cap: force created_at back 80 min → YES may extend only to created + 90 min
update reports set created_at = now() - interval '80 minutes', expires_at = now() + interval '5 minutes' where id = (select id from t_ids where k='p1');
set role authenticated;
select pg_temp.as_(:C);
select pg_temp.ok('C YES → 10 coins', (report_confirm((select id from t_ids where k='p1'), 'yes', 56.95, 24.0980, 92, 70, 8)->>'coins')::int = 10);
reset role;
select pg_temp.ok('YES extends, but never past 2 × 45 = 90 min', (select abs(extract(epoch from expires_at - created_at) / 60 - 90) < 1 from reports where id = (select id from t_ids where k='p1')));
select pg_temp.ok('author A now 10 (2 × 5)', (select balance from user_wallet where user_id = :A) = 10);

-- ===== NO streak hides =====
set role authenticated;
select pg_temp.as_(:D);
select report_confirm((select id from t_ids where k='p1'), 'no', 56.95, 24.0970, 90, 60, 10);
reset role;
select pg_temp.ok('one NO → still visible', not (select hidden from reports where id = (select id from t_ids where k='p1')));
select pg_temp.ok('D disagreed with majority → trust down', (select trust from user_wallet where user_id = :D) < 0.7);
set role authenticated;
select pg_temp.as_(:F);
select report_confirm((select id from t_ids where k='p1'), 'no', 56.95, 24.0970, 90, 60, 10);
reset role;
select pg_temp.ok('two NO in a row → hidden', (select hidden from reports where id = (select id from t_ids where k='p1')));

-- ===== GPS jump (teleport) =====
set role authenticated;
select pg_temp.as_(:A);
insert into t_ids select 'j1', (report_create('jam', 57.30, 25.20, 0)->>'id')::uuid;
select pg_temp.as_(:B);   -- B answered at Riga a moment ago; now claims to be 150 km away
select pg_temp.ok('impossible GPS jump → gps_suspect, no coins',
  (report_confirm((select id from t_ids where k='j1'), 'yes', 57.2995, 25.20, 0, 50, 10)->>'error') = 'gps_suspect');
reset role;
select pg_temp.ok('jump flag stored', (select gps_flags from user_wallet where user_id = :B) >= 1);

-- ===== Daily cap 100 =====
update user_wallet set last_fix_at = null where user_id = :C;
update user_wallet set earned_today = 95, earned_day = coin_today() where user_id = :C;
set role authenticated;
select pg_temp.as_(:A);
insert into t_ids select 'a1', (report_create('accident', 56.80, 24.30, 180)->>'id')::uuid;
select pg_temp.as_(:C);
select pg_temp.ok('daily cap: 95 + 10 → only 5 paid', (report_confirm((select id from t_ids where k='a1'), 'yes', 56.8018, 24.30, 180, 40, 10)->>'coins')::int = 5);
reset role;
select pg_temp.ok('earned_today = 100', (select earned_today from user_wallet where user_id = :C) = 100);

-- ===== Low trust =====
update user_wallet set trust = 0.3 where user_id = :D;
update user_wallet set last_fix_at = null where user_id = :D;
set role authenticated;
select pg_temp.as_(:D);
select pg_temp.ok('low trust → 0 coins', (report_confirm((select id from t_ids where k='a1'), 'yes', 56.8018, 24.30, 180, 40, 10)->>'coins')::int = 0);
insert into t_ids select 'o1', (report_create('obstacle', 56.70, 24.50, 0)->>'id')::uuid;
select pg_temp.as_(:G);
select pg_temp.ok('low-trust author: report pending (not shown widely)',
  (select pending from report_list(56.6, 24.4, 56.8, 24.6) where id = (select id from t_ids where k='o1')));
select pg_temp.as_(:D);
select pg_temp.ok('author sees own pending report', exists (select 1 from report_list(56.6, 24.4, 56.8, 24.6) where id = (select id from t_ids where k='o1') and mine));
reset role;
update user_wallet set trust = 0.8 where user_id = :B; update user_wallet set last_fix_at = null where user_id = :B;
set role authenticated;
select pg_temp.as_(:B);
select report_confirm((select id from t_ids where k='o1'), 'yes', 56.6982, 24.50, 0, 50, 10);
select pg_temp.as_(:G);
select pg_temp.ok('after 2 YES… (needs 2 for trust<0.4) still pending after 1', (select pending from report_list(56.6, 24.4, 56.8, 24.6) where id = (select id from t_ids where k='o1')));

-- ===== Mock location =====
reset role; update user_wallet set last_fix_at = null where user_id = :F;
set role authenticated;
select pg_temp.as_(:F);
select pg_temp.ok('mock GPS → vote counted, 0 coins', (report_confirm((select id from t_ids where k='o1'), 'yes', 56.6982, 24.50, 2, 50, 10, true)->>'coins')::int = 0);
select pg_temp.as_(:G);
select pg_temp.ok('2nd YES → no longer pending', not (select pending from report_list(56.6, 24.4, 56.8, 24.6) where id = (select id from t_ids where k='o1')));

-- ===== Legacy vote pays nothing =====
select pg_temp.as_(:E);
select report_vote((select id from t_ids where k='a1'), 'still');
reset role;
select pg_temp.ok('legacy report_vote → no coins', coalesce((select balance from user_wallet where user_id = :E), 0) = 0);

-- ===== Garage: purchases =====
set role authenticated;
select pg_temp.as_(:B);   -- anonymous: may earn but not spend
select pg_temp.err('anonymous account cannot buy', $q$select skin_buy('chef')$q$, 'need_account');
select pg_temp.ok('wallet_get: can_spend=false for anonymous', (wallet_get()->>'can_spend')::boolean = false);
reset role; insert into user_wallet (user_id, balance) values (:E, 250) on conflict (user_id) do update set balance = 250;
set role authenticated;
select pg_temp.as_(:E);
select pg_temp.err('not enough coins (300 > 250)', $q$select skin_buy('cowboy')$q$, 'not_enough');
select pg_temp.ok('buy Pavārs 200 → balance 50, owned', (select (j->>'balance')::int = 50 and j->'owned' ? 'chef' from (select skin_buy('chef') j) x));
select pg_temp.err('cannot buy twice', $q$select skin_buy('chef')$q$, 'already_owned');
select pg_temp.err('unknown skin', $q$select skin_buy('dragon')$q$, 'bad_skin');
select pg_temp.err('cannot equip a skin not owned', $q$select skin_equip('ninja')$q$, 'not_owned');
select pg_temp.ok('equip owned skin', (skin_equip('chef')->>'equipped') = 'chef');
select pg_temp.ok('unequip (default arrow)', (skin_equip(null)->>'equipped') is null);
reset role;
select pg_temp.ok('purchase in ledger (−200)', (select delta from coin_ledger where user_id = :E and reason = 'purchase') = -200);

-- ===== Direct table access is blocked =====
set role authenticated;
select pg_temp.as_(:E);
update user_wallet set balance = 99999;     -- RLS without policies: affects no rows
reset role;
select pg_temp.ok('cannot write own balance directly (RLS)', (select balance from user_wallet where user_id = :E) = 50);
select pg_temp.ok('anon cannot buy / read wallet',
  not has_function_privilege('anon', 'public.skin_buy(text)', 'execute') and not has_function_privilege('anon', 'public.wallet_get()', 'execute'));
select pg_temp.ok('internal award function not callable by clients',
  not has_function_privilege('authenticated', 'public.wallet_award(uuid, int, text, uuid)', 'execute'));

-- ===== Account merge moves coins and skins =====
reset role;
create temp table t_bal as select (select balance from user_wallet where user_id = :A) a, (select balance from user_wallet where user_id = :E) e;
insert into account_aliases (old_user, new_user) values (:A, :E);
select pg_temp.ok('alias → wallet merged (E + A balance)', (select balance from user_wallet where user_id = :E) = (select a + e from t_bal));
