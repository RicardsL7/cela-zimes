-- Ceļa Zīmes — kopbraucienu profili (vārds, auto) redzami tikai brauciena otrai pusei (audits 2, B09 — 10.11.2026).
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Var palaist atkārtoti (kamēr nav jaunāku).
-- Palaist PĒC radars-2-votes.sql (secība — supabase/ORDER.txt, Nr. 34).
--
-- Problēma: politika profiles_read = true — jebkurš pieteicies konts (arī tikko izveidots anonīms) varēja nolasīt
-- VISUS profilus (vārds, auto apraksts) ar vienu pieprasījumu: lietotāju saraksta savākšana.
--
-- Labojums: profilu redz tikai
--   1) pats savu;
--   2) pasažieris — šoferi, kurš viņa pieprasījumam iesūtīja piedāvājumu (lai var izvēlēties; arī vēsturē);
--   3) šoferis — pasažieri, kurš viņa piedāvājumu PIEŅĒMA (was_accepted — arī pēc atcelšanas, vēsturei).
-- Tas pats princips kā tālrunim (contacts → matched_with) un precīzajam pieprasījumam (B02 → ride_request_exact).
-- Servera funkcijas (braucienu vēsture, administrators, kontu apvienošana) ir security definer — tās tas neietekmē.

do $$ begin
  if to_regprocedure('public.cz_migration_begin(integer, text)') is null
     or to_regprocedure('public.ride_request_exact(uuid)') is null then
    raise exception 'Vispirms palaid visus iepriekšējos failus līdz radars-2-votes.sql (secība — supabase/ORDER.txt).';
  end if;
end $$;
select public.cz_migration_begin(34, 'rides-20-profiles-privacy.sql');

create or replace function public.profile_visible(other uuid) returns boolean
  language sql stable security definer set search_path = public as
$$
  select other = auth.uid()
      or exists (select 1 from ride_offers o join ride_requests r on r.id = o.request_id
                  where r.user_id = auth.uid() and o.driver_id = other)                       -- man piedāvāja braucienu
      or exists (select 1 from ride_offers o join ride_requests r on r.id = o.request_id
                  where o.driver_id = auth.uid() and o.was_accepted and r.user_id = other)    -- pieņēma manu piedāvājumu
$$;
revoke all on function public.profile_visible(uuid) from public, anon;
grant execute on function public.profile_visible(uuid) to authenticated;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (public.profile_visible(id));

-- Ātrumam (politiku pārbauda katrai rindai): piedāvājumi pēc šofera, pieprasījumi pēc lietotāja
-- (piedāvājumi pēc pieprasījuma — jau ir: unique (request_id, driver_id))
create index if not exists ride_offers_driver_idx on public.ride_offers (driver_id);
create index if not exists ride_requests_user_idx on public.ride_requests (user_id);

select public.cz_migration_done(34, 'rides-20-profiles-privacy.sql');

-- PĀRBAUDE PĒC PALAIŠANAS:
--   supabase/status.sql → „VISS KĀRTĪBĀ”
--   select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'profiles_read';   -- profile_visible(id)
-- ATCELŠANA (nav ieteicama): create policy profiles_read ... using (true) — atkal atvērtu visu lietotāju sarakstu.
