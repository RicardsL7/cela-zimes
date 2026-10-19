-- Sastrēgumu karte: anonīmi braukšanas ātrumi pa ielu posmiem.
-- Palaist vienreiz: Supabase → SQL Editor → New query → ielīmē visu → Run.
--
-- Privātums:
--   • Glabā TIKAI: šūnu (~55×30 m), virzienu (8 sektori), ātrumu, ceļa klasi un laiku.
--     Nav lietotāja ID, nav brauciena, nav secības — no datiem nevar atjaunot, kurš kur brauca.
--   • Telefons sūta datus tikai, ja lietotājs piekrīt, un nekad ne brauciena sākuma / beigu
--     400 m (mājas, darbs). Dati vecāki par 28 dienām tiek dzēsti.
--   • Ierakstīt var tikai caur funkciju traffic_report (pārbauda datus un ierobežo apjomu);
--     lasīt — tikai apkopotus datus caur traffic_now (vismaz 2 mērījumi uz šūnu).

create table if not exists public.traffic_samples (
  id   bigserial primary key,
  cell text      not null check (cell ~ '^-?[0-9]{1,7}_-?[0-9]{1,7}$'),
  dir  smallint  not null check (dir between 0 and 7),
  kmh  real      not null check (kmh >= 0 and kmh <= 200),
  cls  smallint  not null default 0 check (cls between 0 and 9),
  at   timestamptz not null default now()
);
create index if not exists traffic_samples_at on public.traffic_samples (at);
create index if not exists traffic_samples_cell on public.traffic_samples (cell, dir, at);
alter table public.traffic_samples enable row level security;
-- Nav nevienas politikas: tieši lasīt vai rakstīt tabulu nevar neviens (tikai funkcijas zemāk).

-- Apjoma ierobežojums (pret mēstulēm). Glabā tikai skaitītāju; ieraksti dzēsti pēc diennakts.
create table if not exists public.traffic_quota (
  uid          uuid primary key,
  window_start timestamptz not null,
  n            int not null
);
alter table public.traffic_quota enable row level security;

create or replace function public.traffic_report(items jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  u   uuid := auth.uid();
  q   public.traffic_quota;
  cnt int;
begin
  if u is null then raise exception 'nepieciešama pieteikšanās'; end if;
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 or jsonb_array_length(items) > 80 then
    raise exception 'nederīgi dati';
  end if;
  cnt := jsonb_array_length(items);

  select * into q from public.traffic_quota where uid = u for update;
  if not found then
    insert into public.traffic_quota (uid, window_start, n) values (u, now(), 0) returning * into q;
  end if;
  if q.window_start < now() - interval '1 hour' then q.window_start := now(); q.n := 0; end if;
  if q.n + cnt > 1500 then return 0; end if;           -- vairāk par 1500 mērījumiem stundā — neņem
  update public.traffic_quota set window_start = q.window_start, n = q.n + cnt where uid = u;

  insert into public.traffic_samples (cell, dir, kmh, cls)
  select x->>'c', (x->>'d')::smallint, least(greatest((x->>'v')::real, 0), 200), coalesce((x->>'k')::smallint, 0)
  from jsonb_array_elements(items) x
  where (x->>'c') ~ '^-?[0-9]{1,7}_-?[0-9]{1,7}$'
    and (x->>'d') ~ '^[0-7]$'
    and (x->>'v') ~ '^[0-9]{1,3}(\.[0-9]+)?$'
    and coalesce(x->>'k', '0') ~ '^[0-9]$';

  -- Vecu datu tīrīšana (ik pa laikam)
  if random() < 0.02 then
    delete from public.traffic_samples where at < now() - interval '28 days';
    delete from public.traffic_quota where window_start < now() - interval '1 day';
  end if;
  return cnt;
end $$;

revoke all on function public.traffic_report(jsonb) from public;
grant execute on function public.traffic_report(jsonb) to authenticated;

-- Pašreizējie ātrumi kartes apgabalā (pēdējās 20 min) + parastais ātrums (85. procentile, 28 dienas).
-- Apgabals ne lielāks par 0,6° (lai nevar izvilkt visu valsti vienā pieprasījumā).
create or replace function public.traffic_now(s float8, w float8, n float8, e float8)
returns table (cell text, dir smallint, kmh real, typical real, cls smallint, samples int)
language sql
stable
security definer
set search_path = public
as $$
  with box as (
    select floor(s * 2000)::int a0, floor(n * 2000)::int a1, floor(w * 2000)::int b0, floor(e * 2000)::int b1
    where n - s between 0 and 0.6 and e - w between 0 and 0.6
  ), recent as (
    select t.cell, t.dir,
           percentile_cont(0.5) within group (order by t.kmh) as kmh,
           mode() within group (order by t.cls) as cls,
           count(*) as cnt
    from public.traffic_samples t, box
    where t.at > now() - interval '20 minutes'
      and split_part(t.cell, '_', 1)::int between box.a0 and box.a1
      and split_part(t.cell, '_', 2)::int between box.b0 and box.b1
    group by t.cell, t.dir
    having count(*) >= 2
  )
  select r.cell, r.dir, r.kmh::real,
         (select percentile_cont(0.85) within group (order by h.kmh)
            from public.traffic_samples h
           where h.cell = r.cell and h.dir = r.dir and h.at > now() - interval '28 days')::real,
         r.cls::smallint, r.cnt::int
  from recent r
  limit 5000;
$$;

revoke all on function public.traffic_now(float8, float8, float8, float8) from public;
grant execute on function public.traffic_now(float8, float8, float8, float8) to anon, authenticated;
