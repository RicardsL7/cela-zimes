-- Scenario test for supabase/coins-3-skins.sql (local copy only, after coins-1.sql + coins-test.sql). Prints PASS / FAIL.
\set QUIET 1
reset role;
create or replace function pg_temp.ok(n text, c boolean) returns void language plpgsql as $$ begin raise notice '%: %', case when c then 'PASS' else 'FAIL' end, n; end $$;
select pg_temp.ok('78 skins, 8 characters, 14 mythic', (select count(*) = 78 and count(distinct animal) = 8 and count(*) filter (where rarity = 'mythic') = 14 from skins_list()));
select pg_temp.ok('rarity tiers by price', (select bool_and(rarity = case when price >= 1000 then 'mythic' when price >= 600 then 'epic' when price >= 400 then 'rare' else 'common' end) from skins));
select pg_temp.ok('each new character: 3/3/2/2', (select bool_and(n) from (select animal, string_agg(rarity, ',' order by price) = 'common,common,common,rare,rare,rare,epic,epic,mythic,mythic' n from skins where animal <> 'fox' group by animal) x));
select pg_temp.ok('cheapest first', (select bool_and(price >= lag) from (select price, coalesce(lag(price) over (), 0) lag from skins_list()) x));
select pg_temp.ok('earlier purchases kept', (select count(*) >= 1 from user_skins where skin_id = 'chef'));
select pg_temp.ok('anon may list', has_function_privilege('anon', 'public.skins_list()', 'execute'));
