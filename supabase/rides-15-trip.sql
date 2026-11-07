-- Ceļa Zīmes — kopbraucieni, 15. daļa: drošības labojums A03 (audits 07.11.2026). Brauciena gaita tikai uz priekšu.
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Var palaist atkārtoti.
-- Palaist PĒC rides-13-guard.sql un rides-14-accept.sql.
--
-- Problēma: brauciena gaitu (trip: '' → coming → arrived → onboard → done) varēja pārtīt atpakaļ — piem. pabeigtu vai
-- „Ceļā” braucienu atgriezt uz „Esmu klāt” un tad atcelt. Automātiskā atmaksa paļaujas tieši uz to, vai pasažieris
-- bija iekāpis (trip), tātad to varēja apiet. Šoferis jaunu piedāvājumu varēja izveidot uzreiz ar trip='onboard',
-- un iesākta brauciena vidū abas puses varēja to atcelt (pieprasījums pat atvērās no jauna, pasažierim esot mašīnā).
--
-- Labojums:
--   1) Iekāpšana un pabeigšana — nemaināmi notikumi: kolonnas onboard_at un done_at uzliek pati datubāze, un pēc tam
--      tās mainīt vai notīrīt nevar neviens (arī servera funkcijas).
--   2) trip tikai uz priekšu, tikai saskaņotam braucienam; „Pabeigts” — tikai pēc „Pasažieris iekāpa”.
--      Jauns piedāvājums vienmēr sākas ar tukšu gaitu (klienta atsūtītās gaitas/atrašanās vietas vērtības nomet).
--   3) Kad pasažieris iekāpis, lietotne braucienu atcelt nevar (ne šoferis, ne pasažieris); to pabeidz šoferis vai
--      pēc 4 h bez ziņām — ride_expire (kā līdz šim).
--   4) ride_driver_update: gaitu maina tikai, kamēr pieprasījums ir saskaņots; pieprasījumu 'done' liek tikai tad,
--      ja brauciens tiešām pabeigts.
--   5) ride_refund_candidates: „atcelts pirms iekāpšanas” = onboard_at nav uzlikts (un trip vēl nav onboard/done).
-- Lietotnes kods un servera funkcija ride-pay strādā kā līdz šim (tās skatās trip, kas tagad vairs neiet atpakaļ).
--
-- Īpašnieka labojums ar roku (ja kādreiz tiešām vajag pārtīt gaitu): SQL redaktorā vienā transakcijā
--   begin; set local cz.trip_repair = 'on'; update public.ride_offers set ... where id = '…'; commit;
-- (lietotnes lietotājiem tas nedarbojas).

-- ---------- 1) Nemaināmie notikumi ----------
alter table public.ride_offers add column if not exists onboard_at timestamptz;
alter table public.ride_offers add column if not exists done_at timestamptz;

-- Esošajiem braucieniem: laiks nav zināms precīzi — ņem šofera pēdējo ziņu vai piedāvājuma laiku
update public.ride_offers set onboard_at = coalesce(drv_at, created_at)
  where onboard_at is null and trip in ('onboard', 'done');
update public.ride_offers set done_at = coalesce(drv_at, created_at)
  where done_at is null and trip = 'done';

-- ---------- 2) un 3) Gaitas un statusa pārejas ----------
create or replace function public.ride_trip_rank(t text) returns int
  language sql immutable set search_path = public as
$$ select case t when '' then 0 when 'coming' then 1 when 'arrived' then 2 when 'onboard' then 3 when 'done' then 4 end $$;

create or replace function public.ride_guard_trip() returns trigger
  language plpgsql set search_path = public as
$$
declare client boolean := current_user in ('authenticated', 'anon');
begin
  if tg_op = 'INSERT' then
    -- Jauns piedāvājums vienmēr sākas no nulles (arī ja kāds atsūta citas vērtības)
    new.trip := ''; new.onboard_at := null; new.done_at := null;
    new.drv_lat := null; new.drv_lng := null; new.drv_heading := null; new.drv_at := null;
    new.pas_lat := null; new.pas_lng := null; new.pas_at := null;
    return new;
  end if;

  if not client and current_setting('cz.trip_repair', true) = 'on' then return new; end if;   -- īpašnieka labojums

  if new.trip is distinct from old.trip then
    if old.status <> 'accepted' or new.status <> 'accepted' then
      raise exception 'trip_not_active: brauciena gaitu var mainīt tikai saskaņotam braucienam' using errcode = '42501';
    end if;
    if public.ride_trip_rank(new.trip) < public.ride_trip_rank(old.trip) then
      raise exception 'trip_backwards: brauciena gaitu % → % atpakaļ mainīt nevar', old.trip, new.trip using errcode = '42501';
    end if;
    if new.trip = 'done' and old.trip <> 'onboard' then
      raise exception 'trip_not_onboard: pabeigt var tikai pēc tam, kad pasažieris iekāpis' using errcode = '42501';
    end if;
  end if;

  -- Notikumu laiki: uzliek datubāze vienu reizi, pēc tam nemaināmi
  new.onboard_at := case when old.onboard_at is not null then old.onboard_at
                         when new.trip in ('onboard', 'done') then now() end;
  new.done_at := case when old.done_at is not null then old.done_at
                      when new.trip = 'done' then now() end;

  -- Pēc iekāpšanas lietotne braucienu atcelt vai noraidīt nevar
  if client and new.status is distinct from old.status and old.onboard_at is not null then
    raise exception 'trip_started: pasažieris jau iekāpis — braucienu atcelt nevar' using errcode = '42501';
  end if;
  return new;
