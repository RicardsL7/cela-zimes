-- Ceļa Zīmes — lietotnes kļūdu pieraksts (audits 2, B12 — 11.11.2026).
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Var palaist atkārtoti (kamēr nav jaunāku).
-- Palaist PĒC rides-21-driver-accounts.sql (secība — supabase/ORDER.txt, Nr. 36).
--
-- Problēma: par kļūdām lietotājas pārlūkā (JavaScript kļūdas, nepārtvertas Promise kļūdas) īpašnieks uzzināja tikai,
-- ja kāds pateica. Uzraudzība (monitor.yml) pārbauda tikai serveri.
--
-- Labojums:
--   1) client_errors — viena rinda dienā katrai atšķirīgai kļūdai (veids + teksts + fails + rinda), ar skaitītāju n.
--      Nekādu personas datu: nav lietotāja ID, nav IP adreses, nav atrašanās vietas. Teksts tiek attīrīts arī serverī
--      (e-pasti, žetoni, garas ciparu virknes un koordinātām līdzīgi skaitļi → „…”).
--   2) client_error(p) — pieraksts no lietotnes (errlog.js), var izsaukt arī bez konta. Ierobežojumi: ≤ 300 atšķirīgas
--      kļūdas dienā (pēc tam tikai skaitītāji jau zināmām), garumi apgriezti.
--   3) admin_client_errors(dienas) — saraksts administrēšanas lapā (tikai is_app_admin()).
--   4) Glabā 30 dienas — „cz-client-errors” katru nakti 02:51 (UTC).

do $$ begin
  if to_regprocedure('public.cz_migration_begin(integer, text)') is null
     or to_regprocedure('public.driver_account_link(uuid, text)') is null then
    raise exception 'Vispirms palaid visus iepriekšējos failus līdz rides-21-driver-accounts.sql (secība — supabase/ORDER.txt).';
  end if;
end $$;
select public.cz_migration_begin(36, 'client-errors.sql');

create table if not exists public.client_errors (
  id       bigserial primary key,
  day      date not null default (now() at time zone 'Europe/Riga')::date,
  fp       text not null,                    -- md5(veids|teksts|fails|rinda)
  kind     text not null check (kind in ('error', 'rejection', 'report')),
  msg      text not null,
  src      text not null default '',
  line     int,
  col      int,
  ver      text not null default '',
  page     text not null default 'app' check (page in ('app', 'admin', 'other')),
  browser  text not null default '',
  n        int not null default 1,
  first_at timestamptz not null default now(),
  last_at  timestamptz not null default now(),
  unique (day, fp)
);
create index if not exists client_errors_last_at on public.client_errors (last_at desc);
alter table public.client_errors enable row level security;     -- bez politikām: tikai caur funkcijām
revoke all on public.client_errors from public, anon, authenticated;
revoke all on sequence public.client_errors_id_seq from public, anon, authenticated;

-- Teksta attīrīšana (tā pati kā errlog.js — arī šeit, ja kāds sūta tieši)
create or replace function public.cz_scrub(t text, maxlen int) returns text
  language sql immutable set search_path = public as
$$
  select left(btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           coalesce(t, ''),
           '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '…', 'g'),                    -- e-pasti
           'eyJ[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]+)*', '…', 'g'),                              -- JWT
           '\m(sk|pk|rk|sb|whsec|acct|cus|pi|ch|re)_[A-Za-z0-9_]{6,}', '…', 'g'),             -- atslēgas, ID
           '[?#][^\s"'')]*', '', 'g'),                                                       -- URL parametri
           '-?\d{1,3}\.\d{3,}', '…', 'g'),                                                    -- koordinātas
           '\d{6,}', '…', 'g')),                                                             -- garas ciparu virknes
         maxlen)
$$;

create or replace function public.client_error(p jsonb) returns boolean
  language plpgsql security definer set search_path = public as
$$
declare
  k text; m text; s text; ln int; cl int; v text; pg text; br text; f text; d date := (now() at time zone 'Europe/Riga')::date;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return false; end if;
  k  := p->>'kind';
  if k is null or k not in ('error', 'rejection', 'report') then return false; end if;
  m  := cz_scrub(p->>'msg', 300);
  if m = '' then return false; end if;
  s  := cz_scrub(p->>'src', 200);
  ln := case when (p->>'line') ~ '^\d{1,7}$' then (p->>'line')::int end;
  cl := case when (p->>'col') ~ '^\d{1,7}$' then (p->>'col')::int end;
  v  := case when (p->>'ver') ~ '^[0-9a-z.]{1,20}$' then p->>'ver' else '' end;
  pg := case when p->>'page' in ('app', 'admin') then p->>'page' else 'other' end;
  br := case when (p->>'browser') ~ '^[A-Za-z ]{2,20} \d{1,4}$' then p->>'browser' else '' end;
  f  := md5(k || '|' || m || '|' || s || '|' || coalesce(ln, 0));
  update client_errors set n = least(n + 1, 1000000), last_at = now(),
         ver = case when v <> '' then v else ver end
   where day = d and fp = f;
  if found then return true; end if;
  if (select count(*) from client_errors where day = d) >= 300 then return false; end if;   -- jaunas kļūdas dienā — ≤ 300
  insert into client_errors (day, fp, kind, msg, src, line, col, ver, page, browser)
    values (d, f, k, m, s, ln, cl, v, pg, br)
    on conflict (day, fp) do update set n = least(client_errors.n + 1, 1000000), last_at = now();
  return true;
end
$$;
revoke all on function public.client_error(jsonb) from public;
grant execute on function public.client_error(jsonb) to anon, authenticated;
revoke all on function public.cz_scrub(text, int) from public, anon, authenticated;

create or replace function public.admin_client_errors(p_days int default 7)
  returns table (day date, kind text, msg text, src text, line int, col int, ver text, page text, browser text,
                 n int, first_at timestamptz, last_at timestamptz)
  language plpgsql stable security definer set search_path = public as
$$
begin
  if not is_app_admin() then raise exception 'forbidden'; end if;
  return query
    select e.day, e.kind, e.msg, e.src, e.line, e.col, e.ver, e.page, e.browser, e.n, e.first_at, e.last_at
    from client_errors e
    where e.day >= (now() at time zone 'Europe/Riga')::date - greatest(0, least(coalesce(p_days, 7), 30))
    order by e.last_at desc
    limit 500;
end
$$;
revoke all on function public.admin_client_errors(int) from public, anon;
grant execute on function public.admin_client_errors(int) to authenticated;

create or replace function public.cz_client_errors_cleanup() returns int
  language plpgsql security definer set search_path = public as
$$
declare n int;
begin
  delete from client_errors where day < (now() at time zone 'Europe/Riga')::date - 30;
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function public.cz_client_errors_cleanup() from public, anon, authenticated;
select cron.schedule('cz-client-errors', '51 2 * * *', 'select public.cz_client_errors_cleanup()');

select public.cz_migration_done(36, 'client-errors.sql');

-- PĀRBAUDE PĒC PALAIŠANAS:
--   supabase/status.sql → „VISS KĀRTĪBĀ”
--   select public.client_error('{"kind":"report","msg":"pārbaude","page":"admin"}');   -- true; redzams admin.html → Kļūdas
-- ATCELŠANA: select cron.unschedule('cz-client-errors'); revoke execute on function public.client_error(jsonb) from anon, authenticated;
