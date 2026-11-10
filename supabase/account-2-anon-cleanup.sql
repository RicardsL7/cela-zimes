-- Ceļa Zīmes — nelietotu anonīmu kontu automātiska dzēšana (audits 2, B07 — 10.11.2026).
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Var palaist atkārtoti (kamēr nav jaunāku).
-- Palaist PĒC rides-19-cost-share.sql (secība — supabase/ORDER.txt, Nr. 32).
--
-- Problēma: anonīmus kontus var veidot bez ierobežojuma (to ierobežo CAPTCHA — captcha.js), un nelietoti konti
-- auth.users palika mūžīgi (kopā ar monētām, profilu u.c.).
--
-- Labojums (īpašnieka lēmums 10.11.2026 — 180 dienas):
--   1) account_erase(uid) — tā pati dzēšana kā delete_my_account (viena vieta abiem); delete_my_account to izmanto.
--   2) cz_anon_cleanup() — dzēš anonīmus kontus (is_anonymous, bez e-pasta), kas 180 dienas nav pieslēgušies serverim:
--        pēdējā darbība = jaunākais no konta izveides, pieslēgšanās un sesijas atjaunošanas (auth.sessions —
--        lietotne to atjauno vismaz ik stundu, kamēr to lieto). Ja auth.sessions nevar nolasīt — NEdzēš neko (kļūda).
--      Nedzēš: ja ir aktīvs brauciens / nepabeigts maksājums / neatgriezta nauda (account_delete_blockers) vai šofera
--      Stripe konts (to jāslēdz ride-pay — dzēšot pašam). Ne vairāk kā 500 vienā reizē.
--      Katra palaišana — rinda cz_cleanup_runs (deleted: anon_accounts, anon_skipped) → redzams admin.html.
--   3) Plānotājs: „cz-anon-cleanup” katru nakti 02:23 (UTC).
-- Konta dzēšana kā A15: otra brauciena dalībnieka vēsture paliek (ride_profile_erase), monētas un tēli pazūd.

do $$ begin
  if to_regprocedure('public.cz_migration_begin(integer, text)') is null then
    raise exception 'Vispirms palaid visus iepriekšējos failus līdz rides-19-cost-share.sql (secība — supabase/ORDER.txt).';
  end if;
end $$;
select public.cz_migration_begin(32, 'account-2-anon-cleanup.sql');

-- ---------- 1) Konta dzēšana — viena vieta ----------
create or replace function public.account_erase(me uuid) returns void
  language plpgsql security definer set search_path = public as
$$
begin
  delete from user_stat_counters where user_id = me;                -- F16
  delete from user_reports where reporter_id = me;
  update user_reports set reported_id = null where reported_id = me;
  delete from traffic_quota where uid = me;
  delete from account_transfers where from_user = me;
  delete from auth.users where id = me;                             -- profils → ride_profile_erase (account-1-delete.sql)
end
$$;
revoke all on function public.account_erase(uuid) from public, anon, authenticated;

create or replace function public.delete_my_account(p_unclosed_acct text default null) returns boolean
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); chk jsonb;
begin
  if me is null then raise exception 'Nav pieteicies'; end if;
  perform pg_advisory_xact_lock(hashtext('cz-delete-' || me::text));
  chk := account_delete_blockers(me);
  if not (chk->>'ok')::boolean then
    raise exception 'account_busy: kontu dzēst vēl nevar — ir aktīvs brauciens vai nepabeigts maksājums'
      using errcode = 'P0001', detail = (chk->'blockers')::text;
  end if;
  if p_unclosed_acct is not null and exists (select 1 from driver_accounts where user_id = me and acct = p_unclosed_acct) then
    insert into account_closures (acct) values (p_unclosed_acct) on conflict do nothing;
  end if;
  perform account_erase(me);
  return true;
end
$$;
revoke all on function public.delete_my_account(text) from public, anon;
grant execute on function public.delete_my_account(text) to authenticated;

-- ---------- 2) Nelietoti anonīmi konti ----------
create or replace function public.cz_anon_cleanup(p_days int default 180, p_limit int default 500) returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare
  run_id bigint; n int := 0; skipped int := 0; errs text[] := '{}'; u record;
begin
  if p_days < 90 then raise exception 'Pārāk īss termiņš: %', p_days; end if;       -- aizsardzība pret kļūdu
  insert into cz_cleanup_runs default values returning id into run_id;
  for u in
    select a.id
    from auth.users a
    where a.is_anonymous and a.email is null
      and a.created_at < now() - make_interval(days => p_days)
      and greatest(a.created_at, coalesce(a.last_sign_in_at, a.created_at)) < now() - make_interval(days => p_days)
      and not exists (select 1 from auth.sessions s where s.user_id = a.id
                      and greatest(s.created_at, coalesce(s.updated_at, s.created_at),
                                   coalesce(s.refreshed_at at time zone 'UTC', s.created_at)) >= now() - make_interval(days => p_days))
    order by a.created_at
    limit p_limit
  loop
    begin
      if exists (select 1 from driver_accounts where user_id = u.id)
         or not (account_delete_blockers(u.id)->>'ok')::boolean then
        skipped := skipped + 1;
      else
        perform pg_advisory_xact_lock(hashtext('cz-delete-' || u.id::text));
        perform account_erase(u.id);
        n := n + 1;
      end if;
    exception when others then errs := errs || (u.id::text || ': ' || sqlerrm);
    end;
  end loop;
  update cz_cleanup_runs
     set finished_at = clock_timestamp(), ok = cardinality(errs) = 0,
         deleted = jsonb_build_object('anon_accounts', n, 'anon_skipped', skipped),
         errors = nullif(array_to_string(errs, E'\n'), '')
   where id = run_id;
  return jsonb_build_object('ok', cardinality(errs) = 0, 'deleted', n, 'skipped', skipped, 'errors', to_jsonb(errs));
end
$$;
revoke all on function public.cz_anon_cleanup(int, int) from public, anon, authenticated;

-- ---------- 3) Plānotājs ----------
select cron.schedule('cz-anon-cleanup', '23 2 * * *', 'select public.cz_anon_cleanup()');

select public.cz_migration_done(32, 'account-2-anon-cleanup.sql');

-- PĀRBAUDE PĒC PALAIŠANAS:
--   supabase/status.sql → „VISS KĀRTĪBĀ”
--   select jobname, schedule, active from cron.job where jobname = 'cz-anon-cleanup';     -- 23 2 * * *, true
--   Cik kontu tiktu dzēsti (neko nedzēš):
--   select count(*) from auth.users a where a.is_anonymous and a.email is null and a.created_at < now() - interval '180 days';
-- ATCELŠANA: select cron.unschedule('cz-anon-cleanup');   (dzēsti konti neatgriežas)
