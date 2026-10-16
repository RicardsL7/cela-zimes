-- Ceļa Zīmes — kopbraucieni, 2. daļa: čats un brauciena gaita.
-- Palaid PĒC rides.sql (Supabase → SQL Editor → Run). Var palaist atkārtoti.

-- Brauciena gaita un dzīvā atrašanās vieta (tikai saskaņotam braucienam)
alter table public.ride_offers add column if not exists trip text not null default ''
  check (trip in ('', 'coming', 'arrived', 'onboard', 'done'));
alter table public.ride_offers add column if not exists drv_lat double precision;
alter table public.ride_offers add column if not exists drv_lng double precision;
alter table public.ride_offers add column if not exists drv_heading real;
alter table public.ride_offers add column if not exists drv_at timestamptz;
alter table public.ride_offers add column if not exists pas_lat double precision;
alter table public.ride_offers add column if not exists pas_lng double precision;
alter table public.ride_offers add column if not exists pas_at timestamptz;

-- Vai es esmu šī piedāvājuma dalībnieks (šoferis vai pasažieris)?
create or replace function public.is_offer_party(oid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from ride_offers o join ride_requests r on r.id = o.request_id
     where o.id = oid and o.status in ('pending', 'accepted')
       and (o.driver_id = auth.uid() or r.user_id = auth.uid())) $$;

-- Šoferis atjauno brauciena gaitu un savu atrašanās vietu (tikai pieņemtā piedāvājumā).
create or replace function public.ride_driver_update(oid uuid, p_trip text, p_lat double precision, p_lng double precision, p_heading real)
  returns void language plpgsql security definer set search_path = public as
$$ begin
  if p_trip is not null and p_trip not in ('', 'coming', 'arrived', 'onboard', 'done') then raise exception 'bad trip'; end if;
  update ride_offers set
    trip = coalesce(p_trip, trip),
    drv_lat = coalesce(p_lat, drv_lat), drv_lng = coalesce(p_lng, drv_lng), drv_heading = coalesce(p_heading, drv_heading),
    drv_at = case when p_lat is not null then now() else drv_at end
  where id = oid and driver_id = auth.uid() and status = 'accepted';
  if p_trip = 'done' then
    update ride_requests set status = 'done' where id = (select request_id from ride_offers where id = oid and driver_id = auth.uid());
  end if;
end $$;

-- Pasažieris dalās ar savu atrašanās vietu (lai šoferis redz, kur viņš gaida).
create or replace function public.ride_passenger_update(oid uuid, p_lat double precision, p_lng double precision)
  returns void language plpgsql security definer set search_path = public as
$$ begin
  update ride_offers o set pas_lat = p_lat, pas_lng = p_lng, pas_at = now()
  from ride_requests r
  where o.id = oid and r.id = o.request_id and r.user_id = auth.uid() and o.status = 'accepted';
end $$;

revoke all on function public.ride_driver_update(uuid, text, double precision, double precision, real) from public, anon;
revoke all on function public.ride_passenger_update(uuid, double precision, double precision) from public, anon;
grant execute on function public.ride_driver_update(uuid, text, double precision, double precision, real) to authenticated;
grant execute on function public.ride_passenger_update(uuid, double precision, double precision) to authenticated;

-- Čats starp pasažieri un šoferi (piedāvājuma ietvaros)
create table if not exists public.ride_messages (
  id bigint generated always as identity primary key,
  offer_id uuid not null references public.ride_offers on delete cascade,
  sender uuid not null default auth.uid() references public.profiles on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists ride_messages_offer_idx on public.ride_messages (offer_id, id);
alter table public.ride_messages enable row level security;

drop policy if exists messages_read on public.ride_messages;
create policy messages_read on public.ride_messages for select to authenticated using (public.is_offer_party(offer_id));
drop policy if exists messages_insert on public.ride_messages;
create policy messages_insert on public.ride_messages for insert to authenticated
  with check (sender = auth.uid() and public.is_offer_party(offer_id));

-- Pret mēstulēm: ne vairāk kā 20 ziņas minūtē no viena lietotāja.
create or replace function public.limit_messages() returns trigger
  language plpgsql security definer set search_path = public as
$$ begin
  if (select count(*) from ride_messages where sender = new.sender and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'Pārāk daudz ziņu — pagaidi mirkli';
  end if;
  return new;
end $$;
drop trigger if exists ride_messages_limit on public.ride_messages;
create trigger ride_messages_limit before insert on public.ride_messages
  for each row execute function public.limit_messages();
