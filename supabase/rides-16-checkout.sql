-- Ceļa Zīmes — kopbraucieni, 16. daļa: drošības labojums A04 (audits 07.11.2026). Viena maksājuma lapa braucienam.
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Var palaist atkārtoti.
-- Palaist PĒC rides-3-pay.sql, rides-8-refund.sql, rides-11-paymark.sql (un ieteicams pēc rides-13…15).
-- Tad izvietot jauno servera funkciju ride-pay (supabase/functions/ride-pay/index.ts — viens fails).
-- Secība svarīga tikai vienā virzienā: vecā ride-pay ar šo failu strādā kā līdz šim; jaunā ride-pay bez šī faila
-- maksājuma lapu neatvērs (ziņa „Datubāzes kļūda”).
--
-- Problēma: divi vienlaicīgi „Maksāt ar karti” klikšķi izveidoja divas Stripe maksājuma sesijas vienam braucienam.
-- Labojums (kopā ar supabase/functions/ride-pay/index.ts, bloks <checkout-flow>):
--   1) ride_payments.attempt — mēģinājuma numurs; Stripe idempotences atslēga „cz-checkout-<brauciens>-<numurs>”,
--      tāpēc vienlaicīgi pieprasījumi saņem vienu un to pašu sesiju.
--   2) ride_checkout_begin(oid) — pašreizējā sesija un numurs (tikai brauciena pasažierim, tikai saskaņotam braucienam).
--   3) ride_checkout_save(oid, sesija, numurs) — saglabā ar rindas bloķēšanu; vecāks numurs nekad nepārraksta jaunāku,
--      samaksātu / atmaksātu maksājumu nepārraksta.
--   4) Klients pats numuru mainīt nevar.

-- ---------- 1) Mēģinājuma numurs ----------
alter table public.ride_payments add column if not exists attempt int not null default 1 check (attempt between 1 and 1000);

create or replace function public.ride_payment_attempt_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as
$$ begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then new.attempt := 1; else new.attempt := old.attempt; end if;
  end if;
  return new;
end $$;
drop trigger if exists ride_payment_attempt_guard on public.ride_payments;
create trigger ride_payment_attempt_guard before insert or update on public.ride_payments
  for each row execute function public.ride_payment_attempt_guard();

-- ---------- 2) Sākums ----------
create or replace function public.ride_checkout_begin(oid uuid) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as
$$
declare me uuid := auth.uid(); p ride_payments%rowtype;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not exists (select 1 from ride_offers o join ride_requests r on r.id = o.request_id
                 where o.id = oid and r.user_id = me and o.status = 'accepted') then
    raise exception 'offer_not_found';
  end if;
  select * into p from ride_payments where offer_id = oid;
  if not found then return jsonb_build_object('session_id', null, 'attempt', 0, 'status', null); end if;
  return jsonb_build_object('session_id', p.session_id, 'attempt', p.attempt, 'status', p.status);
end
$$;

-- ---------- 3) Saglabāšana ----------
create or replace function public.ride_checkout_save(oid uuid, p_session text, p_attempt int) returns boolean
  language plpgsql security definer set search_path = public, pg_temp as
$$
declare me uuid := auth.uid(); p ride_payments%rowtype;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_session is null or p_session !~ '^cs_(test|live)_[A-Za-z0-9]{10,200}$' then raise exception 'bad_session'; end if;
  if p_attempt is null or p_attempt < 1 or p_attempt > 1000 then raise exception 'bad_attempt'; end if;
  perform 1 from ride_offers o join ride_requests r on r.id = o.request_id
    where o.id = oid and r.user_id = me and o.status = 'accepted'
    for update of o;                                                    -- viens saglabāšanas mēģinājums vienlaikus
  if not found then raise exception 'offer_not_found'; end if;
  select * into p from ride_payments where offer_id = oid for update;
  if not found then
    insert into ride_payments (offer_id, session_id, attempt) values (oid, p_session, p_attempt);
    return true;
  end if;
  if p.session_id = p_session then                                     -- tā pati sesija (vienlaicīgs pieprasījums)
    if p_attempt > p.attempt then update ride_payments set attempt = p_attempt where offer_id = oid; end if;
    return true;
  end if;
  if p.status <> 'created' or p_attempt <= p.attempt then return false; end if;   -- jau samaksāts vai ir jaunāka sesija
  update ride_payments set session_id = p_session, attempt = p_attempt where offer_id = oid;
  return true;
end
$$;

revoke all on function public.ride_checkout_begin(uuid) from public, anon;
revoke all on function public.ride_checkout_save(uuid, text, int) from public, anon;
grant execute on function public.ride_checkout_begin(uuid) to authenticated;
grant execute on function public.ride_checkout_save(uuid, text, int) to authenticated;

-- PĀRBAUDE PĒC PALAIŠANAS (palaid atsevišķi; visām trim kolonnām jābūt true):
--   select exists (select 1 from information_schema.columns where table_name = 'ride_payments' and column_name = 'attempt') as kolonna_ir,
--          has_function_privilege('authenticated', 'public.ride_checkout_save(uuid, text, int)', 'execute')            as funkcija_pieejama,
--          not has_function_privilege('anon', 'public.ride_checkout_begin(uuid)', 'execute')                            as anon_nevar;
--
-- ATCELŠANA (tikai ja kaut kas salūzt; vispirms atpakaļ jāizvieto vecā ride-pay):
--   drop function if exists public.ride_checkout_begin(uuid);
--   drop function if exists public.ride_checkout_save(uuid, text, int);
--   drop trigger if exists ride_payment_attempt_guard on public.ride_payments;
