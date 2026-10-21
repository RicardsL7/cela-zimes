-- Ceļa Zīmes — kopīgs radaru (ātruma kameru) saraksts.
-- Supabase → SQL Editor → New query → ielīmē visu → Run. Var palaist atkārtoti.
--
-- Kā tas strādā:
--   • Kad kāda lietotāja telefons Mapillary datos atrod ātruma kameras zīmi, tas paziņo tās
--     Mapillary numuru (radar_report). Citi telefoni šo sarakstu ielādē uzreiz atverot (radar_list).
--   • Pirms radara parādīšanas katrs telefons PATS pārbauda Mapillary, vai šāda kameras zīme tiešām
--     eksistē un kur tā ir (koordinātas ņem no Mapillary, ne no šīs tabulas). Tāpēc viltotu radaru
--     iesūtīt nevar — tas vienkārši netiks parādīts, un telefons to atzīmē kā nederīgu (radar_bad).
--   • Nekāda informācija par lietotājiem netiek glabāta.

create table if not exists public.radar_signs (
  mly_id     text primary key check (mly_id ~ '^[0-9]{6,20}$'),
  value      text not null check (value ~ '^[a-z0-9-]+--[a-z0-9-]+--g[0-9]+$'
                                  and value ~ '(camera|photo-enforced|speed-enforcement)'),
  lat        double precision not null check (lat between 55.6 and 58.1),
  lng        double precision not null check (lng between 20.9 and 28.3),
  good       int not null default 1,
  bad        int not null default 0,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);
alter table public.radar_signs enable row level security;
-- Nav politiku: tabulu tieši nevar lasīt/rakstīt neviens, tikai caur funkcijām zemāk.

-- Saraksts (bez acīmredzami nederīgajiem; neredzēti 1 gadu — izmet)
create or replace function public.radar_list()
returns table (mly_id text, value text, lat double precision, lng double precision)
language sql stable security definer set search_path = public as
$$
  select mly_id, value, lat, lng from radar_signs
  where (bad < 3 or good > bad * 2) and last_seen > now() - interval '365 days'
  order by mly_id
  limit 20000
$$;

-- Paziņo redzētos radarus (līdz 30 vienā reizē)
create or replace function public.radar_report(items jsonb)
returns int language plpgsql security definer set search_path = public as
$$
declare n int;
begin
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 or jsonb_array_length(items) > 30 then
    raise exception 'nederīgi dati';
  end if;
  if (select count(*) from radar_signs) > 50000 then return 0; end if;   -- drošības griesti
  insert into radar_signs as r (mly_id, value, lat, lng)
  select x->>'id', x->>'v', (x->>'lat')::float8, (x->>'lng')::float8
  from jsonb_array_elements(items) x
  where (x->>'id') ~ '^[0-9]{6,20}$'
    and (x->>'v') ~ '^[a-z0-9-]+--[a-z0-9-]+--g[0-9]+$' and (x->>'v') ~ '(camera|photo-enforced|speed-enforcement)'
    and (x->>'lat') ~ '^[0-9.]{1,12}$' and (x->>'lng') ~ '^[0-9.]{1,12}$'
    and (x->>'lat')::float8 between 55.6 and 58.1 and (x->>'lng')::float8 between 20.9 and 28.3
  on conflict (mly_id) do update set good = least(r.good + 1, 1000000), last_seen = now();
  get diagnostics n = row_count;
  return n;
end
$$;

-- Telefons pārbaudīja Mapillary, un šāda kameras zīme neeksistē → atzīmē kā nederīgu
create or replace function public.radar_bad(ids text[])
returns int language plpgsql security definer set search_path = public as
$$
declare n int;
begin
  if array_length(ids, 1) is null or array_length(ids, 1) > 50 then return 0; end if;
  update radar_signs set bad = least(bad + 1, 1000000) where mly_id = any(ids);
  get diagnostics n = row_count;
  return n;
end
$$;

revoke all on function public.radar_list() from public;
revoke all on function public.radar_report(jsonb) from public;
revoke all on function public.radar_bad(text[]) from public;
grant execute on function public.radar_list() to anon, authenticated;
grant execute on function public.radar_report(jsonb) to anon, authenticated;
grant execute on function public.radar_bad(text[]) to anon, authenticated;
