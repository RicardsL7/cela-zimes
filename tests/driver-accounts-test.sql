-- Scenario test for supabase/rides-21-driver-accounts.sql (audit 2, B10). Local copy only — never against production.
-- One transaction, rolled back. Prints PASS / FAIL.
\set QUIET 1
reset role;
create or replace function pg_temp.ok(n text, c boolean) returns void language plpgsql as $$ begin raise notice '%: %', case when c then 'PASS' else 'FAIL' end, n; end $$;
-- Runs sql as role r (with user u); returns the error text or null
create or replace function pg_temp.ex(u uuid, sql text, r text default 'authenticated') returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
  execute 'set local role ' || r;
  begin execute sql; exception when others then reset role; return sqlerrm; end;
  reset role; return null;
end $$;

begin;
insert into auth.users (id) values ('b1000000-0000-0000-0000-00000000000a'), ('b1000000-0000-0000-0000-00000000000b');
insert into profiles (id, name) values ('b1000000-0000-0000-0000-00000000000a', 'Šoferis A'), ('b1000000-0000-0000-0000-00000000000b', 'Šoferis B');

create temp table e1 as select pg_temp.ex('b1000000-0000-0000-0000-00000000000a',
  $s$insert into driver_accounts (user_id, acct) values ('b1000000-0000-0000-0000-00000000000a', 'acct_FAKE123456')$s$) as err;
select pg_temp.ok('B10: the app can no longer write its own Stripe account id (REST insert refused)',
  (select err is not null from e1) and not exists (select 1 from driver_accounts where user_id = 'b1000000-0000-0000-0000-00000000000a'));
select pg_temp.ok('B10: anon cannot either',
  pg_temp.ex(null, $s$insert into driver_accounts (user_id, acct) values ('b1000000-0000-0000-0000-00000000000a', 'acct_FAKE123456')$s$, 'anon') is not null);
select pg_temp.ok('B10: authenticated cannot call driver_account_link',
  pg_temp.ex('b1000000-0000-0000-0000-00000000000a', $s$select driver_account_link('b1000000-0000-0000-0000-00000000000a', 'acct_FAKE123456')$s$) ~ 'permission denied');

-- ride-pay (service_role) links the account it created
create temp table e2 as select pg_temp.ex(null, $s$select driver_account_link('b1000000-0000-0000-0000-00000000000a', 'acct_REAL0000A1')$s$, 'service_role') as err;
select pg_temp.ok('B10: service_role (ride-pay) links the account',
  (select err is null from e2) and (select acct from driver_accounts where user_id = 'b1000000-0000-0000-0000-00000000000a') = 'acct_REAL0000A1');
create temp table e3 as select pg_temp.ex(null, $s$select driver_account_link('b1000000-0000-0000-0000-00000000000a', 'acct_REAL0000A2')$s$, 'service_role') as err;
select pg_temp.ok('B10: relinking (new Stripe account after the old one stopped belonging) replaces the row',
  (select err is null from e3) and (select acct from driver_accounts where user_id = 'b1000000-0000-0000-0000-00000000000a') = 'acct_REAL0000A2');
select pg_temp.ok('B10: one Stripe account cannot be linked to two users',
  pg_temp.ex(null, $s$select driver_account_link('b1000000-0000-0000-0000-00000000000b', 'acct_REAL0000A2')$s$, 'service_role') ~ 'citam lietotājam');
select pg_temp.ok('B10: invalid id / user without profile refused',
  pg_temp.ex(null, $s$select driver_account_link('b1000000-0000-0000-0000-00000000000b', 'pk_test_xxx')$s$, 'service_role') ~ 'Nederīgs'
  and pg_temp.ex(null, $s$select driver_account_link('b1000000-0000-0000-0000-0000000000ff', 'acct_REAL0000FF')$s$, 'service_role') ~ 'Nav profila');

-- the owner still reads and deletes own row; cannot change it; others see nothing
select pg_temp.ok('B10: the driver cannot overwrite the account id (UPDATE refused)',
  pg_temp.ex('b1000000-0000-0000-0000-00000000000a', $s$update driver_accounts set acct = 'acct_FAKE123456' where user_id = 'b1000000-0000-0000-0000-00000000000a'$s$) is not null
  and (select acct from driver_accounts where user_id = 'b1000000-0000-0000-0000-00000000000a') = 'acct_REAL0000A2');
create temp table seen (n int);
grant all on seen to authenticated;
select pg_temp.ex('b1000000-0000-0000-0000-00000000000a', 'insert into seen select count(*) from driver_accounts');
select pg_temp.ex('b1000000-0000-0000-0000-00000000000b', 'insert into seen select count(*) from driver_accounts');
select pg_temp.ok('B10: the driver reads own row, others do not', (select array_agg(n order by ctid) from seen) = array[1, 0]);
create temp table e4 as select pg_temp.ex('b1000000-0000-0000-0000-00000000000a', $s$delete from driver_accounts where user_id = 'b1000000-0000-0000-0000-00000000000a'$s$) as err;
select pg_temp.ok('B10: the driver can still remove own row (ride-pay does this when Stripe says it is not theirs)',
  (select err is null from e4) and not exists (select 1 from driver_accounts where user_id = 'b1000000-0000-0000-0000-00000000000a'));
select pg_temp.ok('B10: insert policy gone, read/delete policies stay',
  (select array_agg(polname::text order by polname) from pg_policy where polrelid = 'public.driver_accounts'::regclass)
    = array['driver_accounts delete own', 'driver_accounts read own']);
rollback;
