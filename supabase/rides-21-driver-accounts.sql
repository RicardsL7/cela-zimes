-- Ceļa Zīmes — šofera Stripe konta piesaisti raksta tikai servera funkcija ride-pay (audits 2, B10 — 10.11.2026).
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Var palaist atkārtoti (kamēr nav jaunāku).
-- Palaist PĒC rides-20-profiles-privacy.sql (secība — supabase/ORDER.txt, Nr. 35).
-- Servera funkciju ride-pay ar B10 labojumu var izvietot pirms vai pēc šī faila (tā izmanto jauno funkciju, ja tā ir,
-- citādi — veco ceļu); bez šī faila vecā politika paliek spēkā.
--
-- Problēma: politika "driver_accounts insert own" pārbaudīja tikai user_id — jebkurš pieteicies lietotājs varēja tieši caur
-- REST (POST /rest/v1/driver_accounts) ierakstīt sev JEBKURU Stripe konta ID (acct_…). ride-pay gan pirms maksājuma
-- pārbauda Stripe konta metadatus (cz_user = šofera ID), tāpēc nauda uz svešu kontu netiktu novirzīta, bet ieraksts
-- datubāzē bija nepatiess (piem. citu šoferu konts, kas bloķē paša šofera pieslēgšanos vai jauc kontu dzēšanu).
--
-- Labojums:
--   1) driver_account_link(p_user_id, p_acct) — ieraksta / nomaina šofera kontu; izpildīt var TIKAI service_role
--      (ride-pay ar Supabase iebūvēto servisa atslēgu, kas pārlūkā nenonāk). ride-pay to izsauc tikai pēc tam, kad
--      Stripe izveidojis kontu ar metadatiem cz_user = šis lietotājs.
--   2) Politika "driver_accounts insert own" dzēsta; anon un authenticated tabulā nevar ne INSERT, ne UPDATE.
--      Lasīt savu ierakstu un dzēst savu ierakstu (ride-pay to dara, ja Stripe konts vairs nepieder) — kā līdz šim.

do $$ begin
  if to_regprocedure('public.cz_migration_begin(integer, text)') is null
     or to_regprocedure('public.profile_visible(uuid)') is null then
    raise exception 'Vispirms palaid visus iepriekšējos failus līdz rides-20-profiles-privacy.sql (secība — supabase/ORDER.txt).';
  end if;
end $$;
select public.cz_migration_begin(35, 'rides-21-driver-accounts.sql');

create or replace function public.driver_account_link(p_user_id uuid, p_acct text) returns boolean
  language plpgsql security definer set search_path = public as
$$
begin
  if p_user_id is null then raise exception 'Nav lietotāja'; end if;
  if p_acct is null or p_acct !~ '^acct_[A-Za-z0-9]{6,40}$' then raise exception 'Nederīgs Stripe konta ID'; end if;
  if not exists (select 1 from profiles where id = p_user_id) then raise exception 'Nav profila'; end if;
  -- viens Stripe konts — vienam lietotājam
  if exists (select 1 from driver_accounts where acct = p_acct and user_id <> p_user_id) then
    raise exception 'Stripe konts jau piesaistīts citam lietotājam';
  end if;
  insert into driver_accounts (user_id, acct) values (p_user_id, p_acct)
    on conflict (user_id) do update set acct = excluded.acct, created_at = now();
  return true;
end
$$;
revoke all on function public.driver_account_link(uuid, text) from public, anon, authenticated;
grant execute on function public.driver_account_link(uuid, text) to service_role;

drop policy if exists "driver_accounts insert own" on public.driver_accounts;
revoke insert, update on public.driver_accounts from anon, authenticated;

select public.cz_migration_done(35, 'rides-21-driver-accounts.sql');

-- PĀRBAUDE PĒC PALAIŠANAS:
--   supabase/status.sql → „VISS KĀRTĪBĀ”
--   select polname from pg_policy where polrelid = 'public.driver_accounts'::regclass;   -- read own, delete own (bez insert)
--   select has_table_privilege('authenticated', 'public.driver_accounts', 'insert');      -- false
-- ATCELŠANA (nav ieteicama): create policy "driver_accounts insert own" ... ; grant insert on public.driver_accounts to authenticated;
