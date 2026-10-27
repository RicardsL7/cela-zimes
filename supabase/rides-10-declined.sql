-- Ceļa Zīmes — kopbraucieni, 10. daļa (labojums F12): kad piedāvājums pieņemts / noraidīts.
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Var palaist atkārtoti.
--
-- Kāpēc: šoferim noraidītais piedāvājums vēl ~10 min jārāda ar „Pasažieris izvēlējās citu šoferi”.
-- Lai zinātu, KAD tas noraidīts (arī ja šofera lietotne tobrīd bija aizvērta), datubāze pieraksta laiku.
-- Ieraksti netiek dzēsti — noraidījums jau līdz šim bija statuss 'declined'.

alter table public.ride_offers add column if not exists responded_at timestamptz;

-- Laiku uzliek pati datubāze (klients to mainīt nevar), kad statuss kļūst 'accepted' vai 'declined'
create or replace function public.ride_offer_responded() returns trigger
  language plpgsql set search_path = public as
$$ begin
  if tg_op = 'INSERT' then
    new.responded_at := null;
  elsif new.status is distinct from old.status and new.status in ('accepted', 'declined') then
    new.responded_at := now();
  else
    new.responded_at := old.responded_at;
  end if;
  return new;
end $$;
drop trigger if exists ride_offer_responded on public.ride_offers;
create trigger ride_offer_responded before insert or update on public.ride_offers
  for each row execute function public.ride_offer_responded();
