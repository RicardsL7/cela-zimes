#!/usr/bin/env bash
# A09: uzģenerē supabase/status.sql — datubāzes „eksportu” (kādai jābūt datubāzei pēc visiem supabase/ORDER.txt failiem)
# kā pārbaudes vaicājumu. Avots: datubāze, kas uzbūvēta tieši pēc ORDER.txt (tests/run-sql.sh to dara automātiski).
# Lietošana: PGDATABASE=<uzbūvētā datubāze> bash tests/gen-status.sh > supabase/status.sql
# Funkcijas salīdzina pēc to teksta (prosrc) — tas nav atkarīgs no PostgreSQL versijas.
set -euo pipefail
q() { psql -X -q -At -v ON_ERROR_STOP=1 -c "$1"; }
sep() { sed '$!s/$/,/'; }

cat <<'EOF'
-- Ceļa Zīmes — vai datubāze sakrīt ar repozitoriju? (audits A09) ŠIS FAILS IR ĢENERĒTS — nelabo ar roku:
--   bash tests/gen-status.sh (tests/run-sql.sh pārbauda, ka tas ir aktuāls).
--
-- KĀ LIETOT: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Tikai LASA — neko nemaina.
-- Rezultāts: problēmu saraksts. Viena rinda „VISS KĀRTĪBĀ” — datubāze atbilst visiem supabase/ORDER.txt failiem.
--   trūkst            — objekts nav izveidots (fails nav palaists vai palaists ar kļūdu)
--   cita versija      — funkcija atšķiras no repozitorija (palaists vecs fails pēc jaunāka vai labots ar roku)
--   tiesības          — lietotnei (anon / authenticated) ir citas tiesības nekā paredzēts
--   migrācija         — fails nav atzīmēts cz_migrations (pēc rides-17-migrations.sql)
--   plānotājs         — regulārais darbs (piem. vecu datu tīrīšana cz-cleanup) nav ieplānots pg_cron
--   ārējā atslēga     — saite starp tabulām trūkst vai dzēšot rīkojas citādi (piem. CASCADE, nevis SET NULL — A15)
-- Papildu objekti (piem. paša pievienoti) netiek ziņoti.
with
EOF

echo "exp_mig(seq, name) as (values"
grep -vE '^\s*(#|$)' supabase/ORDER.txt | awk '{printf "  (%d, '\''%s'\'')\n", $1, $2}' | sep
echo "),"

echo "exp_fn(sig, h, secdef) as (values"
q "select format('  (%L, %L, %s)', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', md5(p.prosrc), p.prosecdef::text)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind in ('f', 'p')
   order by 1" | sep
echo "),"

echo "exp_col(t, c) as (values"
q "select format('  (%L, %L)', table_name, column_name) from information_schema.columns
   where table_schema = 'public' and table_name in (select tablename from pg_tables where schemaname = 'public') order by 1" | sep
echo "),"

echo "exp_trg(t, g) as (values"
q "select format('  (%L, %L)', c.relname, t.tgname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
   join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal order by 1" | sep
echo "),"

echo "exp_pol(t, p) as (values"
q "select format('  (%L, %L)', tablename, policyname) from pg_policies where schemaname = 'public' order by 1" | sep
echo "),"

echo "exp_idx(i) as (values"
q "select format('  (%L)', indexname) from pg_indexes where schemaname = 'public' order by 1" | sep
echo "),"

echo "exp_rls(t) as (values"
q "select format('  (%L)', relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity order by 1" | sep
echo "),"

# Lietotnes tiesības: funkciju izsaukšana un tabulu darbības anon / authenticated lomām
echo "exp_fpriv(sig, r, ok) as (values"
q "select format('  (%L, %L, %s)', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', r, has_function_privilege(r, p.oid, 'execute')::text)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated']) r
   where n.nspname = 'public' and p.prokind in ('f', 'p') order by 1" | sep
echo "),"

echo "exp_tpriv(t, r, act, ok) as (values"
q "select format('  (%L, %L, %L, %s)', c.relname, r, a, has_table_privilege(r, c.oid, a)::text)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace, unnest(array['anon', 'authenticated']) r,
        unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) a
   where n.nspname = 'public' and c.relkind = 'r' order by 1" | sep
echo "),"

echo "exp_cpriv(t, c, r, ok) as (values"
q "select format('  (%L, %L, %L, %s)', table_name, column_name, r, has_column_privilege(r, format('public.%I', table_name), column_name, 'UPDATE')::text)
   from information_schema.columns, unnest(array['anon', 'authenticated']) r
   where table_schema = 'public' and table_name in ('ride_offers', 'ride_requests', 'ride_payments') order by 1" | sep
echo "),"

# A15: ārējās atslēgas un to ON DELETE darbība (piem. dzēšot profilu, brauciens otram paliek — SET NULL, nevis CASCADE)
echo "exp_fk(t, k, def) as (values"
q "select format('  (%L, %L, %L)', c.conrelid::regclass::text, c.conname, pg_get_constraintdef(c.oid))
   from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public' and c.contype = 'f' order by 1" | sep
