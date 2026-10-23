-- Ceļa Zīmes — sastrēgumu karte, 2. daļa (labojums F15): „Šobrīd palīdz: N braucēji”.
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run.
-- Jāpalaiž PĒC traffic.sql. Var palaist atkārtoti (dati netiek dzēsti).
--
-- Ko tas dara:
--   • Apjoma ierobežojuma tabulā traffic_quota (viena rinda uz kontu, dzēsta pēc diennakts) pieraksta
--     pēdējās nosūtīšanas laiku last_at. Pašos mērījumos (traffic_samples) lietotāja ID joprojām NAV.
--   • traffic_helpers() atgriež TIKAI vienu skaitli — cik dažādu kontu pēdējās 15 minūtēs sūtījuši
--     mērījumus. Nekādus citus datus (ne ID, ne vietas) tā neatdod. Lasīt var ikviens (arī bez konta).
--   • traffic_report — tā pati funkcija kā traffic.sql, tikai papildus atjauno last_at.

alter table public.traffic_quota add column if not exists last_at timestamptz;
create index if not exists traffic_quota_last on public.traffic_quota (last_at);

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
  update public.traffic_quota set window_start = q.window_start, n = q.n + cnt, last_at = now() where uid = u;

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

revoke all on function public.traffic_report(jsonb) from public, anon;
grant execute on function public.traffic_report(jsonb) to authenticated;

-- Cik braucēju šobrīd (pēdējās 15 min) palīdz sastrēgumu kartei — tikai skaitlis
create or replace function public.traffic_helpers() returns int
language sql stable security definer set search_path = public as
$$ select count(*)::int from public.traffic_quota where last_at > now() - interval '15 minutes' $$;

revoke all on function public.traffic_helpers() from public;
grant execute on function public.traffic_helpers() to anon, authenticated;
