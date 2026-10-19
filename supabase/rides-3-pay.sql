-- Ceļa Zīmes — kopbraucienu maksājumi ar karti (Stripe Connect). Palaist PĒC rides.sql un rides-2-chat-trip.sql.
-- Supabase → SQL Editor → New query → ielīmē visu → Run.
--
-- Modelis: izmaksu dalīšana (kā BlaBlaCar). Šoferis var norādīt cenu, bet ne vairāk par aptuvenām
-- ceļa izmaksām (12 centi uz km pa ceļu, vismaz 2 €). Pasažieris maksā ar karti caur Stripe;
-- Stripe pats nosūta naudu šoferim un lietotnes komisiju (servera funkcija ride-pay) lietotnes īpašniekam.
--
-- Drošība:
--   • Kartes datus redz tikai Stripe. Datubāzē glabā tikai Stripe konta / maksājuma sesijas ID.
--   • Vai samaksāts — servera funkcija katru reizi jautā Stripe (datubāzei te netic).
--   • Cenu pēc piedāvājuma nosūtīšanas mainīt nevar neviens.

alter table public.ride_offers add column if not exists price_cents int
  check (price_cents is null or price_cents between 0 and 10000);

-- Maksimālā cena: attālums taisnā līnijā × 1,3 (pa ceļiem) × 12 c/km, vismaz 2 €.
create or replace function public.ride_fare_cap_cents(rid uuid) returns int
  language sql stable security definer set search_path = public as
$$
  select greatest(200, round(
    2 * 6371 * asin(sqrt(power(sin(radians(to_lat - from_lat) / 2), 2)
      + cos(radians(from_lat)) * cos(radians(to_lat)) * power(sin(radians(to_lng - from_lng) / 2), 2)))
    * 1.3 * 12))::int
  from ride_requests where id = rid
$$;
revoke all on function public.ride_fare_cap_cents(uuid) from public;
grant execute on function public.ride_fare_cap_cents(uuid) to anon, authenticated;

create or replace function public.ride_offer_price_check() returns trigger
  language plpgsql set search_path = public as
$$
declare cap int;
begin
  if tg_op = 'UPDATE' then
    if new.price_cents is distinct from old.price_cents then
      raise exception 'Cenu pēc piedāvājuma nosūtīšanas mainīt nevar';
    end if;
    return new;
  end if;
  if new.price_cents is not null then
    cap := public.ride_fare_cap_cents(new.request_id);
    if cap is null or new.price_cents > cap then
      raise exception 'Cena pārsniedz ceļa izmaksas (maks. % EUR)', round(cap / 100.0, 2);
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists ride_offer_price on public.ride_offers;
create trigger ride_offer_price before insert or update on public.ride_offers
  for each row execute function public.ride_offer_price_check();

-- Šofera Stripe konts (tikai ID; pašu kontu un dokumentus pārvalda Stripe).
create table if not exists public.driver_accounts (
  user_id uuid primary key default auth.uid() references public.profiles on delete cascade,
  acct text not null check (acct ~ '^acct_[A-Za-z0-9]{6,40}$'),
  created_at timestamptz not null default now()
);
alter table public.driver_accounts enable row level security;
drop policy if exists "driver_accounts read own" on public.driver_accounts;
create policy "driver_accounts read own" on public.driver_accounts for select using (user_id = auth.uid());
drop policy if exists "driver_accounts insert own" on public.driver_accounts;
create policy "driver_accounts insert own" on public.driver_accounts for insert with check (user_id = auth.uid());
drop policy if exists "driver_accounts delete own" on public.driver_accounts;
create policy "driver_accounts delete own" on public.driver_accounts for delete using (user_id = auth.uid());

-- Pasažierim: saskaņotā brauciena šofera Stripe konts (tikai savam pieņemtajam piedāvājumam).
create or replace function public.ride_driver_acct(oid uuid) returns text
  language sql stable security definer set search_path = public as
$$
  select d.acct from ride_offers o
    join ride_requests r on r.id = o.request_id
    join driver_accounts d on d.user_id = o.driver_id
  where o.id = oid and r.user_id = auth.uid() and o.status = 'accepted'
$$;
revoke all on function public.ride_driver_acct(uuid) from public;
grant execute on function public.ride_driver_acct(uuid) to authenticated;

-- Maksājuma sesija (Stripe Checkout) katram braucienam.
create table if not exists public.ride_payments (
  offer_id uuid primary key references public.ride_offers on delete cascade,
  session_id text not null check (session_id ~ '^cs_(test|live)_[A-Za-z0-9]{10,200}$'),
  created_at timestamptz not null default now()
);
alter table public.ride_payments enable row level security;
drop policy if exists "ride_payments read" on public.ride_payments;
create policy "ride_payments read" on public.ride_payments for select using (
  exists (select 1 from ride_offers o where o.id = offer_id and (o.driver_id = auth.uid() or public.is_request_owner(o.request_id))));
drop policy if exists "ride_payments passenger insert" on public.ride_payments;
create policy "ride_payments passenger insert" on public.ride_payments for insert with check (
  exists (select 1 from ride_offers o where o.id = offer_id and o.status = 'accepted' and public.is_request_owner(o.request_id)));
drop policy if exists "ride_payments passenger update" on public.ride_payments;
create policy "ride_payments passenger update" on public.ride_payments for update
  using (exists (select 1 from ride_offers o where o.id = offer_id and public.is_request_owner(o.request_id)))
  with check (exists (select 1 from ride_offers o where o.id = offer_id and o.status = 'accepted' and public.is_request_owner(o.request_id)));