echo "),"

# A11: plānotāja (pg_cron) darbi, ko izveido repozitorija faili (nosaukums cz-…)
echo "exp_cron(name, sched) as (values"
crons=$(q "select format('  (%L, %L)', jobname, schedule) from cron.job where jobname like 'cz-%' order by 1" 2>/dev/null || true)
if [ -n "$crons" ]; then echo "$crons" | sep; else echo "  (null::text, null::text)"; fi
echo "),"

cat <<'EOF'
act_cron as (
  select (xpath('/row/jobname/text()', x))[1]::text name, (xpath('/row/schedule/text()', x))[1]::text sched
  from unnest(xpath('/table/row', case when to_regclass('cron.job') is not null
         then query_to_xml('select jobname, schedule from cron.job where active', false, false, '') end)) x
),
-- cz_migrations var vēl nebūt (pirms rides-17) — nolasa dinamiski, lai vaicājums nekristu
act_mig as (
  select (xpath('/row/seq/text()', x))[1]::text::int seq, (xpath('/row/name/text()', x))[1]::text name
  from unnest(xpath('/table/row', case when to_regclass('public.cz_migrations') is not null
         then query_to_xml('select seq, name from public.cz_migrations', false, false, '') end)) x
),
act_fn as (
  select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig, md5(p.prosrc) h, p.prosecdef secdef, p.oid
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind in ('f', 'p')
),
problems(kas, objekts, problema) as (
  select 'funkcija', e.sig, 'trūkst' from exp_fn e where not exists (select 1 from act_fn a where a.sig = e.sig)
  union all
  select 'funkcija', e.sig, case when a.h <> e.h then 'cita versija' else 'cita versija (security definer)' end
    from exp_fn e join act_fn a on a.sig = e.sig where a.h <> e.h or a.secdef <> e.secdef
  union all
  select 'kolonna', e.t || '.' || e.c, 'trūkst' from exp_col e
    where not exists (select 1 from information_schema.columns x where x.table_schema = 'public' and x.table_name = e.t and x.column_name = e.c)
  union all
  select 'trigeris', e.t || '.' || e.g, 'trūkst' from exp_trg e
    where not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = e.t and t.tgname = e.g)
  union all
  select 'politika', e.t || '.' || e.p, 'trūkst' from exp_pol e
    where not exists (select 1 from pg_policies x where x.schemaname = 'public' and x.tablename = e.t and x.policyname = e.p)
  union all
  select 'indekss', e.i, 'trūkst' from exp_idx e where not exists (select 1 from pg_indexes x where x.schemaname = 'public' and x.indexname = e.i)
  union all
  select 'RLS', e.t, 'nav ieslēgts' from exp_rls e
    where not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = e.t and c.relrowsecurity)
  union all
  select 'tiesības', e.sig || ' — ' || e.r, case when e.ok then 'nevar izsaukt (vajadzētu varēt)' else 'var izsaukt (nevajadzētu)' end
    from exp_fpriv e join act_fn a on a.sig = e.sig where has_function_privilege(e.r, a.oid, 'execute') <> e.ok
  union all
  select 'tiesības', e.t || ' ' || e.act || ' — ' || e.r, case when e.ok then 'nav atļauts (vajadzētu būt)' else 'atļauts (nevajadzētu)' end
    from exp_tpriv e where has_table_privilege(e.r, to_regclass('public.' || quote_ident(e.t)), e.act) <> e.ok
  union all
  select 'tiesības', e.t || '.' || e.c || ' UPDATE — ' || e.r, case when e.ok then 'nav atļauts (vajadzētu būt)' else 'atļauts (nevajadzētu)' end
    from exp_cpriv e
    where case when exists (select 1 from information_schema.columns x where x.table_schema = 'public' and x.table_name = e.t and x.column_name = e.c)
               then has_column_privilege(e.r, to_regclass('public.' || quote_ident(e.t)), e.c, 'UPDATE') <> e.ok end
  union all
  select 'ārējā atslēga', e.t || '.' || e.k, case when x.oid is null then 'trūkst' else 'cita: ' || pg_get_constraintdef(x.oid) end
    from exp_fk e left join pg_constraint x on x.conname = e.k and x.contype = 'f' and x.conrelid = to_regclass('public.' || quote_ident(e.t))
    where x.oid is null or pg_get_constraintdef(x.oid) <> e.def
  union all
  select 'plānotājs', e.name || ' (' || e.sched || ')', 'nav ieplānots (pg_cron)' from exp_cron e
    where e.name is not null and not exists (select 1 from act_cron a where a.name = e.name and a.sched = e.sched)
  union all
  select 'migrācija', e.seq || ' ' || e.name, 'nav atzīmēts cz_migrations' from exp_mig e
    where not exists (select 1 from act_mig m where m.seq = e.seq and m.name = e.name)
)
select kas, objekts, problema from problems
union all
select 'VISS KĀRTĪBĀ', 'datubāze atbilst supabase/ORDER.txt', '' where not exists (select 1 from problems)
order by 1, 2;
EOF
