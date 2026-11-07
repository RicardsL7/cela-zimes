-- Ceļa Zīmes — kopbraucieni, 14. daļa: drošības labojums A02 (audits 07.11.2026). Vienam pieprasījumam — viens šoferis.
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Var palaist atkārtoti.
-- Palaist PĒC rides-13-guard.sql.
--
-- Problēma: piedāvājuma pieņemšana bija trīs atsevišķi pieprasījumi no pārlūka (pieņemt → pieprasījums „matched” →
-- noraidīt pārējos). Divās cilnēs vai pēc tīkla kļūmes vienam pieprasījumam varēja būt divi pieņemti šoferi vai
-- pieņemts piedāvājums ar atvērtu pieprasījumu.
--
-- Labojums:
--   1) ride_offer_accept(oid) — viss vienā transakcijā; pieprasījuma rinda tiek bloķēta (FOR UPDATE), tāpēc divi
--      vienlaicīgi mēģinājumi notiek pēc kārtas, un otrais saņem kļūdu. Atkārtots tā paša piedāvājuma pieņemšanas
--      pieprasījums ir drošs (atgriež already=true).
--   2) Unikāls indekss: vienam pieprasījumam ne vairāk kā viens piedāvājums ar statusu 'accepted'.
--      Ja datubāzē jau ir pārkāpumi, indekss NETIEK izveidots — tiek parādīts paziņojums ar sarakstu (skat. beigās).
--   3) Statusu pārejas, ko drīkst klients (lietotne) tieši:
--        piedāvājumam: pending → declined (pasažieris), pending/accepted/declined → cancelled (šoferis);
--        pieprasījumam: open/matched → cancelled (pasažieris).
--      Viss pārējais (accepted, matched, open, done) — tikai caur servera funkcijām.
-- Lietotne (rides.js) jau izsauc ride_offer_accept; ja šī faila vēl nav, tā izmanto veco ceļu.

-- ---------- 1) Pieņemšana vienā transakcijā ----------
create or replace function public.ride_offer_accept(oid uuid) returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); rid uuid; r ride_requests%rowtype; o ride_offers%rowtype;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select request_id into rid from ride_offers where id = oid;           -- request_id nemaināms (rides-13-guard.sql)
  if rid is null then raise exception 'offer_not_found'; end if;
  select * into r from ride_requests where id = rid for update;         -- viens pieņemšanas mēģinājums vienlaikus
  if r.user_id is distinct from me then raise exception 'offer_not_found'; end if;   -- svešam neatklāj, ka tāds ir
  select * into o from ride_offers where id = oid for update;
  if o.status = 'accepted' and r.status = 'matched' then
    return jsonb_build_object('ok', true, 'already', true, 'request_id', rid);       -- atkārtots klikšķis / atbilde pazuda
  end if;
  if r.status <> 'open' then raise exception 'request_not_open'; end if;
  if o.status <> 'pending' then raise exception 'offer_not_pending'; end if;
  update ride_offers set status = 'accepted' where id = oid;
  update ride_requests set status = 'matched' where id = rid;
  update ride_offers set status = 'declined' where request_id = rid and status = 'pending' and id <> oid;
  return jsonb_build_object('ok', true, 'already', false, 'request_id', rid);
end
$$;
revoke all on function public.ride_offer_accept(uuid) from public, anon;
grant execute on function public.ride_offer_accept(uuid) to authenticated;

-- ---------- 2) Viens pieņemts piedāvājums uz pieprasījumu ----------
do $$
declare bad text;
begin
  if exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'ride_offers_one_accepted') then return; end if;
  select string_agg(request_id::text || ' (' || n || ')', ', ') into bad
    from (select request_id, count(*) n from public.ride_offers where status = 'accepted' group by request_id having count(*) > 1) x;
  if bad is not null then
    raise notice 'A02: indekss ride_offers_one_accepted NAV izveidots — šiem pieprasījumiem ir vairāki pieņemti piedāvājumi: %. Izskati tos (vaicājums faila beigās) un palaid failu vēlreiz.', bad;
  else
    create unique index ride_offers_one_accepted on public.ride_offers (request_id) where status = 'accepted';
  end if;
end $$;

-- ---------- 3) Statusu pārejas klientam ----------
create or replace function public.ride_guard_status() returns trigger
  language plpgsql set search_path = public as
$$ begin
  if current_user not in ('authenticated', 'anon') or new.status is not distinct from old.status then return new; end if;
  if tg_table_name = 'ride_offers' then
    if new.status = 'declined' and old.status = 'pending' then return new; end if;
    -- 'declined' → 'cancelled': šoferis spiež „Atcelt”, kamēr pasažieris tikko noraidīja (nekaitīgi, pieprasījums netiek atvērts)
    if new.status = 'cancelled' and old.status in ('pending', 'accepted', 'declined') then return new; end if;
    if new.status = 'accepted' then
      raise exception 'Piedāvājumu pieņem tikai caur ride_offer_accept — atjauno lapu un mēģini vēlreiz' using errcode = '42501';
    end if;
    raise exception 'Piedāvājuma statusu % → % mainīt nevar', old.status, new.status using errcode = '42501';
  elsif tg_table_name = 'ride_requests' then
    if new.status = 'cancelled' and old.status in ('open', 'matched') then return new; end if;
    raise exception 'Pieprasījuma statusu % → % mainīt nevar', old.status, new.status using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists ride_offers_guard_status on public.ride_offers;
create trigger ride_offers_guard_status before update of status on public.ride_offers
  for each row execute function public.ride_guard_status();
drop trigger if exists ride_requests_guard_status on public.ride_requests;
create trigger ride_requests_guard_status before update of status on public.ride_requests
  for each row execute function public.ride_guard_status();

-- PĀRBAUDE PĒC PALAIŠANAS (palaid atsevišķi; visām trim kolonnām jābūt true):
--   select exists (select 1 from pg_indexes where indexname = 'ride_offers_one_accepted')          as indekss_ir,
--          has_function_privilege('authenticated', 'public.ride_offer_accept(uuid)', 'execute')   as funkcija_pieejama,
--          exists (select 1 from pg_trigger where tgname = 'ride_offers_guard_status')            as trigeris_ir;
--
-- JA INDEKSS NETIKA IZVEIDOTS — pieprasījumi ar vairākiem pieņemtiem piedāvājumiem:
--   select request_id, id, driver_id, created_at, trip from public.ride_offers
--    where status = 'accepted' and request_id in (select request_id from public.ride_offers where status = 'accepted'
--                                                 group by request_id having count(*) > 1)
--    order by request_id, created_at;
--
-- ATCELŠANA (tikai ja kaut kas salūzt; lietotne tad automātiski izmanto veco pieņemšanas ceļu):
--   drop trigger if exists ride_offers_guard_status on public.ride_offers;
--   drop trigger if exists ride_requests_guard_status on public.ride_requests;
--   drop function if exists public.ride_offer_accept(uuid);
--   drop index if exists public.ride_offers_one_accepted;
