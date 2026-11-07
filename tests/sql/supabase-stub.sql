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

