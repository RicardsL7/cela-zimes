-- Ceļa Zīmes — kopbraucienu datubāze (Supabase / PostgreSQL).
-- Palaid visu šo failu vienreiz: Supabase → SQL Editor → New query → ielīmē → Run.
-- Drošība (RLS): katrs lietotājs maina tikai savus ierakstus; tālruni redz tikai tas,
-- ar kuru brauciens ir saskaņots (pieņemts piedāvājums).

create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null check (char_length(name) between 2 and 40),
  car text not null default '' check (char_length(car) <= 60),
  created_at timestamptz not null default now()
);

create table if not exists public.contacts (
  id uuid primary key references public.profiles on delete cascade,
  phone text not null default '' check (char_length(phone) <= 20)
);

create table if not exists public.ride_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles on delete cascade,
  from_lat double precision not null check (from_lat between -90 and 90),
  from_lng double precision not null check (from_lng between -180 and 180),
  from_name text not null default '' check (char_length(from_name) <= 120),
  to_lat double precision not null check (to_lat between -90 and 90),
  to_lng double precision not null check (to_lng between -180 and 180),
  to_name text not null default '' check (char_length(to_name) <= 120),
  depart_at timestamptz not null,
  seats smallint not null default 1 check (seats between 1 and 4),
  note text not null default '' check (char_length(note) <= 200),
  status text not null default 'open' check (status in ('open', 'matched', 'cancelled', 'done')),
  created_at timestamptz not null default now()
);
create index if not exists ride_requests_open_idx on public.ride_requests (status, depart_at);
create index if not exists ride_requests_from_idx on public.ride_requests (from_lat, from_lng);

create table if not exists public.ride_offers (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.ride_requests on delete cascade,
  driver_id uuid not null default auth.uid() references public.profiles on delete cascade,
  eta_min smallint check (eta_min between 0 and 600),
  note text not null default '' check (char_length(note) <= 200),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  unique (request_id, driver_id)
);

-- Palīgfunkcijas (security definer — lai noteikumi neatsaucas viens uz otru bezgalīgi)
create or replace function public.is_request_owner(rid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from ride_requests where id = rid and user_id = auth.uid()) $$;

create or replace function public.request_is_open(rid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from ride_requests where id = rid and status = 'open') $$;

create or replace function public.has_offer_on(rid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from ride_offers where request_id = rid and driver_id = auth.uid()) $$;

-- Vai ar šo cilvēku man ir saskaņots brauciens (abos virzienos)?
create or replace function public.matched_with(other uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from ride_offers o join ride_requests r on r.id = o.request_id
     where o.status = 'accepted' and r.status in ('matched', 'done')
       and ((r.user_id = auth.uid() and o.driver_id = other) or (o.driver_id = auth.uid() and r.user_id = other))) $$;

alter table public.profiles enable row level security;
alter table public.contacts enable row level security;
alter table public.ride_requests enable row level security;
alter table public.ride_offers enable row level security;

-- Profili: vārdu un auto redz pieteikušies lietotāji; mainīt — tikai savu.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (true);
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert to authenticated with check (id = auth.uid());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Tālrunis: savs vai tā cilvēka, ar kuru brauciens saskaņots.
drop policy if exists contacts_read on public.contacts;
create policy contacts_read on public.contacts for select to authenticated using (id = auth.uid() or public.matched_with(id));
drop policy if exists contacts_insert on public.contacts;
create policy contacts_insert on public.contacts for insert to authenticated with check (id = auth.uid());
drop policy if exists contacts_update on public.contacts;
create policy contacts_update on public.contacts for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Pieprasījumi: atvērtos redz visi pieteikušies; savus un tos, kam piedāvāts, — arī pēc saskaņošanas.
drop policy if exists requests_read on public.ride_requests;
create policy requests_read on public.ride_requests for select to authenticated
  using (status = 'open' or user_id = auth.uid() or public.has_offer_on(id));
drop policy if exists requests_insert on public.ride_requests;
create policy requests_insert on public.ride_requests for insert to authenticated
  with check (user_id = auth.uid() and status = 'open' and depart_at > now() - interval '15 minutes'
              and depart_at < now() + interval '7 days');
drop policy if exists requests_update on public.ride_requests;
create policy requests_update on public.ride_requests for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Piedāvājumi: redz šoferis un pieprasījuma autors.
drop policy if exists offers_read on public.ride_offers;
create policy offers_read on public.ride_offers for select to authenticated
  using (driver_id = auth.uid() or public.is_request_owner(request_id));
drop policy if exists offers_insert on public.ride_offers;
create policy offers_insert on public.ride_offers for insert to authenticated
  with check (driver_id = auth.uid() and status = 'pending'
              and public.request_is_open(request_id) and not public.is_request_owner(request_id));
-- Šoferis drīkst tikai atcelt savu piedāvājumu; pasažieris — pieņemt vai noraidīt.
drop policy if exists offers_driver_update on public.ride_offers;
create policy offers_driver_update on public.ride_offers for update to authenticated
  using (driver_id = auth.uid()) with check (driver_id = auth.uid() and status = 'cancelled');
drop policy if exists offers_owner_update on public.ride_offers;
create policy offers_owner_update on public.ride_offers for update to authenticated
  using (public.is_request_owner(request_id)) with check (status in ('accepted', 'declined'));

-- Ja šoferis atceļ pieņemtu piedāvājumu, pieprasījums atkal kļūst atvērts.
create or replace function public.reopen_on_cancel() returns trigger
  language plpgsql security definer set search_path = public as
$$ begin
  if old.status = 'accepted' and new.status = 'cancelled' then
    update ride_requests set status = 'open' where id = new.request_id and status = 'matched';
  end if;
  return new;
end $$;
drop trigger if exists ride_offers_reopen on public.ride_offers;
create trigger ride_offers_reopen after update on public.ride_offers
  for each row execute function public.reopen_on_cancel();

-- Pret mēstulēm: ne vairāk kā 5 atvērti pieprasījumi vienam lietotājam.
create or replace function public.limit_open_requests() returns trigger
  language plpgsql security definer set search_path = public as
$$ begin
  if (select count(*) from ride_requests where user_id = new.user_id and status in ('open', 'matched')) >= 5 then
    raise exception 'Par daudz aktīvu pieprasījumu';
  end if;
  return new;
end $$;
drop trigger if exists ride_requests_limit on public.ride_requests;
create trigger ride_requests_limit before insert on public.ride_requests
  for each row execute function public.limit_open_requests();
