-- Ceļa Zīmes — kopbraucienu maksājumu atmaksa (labojums F14).
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run.
-- Jāpalaiž PĒC rides-3-pay.sql. Var palaist atkārtoti (tikai kamēr nav palaisti jaunāki faili — A09) (dati netiek dzēsti).
--
-- Kā tas strādā:
--   • Atmaksu veic servera funkcija ride-pay (darbība "refund") — Stripe Refund ar reverse_transfer
--     (nauda tiek atgūta no šofera konta) un refund_application_fee (atgriež arī lietotnes komisiju).
--   • Patiesība par maksājumu vienmēr ir Stripe; šīs kolonnas ir pieraksts lietotnei un īpašniekam.
--   • Statusu maina TIKAI ar funkciju ride_payment_mark (kopš v113 — tikai servera funkcija ride-pay, rides-11-paymark.sql; tikai uz priekšu:
--     created → paid → refunded). Atmaksu pašu var veikt tikai servera funkcija ar Stripe atslēgu.

-- A09: aizsardzība. Šo vecāko failu nedrīkst palaist vēlreiz, ja pēc tā jau palaisti jaunāki — tas atjaunotu vecākas
-- funkciju versijas un atceltu vēlākos labojumus. Tukšā datubāzē (pirmā uzstādīšana pēc supabase/ORDER.txt) un pirms
-- rides-17-migrations.sql šī pārbaude neko nedara. Sk. supabase/MIGRATIONS.md.
do $$ begin
  if to_regclass('public.cz_migrations') is not null then   -- (atsevišķs if: tabulas var vēl nebūt)
    if exists (select 1 from public.cz_migrations where seq > 12)
       and coalesce(current_setting('cz.allow_rerun', true), '') <> 'on' then
      raise exception 'rides-8-refund.sql (Nr. 12) ir vecs migrācijas fails, un pēc tā jau palaisti jaunāki — atkārtoti to palaist nedrīkst (atceltu vēlākos labojumus). Sk. supabase/MIGRATIONS.md.';
    end if;
  end if;
end $$;

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

-- Statusa pieraksts: funkcija ride_payment_mark tagad ir failā rides-11-paymark.sql (F17, v113) —
-- izsaucama TIKAI ar service_role no servera funkcijas ride-pay (lietotāja ID parametrā p_user_id).
-- Agrākā versija (izsaucama ar authenticated) šeit vairs netiek veidota, lai šo failu atkārtoti palaižot
-- caurums neatgrieztos.

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

revoke all on function public.ride_refund_candidates() from public, anon;
revoke all on function public.ride_refunds_recent() from public, anon;
grant execute on function public.ride_refund_candidates() to authenticated;
grant execute on function public.ride_refunds_recent() to authenticated;
