-- Ceļa Zīmes — kopbraucienu maksājumu atmaksa (labojums F14).
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run.
-- Jāpalaiž PĒC rides-3-pay.sql. Var palaist atkārtoti (dati netiek dzēsti).
--
-- Kā tas strādā:
--   • Atmaksu veic servera funkcija ride-pay (darbība "refund") — Stripe Refund ar reverse_transfer
--     (nauda tiek atgūta no šofera konta) un refund_application_fee (atgriež arī lietotnes komisiju).
--   • Patiesība par maksājumu vienmēr ir Stripe; šīs kolonnas ir pieraksts lietotnei un īpašniekam.
--   • Statusu maina TIKAI ar funkciju ride_payment_mark (brauciena dalībnieks, tikai uz priekšu:
--     created → paid → refunded). Atmaksu pašu var veikt tikai servera funkcija ar Stripe atslēgu.

alter table public.ride_payments add column if not exists status text not null default 'created'
  check (status in ('created', 'paid', 'refunded'));
alter table public.ride_payments add column if not exists refund_id text
  check (refund_id is null or refund_id ~ '^(re|pyr)_[A-Za-z0-9]{6,80}$');
alter table public.ride_payments add column if not exists refunded_at timestamptz;
alter table public.ride_payments add column if not exists refund_reason text
  check (refund_reason is null or refund_reason in ('cancelled_before_pickup', 'driver_refund', 'stripe_dashboard'));
alter table public.ride_payments add column if not exists refund_cents int
  check (refund_cents is null or refund_cents between 0 and 100000);

-- Klientam tieši mainīt šīs kolonnas nedrīkst (pasažiera "update" politika ir tikai sesijas ID nomaiņai)
create or replace function public.ride_payment_guard() returns trigger
  language plpgsql set search_path = public as
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
  return new;
end
$$;
drop trigger if exists ride_payment_guard on public.ride_payments;
create trigger ride_payment_guard before update on public.ride_payments
  for each row execute function public.ride_payment_guard();

-- Jauna maksājuma rinda vienmēr sākas kā „created” bez atmaksas datiem (klients nevar ievietot viltotu „refunded”)
create or replace function public.ride_payment_guard_ins() returns trigger
  language plpgsql set search_path = public as
$$
begin
  new.status := 'created'; new.refund_id := null; new.refunded_at := null;
  new.refund_reason := null; new.refund_cents := null;
  return new;
end
$$;
drop trigger if exists ride_payment_guard_ins on public.ride_payments;
create trigger ride_payment_guard_ins before insert on public.ride_payments
  for each row execute function public.ride_payment_guard_ins();

-- Statusa pieraksts (izsauc servera funkcija ride-pay brauciena dalībnieka vārdā, pēc tam kad Stripe to apstiprinājis)
create or replace function public.ride_payment_mark(oid uuid, p_status text, p_refund_id text default null,
                                                    p_reason text default null, p_cents int default null) returns boolean
  language plpgsql security definer set search_path = public as
$$
declare cur text;
begin
  if auth.uid() is null then raise exception 'Nav pieteicies'; end if;
  if not exists (select 1 from ride_offers o join ride_requests r on r.id = o.request_id
                 where o.id = oid and (o.driver_id = auth.uid() or r.user_id = auth.uid())) then
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

-- Braucieni, kuriem varētu būt jāveic automātiskā atmaksa: ir maksājuma sesija, bet brauciens atcelts
-- PIRMS iekāpšanas (šoferis atcēla, pasažieris atsauca vai lietotne atcēla novecojušu braucienu).
-- Statusa kolonnai te NEUZTICAS (to var pierakstīt brauciena dalībnieks) — vai samaksāts un vai jau atmaksāts,
-- servera funkcija katru reizi pārbauda Stripe.
create or replace function public.ride_refund_candidates() returns setof uuid
  language sql stable security definer set search_path = public as
$$
  select p.offer_id from ride_payments p
    join ride_offers o on o.id = p.offer_id
    join ride_requests r on r.id = o.request_id
  where (o.driver_id = auth.uid() or r.user_id = auth.uid())
    and p.created_at > now() - interval '60 days'
    and (o.status = 'cancelled' or r.status = 'cancelled')
    and o.trip in ('', 'coming', 'arrived')
  order by p.created_at desc
  limit 20
$$;

-- Nesen atmaksātie (paziņojumam lietotājam)
create or replace function public.ride_refunds_recent() returns table (offer_id uuid, refund_cents int, refunded_at timestamptz,
                                                                       refund_reason text, role text)
  language sql stable security definer set search_path = public as
$$
  select p.offer_id, p.refund_cents, p.refunded_at, p.refund_reason,
         case when r.user_id = auth.uid() then 'passenger' else 'driver' end
  from ride_payments p
    join ride_offers o on o.id = p.offer_id
    join ride_requests r on r.id = o.request_id
  where (o.driver_id = auth.uid() or r.user_id = auth.uid())
    and p.status = 'refunded' and p.refunded_at > now() - interval '14 days'
  order by p.refunded_at desc
  limit 20
$$;

revoke all on function public.ride_payment_mark(uuid, text, text, text, int) from public, anon;
revoke all on function public.ride_refund_candidates() from public, anon;
revoke all on function public.ride_refunds_recent() from public, anon;
grant execute on function public.ride_payment_mark(uuid, text, text, text, int) to authenticated;
grant execute on function public.ride_refund_candidates() to authenticated;
grant execute on function public.ride_refunds_recent() to authenticated;
