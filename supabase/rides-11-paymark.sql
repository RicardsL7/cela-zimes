-- Ceļa Zīmes — F17 (v113): maksājuma statusu (paid / refunded) raksta TIKAI servera funkcija ride-pay.
-- Palaid PĒC rides-8-refund.sql (un pārējiem). Supabase → SQL Editor → New query → ielīmē → Run.
--
-- Problēma: ride_payment_mark(oid, …) varēja izsaukt jebkurš brauciena dalībnieks tieši no pārlūka
-- (POST /rest/v1/rpc/ride_payment_mark) un atzīmēt braucienu kā „samaksāts” vai „atmaksāts” bez Stripe.
-- Nauda nekustējās, bet „Mani braucieni”, „Mana statistika” un admin.html rādīja nepatiesus datus.
--
-- Labojums:
--   • vecā funkcija (ar auth.uid()) tiek izdzēsta;
--   • jaunā funkcija saņem lietotāja ID parametrā (p_user_id) — ride-pay to nosaka no pieprasījuma JWT
--     (/auth/v1/user), nevis no pārlūka datiem — un joprojām pārbauda, ka viņš ir brauciena dalībnieks;
--   • izpildīt var TIKAI service_role (ride-pay ar Supabase iebūvēto servisa atslēgu, kas pārlūkā nenonāk);
--   • papildus: samaksāta maksājuma rindai vairs nevar nomainīt Stripe sesijas ID.

drop function if exists public.ride_payment_mark(uuid, text, text, text, int);

create or replace function public.ride_payment_mark(p_user_id uuid, oid uuid, p_status text, p_refund_id text default null,
                                                    p_reason text default null, p_cents int default null) returns boolean
  language plpgsql security definer set search_path = public, pg_temp as
$$
declare cur text;
begin
  if p_user_id is null then raise exception 'Nav lietotāja'; end if;
  if not exists (select 1 from ride_offers o join ride_requests r on r.id = o.request_id
                 where o.id = oid and (o.driver_id = p_user_id or r.user_id = p_user_id)) then
    raise exception 'Brauciens nav atrasts';
  end if;
  select status into cur from ride_payments where offer_id = oid;
  if cur is null then return false; end if;
  if p_status not in ('paid', 'refunded') then raise exception 'Nederīgs statuss'; end if;
  -- tikai uz priekšu; atmaksas datus servera funkcija pēc Stripe pārbaudes drīkst pārrakstīt
  if (cur = 'refunded' and p_status <> 'refunded') or (cur = 'paid' and p_status = 'paid') then return false; end if;
  if p_status = 'refunded' and (p_refund_id is null or p_cents is null) then raise exception 'Trūkst atmaksas datu'; end if;
  perform set_config('cz.pay_mark', 'on', true);
  update ride_payments set status = p_status,
      refund_id = case when p_status = 'refunded' then p_refund_id else refund_id end,
      refunded_at = case when p_status = 'refunded' then now() else refunded_at end,
      refund_reason = case when p_status = 'refunded' then p_reason else refund_reason end,
      refund_cents = case when p_status = 'refunded' then p_cents else refund_cents end
    where offer_id = oid;
  perform set_config('cz.pay_mark', 'off', true);
  return true;
end
$$;

revoke all on function public.ride_payment_mark(uuid, uuid, text, text, text, int) from public, anon, authenticated;
grant execute on function public.ride_payment_mark(uuid, uuid, text, text, text, int) to service_role;

-- Aizsardzība pret tiešu rindas maiņu (pasažieris drīkst mainīt tikai vēl nesamaksātas sesijas ID)
create or replace function public.ride_payment_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as
$$
begin
  if current_setting('cz.pay_mark', true) is distinct from 'on' and (
       new.status is distinct from old.status or new.refund_id is distinct from old.refund_id or
       new.refunded_at is distinct from old.refunded_at or new.refund_reason is distinct from old.refund_reason or
       new.refund_cents is distinct from old.refund_cents) then
    raise exception 'Maksājuma statusu mainīt nevar';
  end if;
  if old.status = 'refunded' and new.session_id is distinct from old.session_id then
    raise exception 'Atmaksātu maksājumu mainīt nevar';
  end if;
  if old.status = 'paid' and new.session_id is distinct from old.session_id then
    raise exception 'Samaksātu maksājumu mainīt nevar';
  end if;
  return new;
end
$$;

-- Pārbaude (pēc palaišanas): jāatgriež false visām trim rindām
--   select has_function_privilege('authenticated', 'public.ride_payment_mark(uuid, uuid, text, text, text, int)', 'execute'),
--          has_function_privilege('anon', 'public.ride_payment_mark(uuid, uuid, text, text, text, int)', 'execute'),
--          to_regprocedure('public.ride_payment_mark(uuid, text, text, text, int)') is not null;
