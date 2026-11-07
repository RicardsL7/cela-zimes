-- Ceļa Zīmes — kopbraucieni, 13. daļa: drošības labojums A01 (audits 07.11.2026).
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Var palaist atkārtoti.
-- Palaist PĒC visiem iepriekšējiem rides*.sql failiem.
--
-- Problēma: pasažieris ar tiešu REST pieprasījumu varēja savam piedāvājumam nomainīt šoferi (driver_id) uz jebkuru
-- citu lietotāju, atzīmēt to kā pieņemtu un tad redzēt šī cilvēka tālruni (contacts_read → matched_with).
--
-- Labojums — divi neatkarīgi slāņi:
--   1) Trigeris: piedāvājuma šoferi un pieprasījumu, kā arī pieprasījuma autoru pēc izveides klients mainīt nevar.
--      Servera funkcijas (security definer, piem. kontu apvienošana account_transfer_claim) to drīkst — tās
--      darbojas kā funkcijas īpašnieks, nevis kā 'authenticated'.
--   2) Tiesības pa kolonnām: lietotne šīs tabulas maina tikai ar {status}; visu pārējo maina servera funkcijas.
--      Tāpēc 'authenticated' drīkst UPDATE tikai kolonnu status; 'anon' — neko. (Tas arī aizliedz pasažierim
--      tieši mainīt brauciena gaitu trip — daļa no A03.)
-- Lasīšana, ievietošana un dzēšana nemainās. RLS politikas paliek kā līdz šim.

create or replace function public.ride_guard_participants() returns trigger
  language plpgsql set search_path = public as
$$ begin
  -- Tikai klienta lomas; servera funkcijas un service_role šeit netiek ierobežotas
  if current_user in ('authenticated', 'anon') then
    if tg_table_name = 'ride_offers' then
      if new.id is distinct from old.id or new.driver_id is distinct from old.driver_id
         or new.request_id is distinct from old.request_id then
        raise exception 'Piedāvājuma šoferi un braucienu mainīt nevar' using errcode = '42501';
      end if;
    elsif tg_table_name = 'ride_requests' then
      if new.id is distinct from old.id or new.user_id is distinct from old.user_id then
        raise exception 'Pieprasījuma autoru mainīt nevar' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists ride_offers_guard_participants on public.ride_offers;
create trigger ride_offers_guard_participants before update on public.ride_offers
  for each row execute function public.ride_guard_participants();
drop trigger if exists ride_requests_guard_participants on public.ride_requests;
create trigger ride_requests_guard_participants before update on public.ride_requests
  for each row execute function public.ride_guard_participants();

-- Tiesības pa kolonnām (lietotne sūta tikai PATCH {status})
revoke update on public.ride_offers from public, anon, authenticated;
revoke update on public.ride_requests from public, anon, authenticated;
grant update (status) on public.ride_offers to authenticated;
grant update (status) on public.ride_requests to authenticated;

-- PĀRBAUDE PĒC PALAIŠANAS (palaid atsevišķi; visām trim kolonnām jābūt true):
--   select has_column_privilege('authenticated', 'public.ride_offers', 'status', 'UPDATE')        as var_mainit_statusu,
--          not has_column_privilege('authenticated', 'public.ride_offers', 'driver_id', 'UPDATE') as nevar_mainit_soferi,
--          exists (select 1 from pg_trigger where tgname = 'ride_offers_guard_participants')     as trigeris_ir;
--
-- ATCELŠANA (tikai ja kaut kas salūzt; atjauno iepriekšējo stāvokli ar A01 kļūdu):
--   drop trigger if exists ride_offers_guard_participants on public.ride_offers;
--   drop trigger if exists ride_requests_guard_participants on public.ride_requests;
--   grant update on public.ride_offers, public.ride_requests to authenticated;
