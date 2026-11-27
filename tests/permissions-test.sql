-- Permissions and protections of the FINAL database (audit 2, B17): what the app's roles (anon = without an account,
-- authenticated = with an account, service_role = server functions) may really do, read from PostgreSQL itself —
-- instead of searching the SQL files for "grant …" / "revoke …" text (a later file can change what an earlier one said).
-- Runs after all supabase/*.sql files. Local copy only — never against production. Prints PASS / FAIL.
\set QUIET 1
reset role;
create or replace function pg_temp.ok(n text, c boolean) returns void language plpgsql as $$ begin raise notice '%: %', case when c then 'PASS' else 'FAIL' end, n; end $$;
create or replace function pg_temp.can(r text, f text) returns boolean language sql as $$ select has_function_privilege(r, f, 'execute') $$;

-- ---------- Generic rules for every table and function ----------
select pg_temp.ok('every table in public has row level security on',
  not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity));
select pg_temp.ok('every SECURITY DEFINER function in public has a fixed search_path',
  not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
              and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')));
select pg_temp.ok('trigger functions that check who changes a row are NOT security definer (current_user must stay the caller)',
  (select not prosecdef from pg_proc where oid = 'public.ride_guard_participants'::regproc));

-- ---------- Tables read / written only through functions (no policies) ----------
select pg_temp.ok('no policies (only via functions): reports, report_votes, user_presence, app_admins, stripe_events, traffic_quota',
  not exists (select 1 from pg_policies where schemaname = 'public'
              and tablename in ('reports', 'report_votes', 'user_presence', 'app_admins', 'stripe_events', 'traffic_quota')));
select pg_temp.ok('stripe_events — the app has no table rights at all',
  not has_table_privilege('anon', 'public.stripe_events', 'select, insert, update, delete')
  and not has_table_privilege('authenticated', 'public.stripe_events', 'select, insert, update, delete'));

-- ---------- Ride rows: with an account only the status may be changed (A01) ----------
select pg_temp.ok('A01: ride_offers — the app may update only status',
  has_column_privilege('authenticated', 'public.ride_offers', 'status', 'update')
  and not has_column_privilege('authenticated', 'public.ride_offers', 'driver_id', 'update')
  and not has_column_privilege('authenticated', 'public.ride_offers', 'request_id', 'update')
  and not has_column_privilege('authenticated', 'public.ride_offers', 'price_cents', 'update')
  and not has_column_privilege('authenticated', 'public.ride_offers', 'trip', 'update')
  and not has_column_privilege('anon', 'public.ride_offers', 'status', 'update'));
select pg_temp.ok('A01: ride_requests — the app may update only status',
  has_column_privilege('authenticated', 'public.ride_requests', 'status', 'update')
  and not has_column_privilege('authenticated', 'public.ride_requests', 'user_id', 'update')
  and not has_column_privilege('authenticated', 'public.ride_requests', 'from_lat', 'update'));

-- ---------- Who may call which function ----------
select pg_temp.ok('F10: report list — also without an account; create / vote / delete — only with an account; internal — nobody',
  pg_temp.can('anon', 'public.report_list(float8, float8, float8, float8)') and pg_temp.can('authenticated', 'public.report_list(float8, float8, float8, float8)')
  and not pg_temp.can('anon', 'public.report_create(text, float8, float8, int, int)') and pg_temp.can('authenticated', 'public.report_create(text, float8, float8, int, int)')
  and not pg_temp.can('anon', 'public.report_vote(uuid, text)') and pg_temp.can('authenticated', 'public.report_vote(uuid, text)')
  and not pg_temp.can('anon', 'public.report_delete(uuid)') and pg_temp.can('authenticated', 'public.report_delete(uuid)')
  and not pg_temp.can('anon', 'public.report_vote_apply(uuid, uuid, text)') and not pg_temp.can('authenticated', 'public.report_vote_apply(uuid, uuid, text)'));
select pg_temp.ok('F15: "helping now" — also without an account',
  pg_temp.can('anon', 'public.traffic_helpers()') and pg_temp.can('authenticated', 'public.traffic_helpers()'));
select pg_temp.ok('F16 / F23: statistics — not without an account',
  not pg_temp.can('anon', 'public.admin_stats()') and not pg_temp.can('anon', 'public.my_stats()') and pg_temp.can('authenticated', 'public.my_stats()'));
select pg_temp.ok('F17: ride_payment_mark — only the server (service_role)',
  not pg_temp.can('anon', 'public.ride_payment_mark(uuid, uuid, text, text, text, int)')
  and not pg_temp.can('authenticated', 'public.ride_payment_mark(uuid, uuid, text, text, text, int)')
  and pg_temp.can('service_role', 'public.ride_payment_mark(uuid, uuid, text, text, text, int)'));
select pg_temp.ok('A02 / A04: accepting an offer and starting a card payment — not without an account',
  not pg_temp.can('anon', 'public.ride_offer_accept(uuid)') and pg_temp.can('authenticated', 'public.ride_offer_accept(uuid)')
  and not pg_temp.can('anon', 'public.ride_checkout_begin(uuid)'));
select pg_temp.ok('v124 / A16: other drivers — sending the own place and seeing others only with an account',
  not pg_temp.can('anon', 'public.presence_update(float8, float8, int, float8)') and pg_temp.can('authenticated', 'public.presence_update(float8, float8, int, float8)')
  and not pg_temp.can('anon', 'public.presence_nearby(float8, float8, float8)') and pg_temp.can('authenticated', 'public.presence_nearby(float8, float8, float8)'));
select pg_temp.ok('Coins: rewards only from the server; buying, wallet and confirming — only with an account',
  not pg_temp.can('anon', 'public.wallet_award(uuid, int, text, uuid)') and not pg_temp.can('authenticated', 'public.wallet_award(uuid, int, text, uuid)')
  and not pg_temp.can('anon', 'public.skin_buy(text)') and not pg_temp.can('anon', 'public.wallet_get()')
  and not pg_temp.can('anon', 'public.report_confirm(uuid, text, float8, float8, int, float8, float8, boolean)')
  and pg_temp.can('anon', 'public.skins_list()'));

-- ---------- Protections that must exist ----------
select pg_temp.ok('A02: at most one accepted offer per ride (unique index)',
  exists (select 1 from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = 'ride_offers_one_accepted' and i.indisunique
          and pg_get_expr(i.indpred, i.indrelid) like '%accepted%'));
select pg_temp.ok('A03: trip guard on new and changed offers; passenger cannot cancel after boarding',
  exists (select 1 from pg_trigger where tgname = 'ride_offers_guard_trip' and tgrelid = 'public.ride_offers'::regclass and tgtype & 4 = 4 and tgtype & 16 = 16)
  and exists (select 1 from pg_trigger where tgname = 'ride_requests_guard_started' and tgrelid = 'public.ride_requests'::regclass));
select pg_temp.ok('A01: participants cannot be swapped (trigger on both ride tables)',
  (select count(*) = 2 from pg_trigger where tgfoid = 'public.ride_guard_participants'::regproc));
select pg_temp.ok('F14: payment status is guarded by a trigger',
  exists (select 1 from pg_trigger where tgname = 'ride_payment_guard' and tgrelid = 'public.ride_payments'::regclass));
select pg_temp.ok('Coins: daily cap 100; report_types defaults 10 coins, +5 author, ≤ 2 × lifetime',
  coin_daily_cap() = 100
  and (select pg_get_expr(adbin, adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'public.report_types'::regclass and a.attname = 'coin_reward') = '10'
  and (select pg_get_expr(adbin, adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'public.report_types'::regclass and a.attname = 'author_bonus') = '5'
  and (select pg_get_expr(adbin, adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'public.report_types'::regclass and a.attname = 'max_lifetime_factor') = '2');
select pg_temp.ok('F23: statistics functions do not change data (STABLE)',
  (select bool_and(provolatile = 's') from pg_proc where oid in ('public.my_stats'::regproc, 'public.admin_stats'::regproc)));