end
$$;
drop trigger if exists ride_offers_guard_trip on public.ride_offers;
create trigger ride_offers_guard_trip before insert or update on public.ride_offers
  for each row execute function public.ride_guard_trip();

-- Pasažieris nevar atcelt pieprasījumu, kad jau sēž mašīnā
create or replace function public.ride_request_started(rid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from ride_offers where request_id = rid and status = 'accepted' and onboard_at is not null) $$;
revoke all on function public.ride_request_started(uuid) from public, anon;
grant execute on function public.ride_request_started(uuid) to authenticated;

create or replace function public.ride_guard_request_started() returns trigger
  language plpgsql set search_path = public as
$$ begin
  if current_user in ('authenticated', 'anon') and new.status is distinct from old.status
     and public.ride_request_started(old.id) then
    raise exception 'trip_started: pasažieris jau iekāpis — braucienu atcelt nevar' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists ride_requests_guard_started on public.ride_requests;
create trigger ride_requests_guard_started before update of status on public.ride_requests
  for each row execute function public.ride_guard_request_started();

-- ---------- 4) Šofera gaitas atjaunošana ----------
create or replace function public.ride_driver_update(oid uuid, p_trip text, p_lat double precision, p_lng double precision, p_heading real)
  returns void language plpgsql security definer set search_path = public as
$$
declare o ride_offers%rowtype; rst text;
begin
  if p_trip is not null and p_trip not in ('', 'coming', 'arrived', 'onboard', 'done') then raise exception 'bad trip'; end if;
  select * into o from ride_offers where id = oid and driver_id = auth.uid() and status = 'accepted' for update;
  if not found then return; end if;                                  -- kā līdz šim: svešam / nesaskaņotam — nekas
  if p_trip is not null and p_trip is distinct from o.trip then
    select status into rst from ride_requests where id = o.request_id;
    if rst is distinct from 'matched' then
      raise exception 'trip_not_active: pasažieris braucienu atcēla vai tas jau beidzies' using errcode = '42501';
    end if;
  end if;
  update ride_offers set
    trip = coalesce(p_trip, trip),
    drv_lat = coalesce(p_lat, drv_lat), drv_lng = coalesce(p_lng, drv_lng), drv_heading = coalesce(p_heading, drv_heading),
    drv_at = case when p_lat is not null then now() else drv_at end
  where id = oid;
  if p_trip = 'done' then
    update ride_requests set status = 'done' where id = o.request_id and status = 'matched';
  end if;
end
$$;
revoke all on function public.ride_driver_update(uuid, text, double precision, double precision, real) from public, anon;
grant execute on function public.ride_driver_update(uuid, text, double precision, double precision, real) to authenticated;

-- ---------- 5) Automātiskās atmaksas kandidāti ----------
create or replace function public.ride_refund_candidates() returns setof uuid
  language sql stable security definer set search_path = public as
$$
  select p.offer_id from ride_payments p
    join ride_offers o on o.id = p.offer_id
    join ride_requests r on r.id = o.request_id
  where (o.driver_id = auth.uid() or r.user_id = auth.uid())
    and p.created_at > now() - interval '60 days'
    and (o.status = 'cancelled' or r.status = 'cancelled')
    and o.onboard_at is null and o.trip in ('', 'coming', 'arrived')
  order by p.created_at desc
  limit 20
$$;
revoke all on function public.ride_refund_candidates() from public, anon;
grant execute on function public.ride_refund_candidates() to authenticated;

-- PĀRBAUDE PĒC PALAIŠANAS (palaid atsevišķi; visām trim kolonnām jābūt true):
--   select exists (select 1 from pg_trigger where tgname = 'ride_offers_guard_trip')            as gaitas_trigeris,
--          exists (select 1 from pg_trigger where tgname = 'ride_requests_guard_started')       as atcelsanas_trigeris,
--          not exists (select 1 from public.ride_offers
--                      where trip in ('onboard', 'done') and onboard_at is null)                as notikumi_aizpilditi;
--
-- ATCELŠANA (tikai ja kaut kas salūzt; kolonnas onboard_at/done_at var palikt):
--   drop trigger if exists ride_offers_guard_trip on public.ride_offers;
--   drop trigger if exists ride_requests_guard_started on public.ride_requests;
--   un vecā ride_driver_update / ride_refund_candidates — no rides-2-chat-trip.sql un rides-8-refund.sql.
