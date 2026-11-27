-- Scenario test for road reports (F10: supabase/reports.sql, as changed by later files) — audit 2, B17: behaviour
-- instead of reading the SQL text. Runs against the final schema. Local copy only — never against production.
\set QUIET 1
reset role;
create or replace function pg_temp.ok(n text, c boolean) returns void language plpgsql as $$ begin raise notice '%: %', case when c then 'PASS' else 'FAIL' end, n; end $$;
-- Runs q as role r (anon / authenticated) with JWT sub u; returns null on success, the error text otherwise
create or replace function pg_temp.as_role(r text, u uuid, q text) returns text language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), true); execute 'set local role ' || r; execute q; reset role; return null;
exception when others then reset role; return sqlerrm; end $$;
create temp table res (j jsonb); grant all on res to authenticated, anon;
begin;
insert into auth.users (id) values ('f10a0000-0000-0000-0000-00000000000a'), ('f10b0000-0000-0000-0000-00000000000b'), ('f10c0000-0000-0000-0000-00000000000c');

-- Who may do what
select pg_temp.ok('F10: without an account a report cannot be created',
  pg_temp.as_role('anon', null, $q$select report_create('pothole', 56.95, 24.10)$q$) like '%permission denied%');
select pg_temp.ok('F10: without an account the list can be read',
  pg_temp.as_role('anon', null, $q$insert into res select to_jsonb(x) from report_list(56.9, 24.0, 57.0, 24.2) x$q$) is null);
select pg_temp.ok('F10: account creates a report',
  pg_temp.as_role('authenticated', 'f10a0000-0000-0000-0000-00000000000a', $q$insert into res select report_create('pothole', 56.95, 24.10)$q$) is null);
select pg_temp.ok('F10: reports table cannot be read or written directly (only via functions)',
  coalesce(pg_temp.as_role('authenticated', 'f10a0000-0000-0000-0000-00000000000a', $q$do $d$ begin if (select count(*) from reports) <> 0 then raise exception 'visible'; end if; end $d$$q$), 'permission denied') like '%permission denied%'
  and pg_temp.as_role('authenticated', 'f10a0000-0000-0000-0000-00000000000a', $q$insert into reports (user_id, type, lat, lng, expires_at) values (auth.uid(), 'pothole', 56.9, 24.1, now() + interval '1 hour')$q$) is not null
  and pg_temp.as_role('authenticated', 'f10b0000-0000-0000-0000-00000000000b', format($q$insert into report_votes (report_id, user_id, vote) values (%L, auth.uid(), 'gone')$q$, (select id from reports where user_id = 'f10a0000-0000-0000-0000-00000000000a' and type = 'pothole'))) is not null);
select pg_temp.ok('F10: the internal vote function cannot be called',
  pg_temp.as_role('authenticated', 'f10b0000-0000-0000-0000-00000000000b', $q$select report_vote_apply('f10a0000-0000-0000-0000-00000000000a', auth.uid(), 'gone')$q$) like '%permission denied%');
delete from res;
select pg_temp.as_role('anon', null, $q$insert into res select to_jsonb(x) from report_list(56.9, 24.0, 57.0, 24.2) x$q$);
select pg_temp.ok('F10: the list does not reveal who reported', (select count(*) >= 1 and bool_and(not (j ? 'user_id')) from res));

-- Votes: not on your own; two different "gone" hide it; "still" extends at most to 2 × lifetime
select pg_temp.ok('F10: you cannot vote on your own report',
  pg_temp.as_role('authenticated', 'f10a0000-0000-0000-0000-00000000000a', format($q$select report_vote(%L, 'gone')$q$, (select id from reports where user_id = 'f10a0000-0000-0000-0000-00000000000a' and type = 'pothole'))) like '%own_report%');
select pg_temp.as_role('authenticated', 'f10b0000-0000-0000-0000-00000000000b', format($q$select report_vote(%L, 'gone')$q$, (select id from reports where user_id = 'f10a0000-0000-0000-0000-00000000000a' and type = 'pothole')));
select pg_temp.as_role('authenticated', 'f10b0000-0000-0000-0000-00000000000b', format($q$select report_vote(%L, 'gone')$q$, (select id from reports where user_id = 'f10a0000-0000-0000-0000-00000000000a' and type = 'pothole')));
select pg_temp.ok('F10/B17: one account counts once — still visible after the same "gone" twice', (select not hidden and gone_count = 1 and no_streak = 1 from reports where user_id = 'f10a0000-0000-0000-0000-00000000000a' and type = 'pothole'));
select pg_temp.as_role('authenticated', 'f10c0000-0000-0000-0000-00000000000c', format($q$select report_vote(%L, 'gone')$q$, (select id from reports where user_id = 'f10a0000-0000-0000-0000-00000000000a' and type = 'pothole')));
select pg_temp.ok('F10: two different "gone" → hidden', (select hidden from reports where user_id = 'f10a0000-0000-0000-0000-00000000000a' and type = 'pothole'));
select pg_temp.as_role('authenticated', 'f10a0000-0000-0000-0000-00000000000a', $q$select report_create('police', 56.96, 24.12)$q$);
update reports set created_at = now() - interval '50 minutes', expires_at = now() + interval '10 minutes' where type = 'police' and user_id = 'f10a0000-0000-0000-0000-00000000000a';
select pg_temp.as_role('authenticated', 'f10b0000-0000-0000-0000-00000000000b', format($q$select report_vote(%L, 'still')$q$, (select id from reports where type = 'police' and user_id = 'f10a0000-0000-0000-0000-00000000000a')));
select pg_temp.ok('F10: "still" extends, but not beyond 2 × the lifetime from creation',
  (select expires_at > now() + interval '20 minutes' and expires_at <= created_at + 2 * make_interval(mins => report_type_ttl('police')) + interval '1 second' from reports where type = 'police' and user_id = 'f10a0000-0000-0000-0000-00000000000a'));

-- Same report nearby is merged (≤ 150 m), farther away is new
delete from res;
select pg_temp.as_role('authenticated', 'f10c0000-0000-0000-0000-00000000000c', $q$insert into res select report_create('police', 56.9605, 24.1205)$q$);
select pg_temp.ok('F10: same type ≤ 150 m → merged into the existing one', (select (j->>'merged')::boolean from res));
delete from res;
select pg_temp.as_role('authenticated', 'f10c0000-0000-0000-0000-00000000000c', $q$insert into res select report_create('police', 56.9650, 24.1300)$q$);
select pg_temp.ok('F10: farther than 150 m → a new report', (select not (j->>'merged')::boolean from res));

-- At most 10 new reports per hour per account
select pg_temp.as_role('authenticated', 'f10b0000-0000-0000-0000-00000000000b',
  format($q$select report_create('pothole', %s, 24.5)$q$, 56.0 + i * 0.01)) from generate_series(1, 10) i;
select pg_temp.ok('F10: 10 per hour are accepted', (select count(*) = 10 from reports where user_id = 'f10b0000-0000-0000-0000-00000000000b'));
select pg_temp.ok('F10: the 11th within the hour is refused',
  pg_temp.as_role('authenticated', 'f10b0000-0000-0000-0000-00000000000b', $q$select report_create('pothole', 57.5, 24.5)$q$) like '%rate_limit%');
rollback;
