-- Ceļa Zīmes — vecu datu regulāra tīrīšana (audits A11, 08.11.2026).
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Var palaist atkārtoti (kamēr nav jaunāku).
-- Palaist PĒC rides-17-migrations.sql (secība — supabase/ORDER.txt, Nr. 27).
--
-- Problēma: veci dati tika dzēsti tikai tad, kad kāds rakstīja jaunus (ziņojums, sastrēgumu mērījums, vieta kartē).
-- Ja neviens neraksta, dati paliek ilgāk, nekā solīts privātuma politikā (privacy.html, 9. punkts).
--
-- Labojums:
--   1) cz_cleanup() — dzēš visu, kam beidzies glabāšanas laiks (tieši pēc privacy.html):
--        ziņojumi (un to atzīmes / apstiprinājumu dati — kaskādē)  derīguma beigas + 2 dienas
--        ātruma mērījumi                                           28 dienas
--        mērījumu skaita ieraksti                                  1 diena
--        vieta citu kartē                                          5 min bez atjaunošanas (palaiž ik 5 min → ≤ 10 min)
--        konta pārneses kodi                                       pēc derīguma beigām
--        Stripe notikumu ID (dublikātu pārbaudei)                  90 dienas
--      un novecojušos braucienus (ride_expire — kā līdz šim darīja lietotne). Katrs solis atsevišķi: ja viens
--      neizdodas, pārējie tik un tā notiek, kļūda tiek pierakstīta.
--   2) Plānotājs pg_cron: darbs „cz-cleanup” ik 5 minūtes (Supabase iebūvēts; ja nav ieslēgts — šis fails ieslēdz).
--   3) cz_cleanup_runs — katras palaišanas pieraksts (laiks, cik izdzēsts, kļūdas); glabā 7 dienas.
--   4) Brīdinājums par kļūmēm:
--        cz_cleanup_status() — īpašnieka panelim (admin.html, tikai is_app_admin());
--        cz_health() — tikai „vai tīrīšana strādā” (bez datiem); to ik stundu pārbauda GitHub Actions „Uzraudzība”
--        un, ja nestrādā, GitHub atsūta e-pastu.
--
-- Datus, kas jāglabā līdz konta dzēšanai (konts, braucieni, čats, monētas …), šis fails neaiztiek.

-- Vai iepriekšējie faili palaisti? (cz_migration_begin — rides-17-migrations.sql)
do $$ begin
  if to_regprocedure('public.cz_migration_begin(integer, text)') is null then
    raise exception 'Vispirms palaid visus iepriekšējos failus līdz rides-17-migrations.sql (secība — supabase/ORDER.txt).';
  end if;
end $$;
select public.cz_migration_begin(27, 'cleanup-1.sql');

-- ---------- 1) Palaišanu pieraksts ----------
create table if not exists public.cz_cleanup_runs (
  id          bigint generated always as identity primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean not null default false,
  deleted     jsonb not null default '{}'::jsonb,
  errors      text
);
create index if not exists cz_cleanup_runs_started on public.cz_cleanup_runs (started_at);
alter table public.cz_cleanup_runs enable row level security;      -- bez politikām: lietotnei nekas nav redzams
revoke all on public.cz_cleanup_runs from public, anon, authenticated;

-- vieta citu kartē: pēc atjaunošanas laika (ātra dzēšana)
create index if not exists user_presence_updated on public.user_presence (updated_at);
create index if not exists account_transfers_expires on public.account_transfers (expires_at);

-- ---------- 2) Tīrīšana ----------
create or replace function public.cz_cleanup() returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare
  run_id bigint; d jsonb := '{}'::jsonb; errs text[] := '{}'; k int;
begin
  insert into cz_cleanup_runs default values returning id into run_id;

  begin delete from reports where expires_at < now() - interval '2 days';
        get diagnostics k = row_count; d := d || jsonb_build_object('reports', k);
  exception when others then errs := errs || ('reports: ' || sqlerrm); end;

  begin delete from traffic_samples where at < now() - interval '28 days';
        get diagnostics k = row_count; d := d || jsonb_build_object('traffic_samples', k);
  exception when others then errs := errs || ('traffic_samples: ' || sqlerrm); end;

  begin delete from traffic_quota where window_start < now() - interval '1 day';
        get diagnostics k = row_count; d := d || jsonb_build_object('traffic_quota', k);
  exception when others then errs := errs || ('traffic_quota: ' || sqlerrm); end;

  begin delete from user_presence where updated_at < now() - interval '5 minutes';
        get diagnostics k = row_count; d := d || jsonb_build_object('user_presence', k);
  exception when others then errs := errs || ('user_presence: ' || sqlerrm); end;

  begin delete from account_transfers where expires_at < now();
        get diagnostics k = row_count; d := d || jsonb_build_object('account_transfers', k);
  exception when others then errs := errs || ('account_transfers: ' || sqlerrm); end;

  begin delete from stripe_events where created_at < now() - interval '90 days';
        get diagnostics k = row_count; d := d || jsonb_build_object('stripe_events', k);
  exception when others then errs := errs || ('stripe_events: ' || sqlerrm); end;

  begin k := ride_expire(); d := d || jsonb_build_object('rides_expired', k);
  exception when others then errs := errs || ('ride_expire: ' || sqlerrm); end;

  -- Plānotāja paša vēsture (pg_cron to netīra): 7 dienas
  begin
    if to_regclass('cron.job_run_details') is not null then
      execute 'delete from cron.job_run_details where end_time < now() - interval ''7 days''';
      get diagnostics k = row_count; d := d || jsonb_build_object('cron_history', k);
    end if;
  exception when others then errs := errs || ('cron_history: ' || sqlerrm); end;

  delete from cz_cleanup_runs where started_at < now() - interval '7 days';

  update cz_cleanup_runs
     set finished_at = clock_timestamp(), ok = cardinality(errs) = 0, deleted = d,
         errors = nullif(array_to_string(errs, E'\n'), '')
   where id = run_id;
  return jsonb_build_object('ok', cardinality(errs) = 0, 'deleted', d, 'errors', to_jsonb(errs));
