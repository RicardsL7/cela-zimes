-- Scenario test for supabase/client-errors.sql (audit 2, B12). Local copy only — never against production.
-- One transaction, rolled back. Prints PASS / FAIL.
\set QUIET 1
reset role;
create or replace function pg_temp.ok(n text, c boolean) returns void language plpgsql as $$ begin raise notice '%: %', case when c then 'PASS' else 'FAIL' end, n; end $$;
create or replace function pg_temp.ex(u uuid, sql text, r text default 'authenticated') returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
  execute 'set local role ' || r;
  begin execute sql; exception when others then reset role; return sqlerrm; end;
  reset role; return null;
end $$;
create temp table out (b boolean);
grant all on out to anon, authenticated;

begin;
delete from client_errors;
insert into auth.users (id) values ('b1200000-0000-0000-0000-00000000000a'), ('b1200000-0000-0000-0000-00000000000b');
insert into app_admins (user_id) values ('b1200000-0000-0000-0000-00000000000a');

create temp table r1 as select pg_temp.ex(null, $s$insert into out select client_error('{"kind":"error","msg":"TypeError: x is undefined","src":"app-gl.js","line":120,"col":7,"ver":"165","page":"app","browser":"Chrome 131"}')$s$, 'anon') as err;
select pg_temp.ok('B12: anon can report an error (app works without an account)',
  (select err is null from r1) and (select bool_and(b) from out)
  and (select ver = '165' and page = 'app' and browser = 'Chrome 131' and line = 120 from client_errors));
create temp table r2 as select pg_temp.ex('b1200000-0000-0000-0000-00000000000b', $s$select client_error('{"kind":"error","msg":"TypeError: x is undefined","src":"app-gl.js","line":120}')$s$) as err;
select pg_temp.ok('B12: the same error again — one row, counter 2',
  (select err is null from r2) and (select count(*) = 1 and max(n) = 2 from client_errors));
select pg_temp.ok('B12: the table itself is not readable or writable by the app',
  pg_temp.ex(null, 'select count(*) from client_errors', 'anon') ~ 'permission denied'
  and pg_temp.ex('b1200000-0000-0000-0000-00000000000b', $s$insert into client_errors (fp, kind, msg) values ('x', 'error', 'x')$s$) ~ 'permission denied');

-- scrubbing on the server
select client_error(jsonb_build_object('kind', 'rejection', 'msg',
  'fail for anna.ozola@example.lv token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc key sk_test_ABCDEF123456 at 56.95123,24.10567 order 12345678 url /x?lat=56.9&k=1',
  'src', 'https://growlab.cc/app-gl.js?v=165#top'));
select pg_temp.ok('B12: e-mail, JWT, keys, coordinates, long numbers and URL parameters are removed',
  (select msg !~ '@|eyJ|sk_test|56\.951|24\.105|12345678|lat=' and src = 'https://growlab.cc/app-gl.js' from client_errors where kind = 'rejection'));
select pg_temp.ok('B12: invalid input refused (kind, empty text, non-object)',
  not client_error('{"kind":"hack","msg":"x"}') and not client_error('{"kind":"error","msg":"   "}') and not client_error('[1,2]')
  and not client_error(null));
select client_error(('{"kind":"report","msg":"' || repeat('a', 2000) || '","ver":"<script>","page":"evil","browser":"x; drop table"}')::jsonb);
select pg_temp.ok('B12: lengths cut, bad version / page / browser normalised',
  (select length(msg) = 300 and ver = '' and page = 'other' and browser = '' from client_errors where kind = 'report'));

-- at most 300 new errors a day; known ones still counted
insert into client_errors (fp, kind, msg) select 'f' || g, 'error', 'e' || g from generate_series(1, 300) g;
create temp table r3 as select client_error('{"kind":"error","msg":"brand new"}') as a,
  client_error('{"kind":"error","msg":"TypeError: x is undefined","src":"app-gl.js","line":120}') as b;
select pg_temp.ok('B12: more than 300 different errors a day — new ones refused, known ones still counted',
  (select not a and b from r3) and (select n from client_errors where msg = 'TypeError: x is undefined') = 3
  and not exists (select 1 from client_errors where msg = 'brand new'));

-- admin view
create temp table seen (c int);
grant all on seen to authenticated;
create temp table r4 as select pg_temp.ex('b1200000-0000-0000-0000-00000000000b', 'select * from admin_client_errors(7)') as e1,
  pg_temp.ex('b1200000-0000-0000-0000-00000000000a', 'insert into seen select count(*) from admin_client_errors(7)') as e2;
select pg_temp.ok('B12: non-admin cannot read the list; admin can',
  (select e1 ~ 'forbidden' and e2 is null from r4) and (select c from seen) > 300);
select pg_temp.ok('B12: anon cannot call the admin list',
  pg_temp.ex(null, 'select * from admin_client_errors(7)', 'anon') ~ 'permission denied');

-- retention 30 days
update client_errors set day = day - 31 where msg = 'e1';
create temp table del as select public.cz_client_errors_cleanup() as n;
select pg_temp.ok('B12: entries older than 30 days are deleted nightly',
  (select n from del) = 1 and not exists (select 1 from client_errors where msg = 'e1')
  and exists (select 1 from cron.job where jobname = 'cz-client-errors' and schedule = '51 2 * * *'));
rollback;
