-- Minimal stand-in for what Supabase provides (roles, auth schema, auth.uid()) so the repo SQL files run on a plain
-- local PostgreSQL. Used ONLY by tests (tests/run-sql.sh and GitHub Actions) — never run this against Supabase.
create extension if not exists pgcrypto;
do $$ begin create role authenticated nologin; exception when others then null; end $$;
do $$ begin create role anon nologin; exception when others then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when others then null; end $$;
grant usage on schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
create schema auth;
create table auth.users (id uuid primary key, is_anonymous boolean default false, email text, email_confirmed_at timestamptz, created_at timestamptz default now(), last_sign_in_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
alter default privileges in schema public grant all on tables to authenticated, anon;
alter default privileges in schema public grant all on sequences to authenticated, anon;
-- Kā Supabase: jaunas funkcijas public shēmā pēc noklusējuma var izsaukt anon, authenticated, service_role
-- (tāpēc faili, kas grib funkciju paslēpt, raksta „revoke … from public, anon”)
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- A11: kā Supabase pg_cron (lokālajā PostgreSQL tā nav): cron.job, cron.job_run_details, cron.schedule / unschedule.
-- Darbus šeit neviens nepalaiž — tests tos izsauc pats (tests/cleanup-test.sql).
create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text not null, command text not null, active boolean not null default true);
create table cron.job_run_details (runid bigserial primary key, jobid bigint, status text, return_message text, start_time timestamptz, end_time timestamptz);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command, active = true returning jobid $$;
create function cron.unschedule(job_name text) returns boolean language sql as $$
  with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d) $$;
