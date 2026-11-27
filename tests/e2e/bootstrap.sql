-- B17 (audits 2): lokālā „Supabase” E2E testiem — tas, ko Supabase sagatavo datubāzē pirms Auth (GoTrue) un PostgREST.
-- Tikai testiem (tests/e2e/stack.js), tikai TUKŠĀ lokālā datubāzē. NEKAD nepalaid pret Supabase / produkciju.
-- Paroles zemāk ir tikai šai pagaidu lokālajai datubāzei (tā tiek izveidota un izdzēsta testa laikā).
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
do $$ begin create role anon nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin noinherit bypassrls; exception when duplicate_object then null; end $$;
-- PostgREST pieslēdzas kā authenticator un pārslēdzas uz lomu no JWT (anon / authenticated / service_role)
do $$ begin create role authenticator login noinherit password 'cz-e2e-local'; exception when duplicate_object then null; end $$;
grant anon, authenticated, service_role to authenticator;
-- Auth (GoTrue) pats izveido savas tabulas shēmā auth (savas migrācijas) — kā Supabase
do $$ begin create role supabase_auth_admin login noinherit createrole password 'cz-e2e-local'; exception when duplicate_object then null; end $$;
create schema if not exists auth authorization supabase_auth_admin;
do $$ begin execute format('grant create, connect on database %I to supabase_auth_admin', current_database()); end $$;
alter role supabase_auth_admin set search_path = auth;
grant usage on schema auth to anon, authenticated, service_role;
alter default privileges for role supabase_auth_admin in schema auth grant execute on functions to anon, authenticated, service_role;
-- Kā Supabase: public shēmas tiesības (tabulas — RLS; funkcijas — kā noklusēti Supabase)
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
-- pg_cron aizstājējs (kā tests/sql/supabase-stub.sql) — darbus neviens nepalaiž
create schema if not exists cron;
create table if not exists cron.job (jobid bigserial primary key, jobname text unique, schedule text not null, command text not null, active boolean not null default true);
create table if not exists cron.job_run_details (runid bigserial primary key, jobid bigint, status text, return_message text, start_time timestamptz, end_time timestamptz);
create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command, active = true returning jobid $$;
create or replace function cron.unschedule(job_name text) returns boolean language sql as $$
  with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d) $$;
