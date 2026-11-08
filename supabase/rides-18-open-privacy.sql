-- Ceļa Zīmes — atvērtie braucieni: šoferi redz aptuvenu vietu, ne adresi un vārdu (audits 2, B02 — 08.11.2026).
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Var palaist atkārtoti (kamēr nav jaunāku).
-- Palaist PĒC presence-2-privacy.sql (secība — supabase/ORDER.txt, Nr. 30).
--
-- Problēma: politika requests_read ļāva JEBKURAM pieteikušamies kontam (arī tikko izveidotam anonīmam) nolasīt visus
-- atvērtos pieprasījumus ar precīzām koordinātām, adreses tekstu, piezīmi un — caur profiles — pasažiera vārdu.
-- Tā varēja savākt, kur cilvēki dzīvo un kad viņi aizbrauc. Arī jebkurš piedāvājums (pat noraidīts) atvēra visu.
--
-- Labojums:
--   1) Tabulu ride_requests pilnībā redz tikai pasažieris pats un šoferis, kura piedāvājumu pasažieris PIEŅĒMA
--      (was_accepted — arī pēc atcelšanas, lai vēsture paliek saprotama). Atvērtais statuss vai gaidošs piedāvājums
--      vairs neatver precīzo vietu, adresi, piezīmi un pasažiera ID.
--   2) Šoferiem saraksts nāk no ride_requests_open(laukums) un ride_requests_coarse(id saraksts):
--      sākums un galamērķis noapaļoti līdz ~1 km (platums 1/100°, garums 1/60°), apdzīvotās vietas nosaukums
--      (tikai pēdējā adreses daļa bez cipariem), laiks, cilvēku skaits, statuss un pasažiera vērtējums (vidējais,
--      skaits, braucieni) — bez vārda, piezīmes, adreses un konta ID. Tikai pieteikušies (anon — nē).

do $$ begin
  if to_regprocedure('public.cz_migration_begin(integer, text)') is null then
    raise exception 'Vispirms palaid visus iepriekšējos failus līdz presence-2-privacy.sql (secība — supabase/ORDER.txt).';
  end if;
end $$;
select public.cz_migration_begin(30, 'rides-18-open-privacy.sql');

-- ---------- 1) Precīzie dati — tikai pasažierim un pieņemtajam šoferim ----------
create or replace function public.ride_request_exact(rid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from ride_offers where request_id = rid and driver_id = auth.uid() and was_accepted) $$;
revoke all on function public.ride_request_exact(uuid) from public, anon;
grant execute on function public.ride_request_exact(uuid) to authenticated;

drop policy if exists requests_read on public.ride_requests;
create policy requests_read on public.ride_requests for select
  using (user_id = auth.uid() or public.ride_request_exact(id));

-- ---------- 2) Aptuvenie dati šoferiem ----------
-- Apdzīvotā vieta no adreses: pēdējā daļa aiz komata, ja tajā nav ciparu (piem. „Brīvības iela 100, Rīga” → „Rīga”)
create or replace function public.ride_area(name text) returns text
  language sql immutable set search_path = public as
$$
  select case when position(',' in coalesce(name, '')) > 0
                   and btrim(regexp_replace(name, '^.*,', '')) !~ '[0-9]'
              then left(btrim(regexp_replace(name, '^.*,', '')), 40) else '' end
$$;

create or replace function public.ride_requests_open(p_s float8 default null, p_w float8 default null,
                                                      p_n float8 default null, p_e float8 default null)
  returns table (id uuid, from_lat float8, from_lng float8, from_area text, to_lat float8, to_lng float8, to_area text,
                 depart_at timestamptz, seats smallint, status text, created_at timestamptz, mine boolean,
                 pas_avg numeric, pas_count int, pas_rides int)
  language sql stable security definer set search_path = public as
$$
  select r.id,
         round(r.from_lat::numeric * 100) / 100, round(r.from_lng::numeric * 60) / 60, ride_area(r.from_name),
         round(r.to_lat::numeric * 100) / 100,   round(r.to_lng::numeric * 60) / 60,   ride_area(r.to_name),
         r.depart_at, r.seats, r.status, r.created_at, r.user_id = auth.uid(),
         s.avg, coalesce(s.count, 0), coalesce(s.rides, 0)
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

-- Pieprasījumi, uz kuriem šoferim ir piedāvājums (gaidošs / noraidīts) vai kas vēl atvērti — tāpat aptuveni
create or replace function public.ride_requests_coarse(ids uuid[])
  returns table (id uuid, from_lat float8, from_lng float8, from_area text, to_lat float8, to_lng float8, to_area text,
                 depart_at timestamptz, seats smallint, status text, created_at timestamptz, mine boolean,
                 pas_avg numeric, pas_count int, pas_rides int)
  language sql stable security definer set search_path = public as
$$
  select r.id,
         round(r.from_lat::numeric * 100) / 100, round(r.from_lng::numeric * 60) / 60, ride_area(r.from_name),
         round(r.to_lat::numeric * 100) / 100,   round(r.to_lng::numeric * 60) / 60,   ride_area(r.to_name),
         r.depart_at, r.seats, r.status, r.created_at, r.user_id = auth.uid(),
         s.avg, coalesce(s.count, 0), coalesce(s.rides, 0)
  from ride_requests r
  left join lateral (select * from rating_summary(array[r.user_id])) s on true
  where auth.uid() is not null and r.id = any(coalesce(ids[1:100], '{}'))
    and (r.status = 'open' or exists (select 1 from ride_offers o where o.request_id = r.id and o.driver_id = auth.uid()))
$$;
revoke all on function public.ride_requests_coarse(uuid[]) from public, anon;
grant execute on function public.ride_requests_coarse(uuid[]) to authenticated;

select public.cz_migration_done(30, 'rides-18-open-privacy.sql');

-- PĀRBAUDE PĒC PALAIŠANAS:
--   supabase/status.sql → „VISS KĀRTĪBĀ”
--   select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'requests_read';   -- bez status = 'open'
-- ATCELŠANA (nav ieteicama): requests_read atpakaļ uz (status = 'open' or user_id = auth.uid() or has_offer_on(id)).
