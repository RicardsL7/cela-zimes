-- Ceļa Zīmes — kopbrauciena maksa = ceļa izdevumu daļa, ne peļņa (audits 2, B03 — 08.11.2026).
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Var palaist atkārtoti (kamēr nav jaunāku).
-- Palaist PĒC rides-18-open-privacy.sql (secība — supabase/ORDER.txt, Nr. 31).
--
-- Kāpēc: Autopārvadājumu likums (1. p. 26. punkts) pasažieru komercpārvadājums ir pārvadājums „par maksu profesionālas
-- darbības veidā”. Tam šoferim vajag licences kartīti un reģistrāciju, lietotnei — reģistrāciju ATD (MK noteikumi Nr. 541)
-- un datu sūtīšanu VID pēc katra brauciena. Kopš v92 (rides-6-price.sql) šoferis drīkstēja prasīt līdz 300 € — tas
-- izskatās pēc komercpārvadājuma. Īpašnieka lēmums 08.11.2026: modelis „izdevumu dalīšana” — maksa nedrīkst pārsniegt
-- aptuvenās ceļa izmaksas. (Galīgo vērtējumu jāsniedz juristam — sk. dokumentu „Maksājumu juridiskā sagatavošana”.)
--
-- Labojums:
--   1) ride_fare_cap_cents: attālums taisnā līnijā × 1,3 (pa ceļiem) × 12 c/km, vismaz 2 € (tā pati formula kā
--      rides-3-pay.sql pirms v92). Datubāzes trigeris ride_offer_price_check jau atsaka lielāku cenu.
--   2) Šoferu saraksts (ride_requests_open / ride_requests_coarse) atdod arī cap_cents — lietotne rāda precīzu
--      maksimumu, lai gan vieta sarakstā ir noapaļota.
--   Jau nosūtītie piedāvājumi netiek mainīti (cenu pēc nosūtīšanas mainīt nevar; neapstiprinātie paši atceļas).

do $$ begin
  if to_regprocedure('public.cz_migration_begin(integer, text)') is null then
    raise exception 'Vispirms palaid visus iepriekšējos failus līdz rides-18-open-privacy.sql (secība — supabase/ORDER.txt).';
  end if;
end $$;
select public.cz_migration_begin(31, 'rides-19-cost-share.sql');

-- ---------- 1) Griesti: ceļa izdevumu daļa ----------
create or replace function public.ride_cost_cap(flat float8, flng float8, tlat float8, tlng float8) returns int
  language sql immutable set search_path = public as
$$
  select greatest(200, round(
    2 * 6371 * asin(sqrt(power(sin(radians(tlat - flat) / 2), 2)
      + cos(radians(flat)) * cos(radians(tlat)) * power(sin(radians(tlng - flng) / 2), 2)))
    * 1.3 * 12))::int
$$;

create or replace function public.ride_fare_cap_cents(rid uuid) returns int
  language sql stable security definer set search_path = public as
$$ select ride_cost_cap(from_lat, from_lng, to_lat, to_lng) from ride_requests where id = rid $$;
revoke all on function public.ride_fare_cap_cents(uuid) from public, anon;   -- vajag tikai pieteikušamies (trigeris)
grant execute on function public.ride_fare_cap_cents(uuid) to authenticated;

-- ---------- 2) Šoferu saraksts ar cap_cents (atgriežamā tabula mainās → funkcijas jādzēš un jāveido no jauna) ----------
drop function if exists public.ride_requests_open(float8, float8, float8, float8);
drop function if exists public.ride_requests_coarse(uuid[]);

create function public.ride_requests_open(p_s float8 default null, p_w float8 default null,
                                          p_n float8 default null, p_e float8 default null)
  returns table (id uuid, from_lat float8, from_lng float8, from_area text, to_lat float8, to_lng float8, to_area text,
                 depart_at timestamptz, seats smallint, status text, created_at timestamptz, mine boolean,
                 pas_avg numeric, pas_count int, pas_rides int, cap_cents int)
  language sql stable security definer set search_path = public as
$$
  select r.id,
         round(r.from_lat::numeric * 100) / 100, round(r.from_lng::numeric * 60) / 60, ride_area(r.from_name),
         round(r.to_lat::numeric * 100) / 100,   round(r.to_lng::numeric * 60) / 60,   ride_area(r.to_name),
         r.depart_at, r.seats, r.status, r.created_at, r.user_id = auth.uid(),
         s.avg, coalesce(s.count, 0), coalesce(s.rides, 0),
         ride_cost_cap(r.from_lat, r.from_lng, r.to_lat, r.to_lng)
  from ride_requests r
  left join lateral (select * from rating_summary(array[r.user_id])) s on true
  where auth.uid() is not null
    and r.status = 'open' and r.depart_at >= now() - interval '30 minutes'
    and (p_s is null or r.from_lat between p_s and p_n) and (p_w is null or r.from_lng between p_w and p_e)
  order by r.depart_at
  limit 200
$$;
revoke all on function public.ride_requests_open(float8, float8, float8, float8) from public, anon;
grant execute on function public.ride_requests_open(float8, float8, float8, float8) to authenticated;

create function public.ride_requests_coarse(ids uuid[])
  returns table (id uuid, from_lat float8, from_lng float8, from_area text, to_lat float8, to_lng float8, to_area text,
                 depart_at timestamptz, seats smallint, status text, created_at timestamptz, mine boolean,
                 pas_avg numeric, pas_count int, pas_rides int, cap_cents int)
  language sql stable security definer set search_path = public as
$$
  select r.id,
         round(r.from_lat::numeric * 100) / 100, round(r.from_lng::numeric * 60) / 60, ride_area(r.from_name),
         round(r.to_lat::numeric * 100) / 100,   round(r.to_lng::numeric * 60) / 60,   ride_area(r.to_name),
         r.depart_at, r.seats, r.status, r.created_at, r.user_id = auth.uid(),
         s.avg, coalesce(s.count, 0), coalesce(s.rides, 0),
         ride_cost_cap(r.from_lat, r.from_lng, r.to_lat, r.to_lng)
  from ride_requests r
  left join lateral (select * from rating_summary(array[r.user_id])) s on true
  where auth.uid() is not null and r.id = any(coalesce(ids[1:100], '{}'))
    and (r.status = 'open' or exists (select 1 from ride_offers o where o.request_id = r.id and o.driver_id = auth.uid()))
$$;
revoke all on function public.ride_requests_coarse(uuid[]) from public, anon;
grant execute on function public.ride_requests_coarse(uuid[]) to authenticated;

select public.cz_migration_done(31, 'rides-19-cost-share.sql');

-- PĀRBAUDE PĒC PALAIŠANAS:
--   supabase/status.sql → „VISS KĀRTĪBĀ”
--   select ride_cost_cap(56.9496, 24.1052, 56.5047, 21.0108);   -- Rīga → Liepāja ≈ 3 044 (30,44 €)