end
$$;
revoke all on function public.cz_cleanup() from public, anon, authenticated;

-- ---------- 3) Stāvoklis īpašniekam (admin.html) ----------
create or replace function public.cz_cleanup_status() returns jsonb
  language plpgsql stable security definer set search_path = public as
$$
declare sched text; lr cz_cleanup_runs%rowtype; last_ok timestamptz;
begin
  if not is_app_admin() then raise exception 'forbidden'; end if;
  begin
    execute 'select schedule from cron.job where jobname = $1 and active' into sched using 'cz-cleanup';
  exception when others then sched := null; end;
  select * into lr from cz_cleanup_runs where finished_at is not null order by started_at desc limit 1;
  select max(finished_at) into last_ok from cz_cleanup_runs where ok;
  return jsonb_build_object(
    'scheduled', sched is not null, 'schedule', sched,
    'last_run_at', lr.finished_at, 'last_ok', lr.ok, 'last_errors', lr.errors, 'last_deleted', lr.deleted,
    'last_ok_at', last_ok,
    'runs_24h', (select count(*) from cz_cleanup_runs where started_at > now() - interval '1 day' and finished_at is not null),
    'failed_24h', (select count(*) from cz_cleanup_runs where started_at > now() - interval '1 day' and finished_at is not null and not ok),
    'deleted_24h', (select coalesce(jsonb_object_agg(key, total), '{}'::jsonb) from (
        select e.key, sum(e.value::bigint) as total from cz_cleanup_runs r, jsonb_each_text(r.deleted) e
        where r.started_at > now() - interval '1 day' group by e.key) t),
    'healthy', sched is not null and last_ok > now() - interval '20 minutes');
end
$$;
revoke all on function public.cz_cleanup_status() from public, anon;
grant execute on function public.cz_cleanup_status() to authenticated;

-- ---------- 4) Uzraudzībai (GitHub Actions): tikai „strādā / nestrādā”, bez datiem ----------
create or replace function public.cz_health() returns jsonb
  language sql stable security definer set search_path = public as
$$ select jsonb_build_object(
     'cleanup_ok', coalesce((select max(finished_at) from cz_cleanup_runs where ok) > now() - interval '20 minutes', false),
     'cleanup_minutes', (select case when max(finished_at) is not null then greatest(0, floor(extract(epoch from now() - max(finished_at)) / 60))::int end
                         from cz_cleanup_runs where ok)) $$;
revoke all on function public.cz_health() from public;
grant execute on function public.cz_health() to anon, authenticated;

-- ---------- 5) Plānotājs (pg_cron) ----------
do $$ begin
  if to_regnamespace('cron') is null then
    if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
      raise exception 'Plānotājs pg_cron nav pieejams. Supabase → Integrations → Cron → ieslēdz, tad palaid šo failu vēlreiz.';
    end if;
    create extension if not exists pg_cron with schema pg_catalog;
  end if;
end $$;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
-- Tas pats nosaukums aizstāj esošo darbu (atkārtoti palaižot dublikāts neveidojas)
select cron.schedule('cz-cleanup', '*/5 * * * *', 'select public.cz_cleanup()');

-- Uzreiz notīra visu, kas jau novecojis
select public.cz_cleanup();

select public.cz_migration_done(27, 'cleanup-1.sql');

-- PĀRBAUDE PĒC PALAIŠANAS:
--   select jobname, schedule, active from cron.job where jobname = 'cz-cleanup';          -- */5 * * * *, true
--   select started_at, ok, deleted, errors from public.cz_cleanup_runs order by id desc limit 5;
--   (pēc ~10 min) select public.cz_health();                                              -- "cleanup_ok": true
-- ATCELŠANA: select cron.unschedule('cz-cleanup');   (dati, kas jau izdzēsti, neatgriežas)
