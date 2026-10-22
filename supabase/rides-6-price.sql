-- Ceļa Zīmes — kopbraucieni, 6. daļa: šoferis var norādīt cenu līdz 300 € (agrāk — tikai ceļa izmaksas, 12 c/km).
-- Supabase → SQL Editor → Run. Var palaist atkārtoti.
-- Uzmanību: cena virs ceļa izmaksām nozīmē komercpārvadājumu (licences, nodokļi) — sk. STATUSS.md.

alter table public.ride_offers drop constraint if exists ride_offers_price_cents_check;
alter table public.ride_offers add constraint ride_offers_price_cents_check
  check (price_cents is null or price_cents between 0 and 30000);

create or replace function public.ride_fare_cap_cents(rid uuid) returns int
  language sql stable security definer set search_path = public as
$$ select 30000 from ride_requests where id = rid $$;

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
      raise exception 'Cena pārsniedz maksimālo (% EUR)', round(cap / 100.0, 2);
    end if;
  end if;
  return new;
end
$$;
