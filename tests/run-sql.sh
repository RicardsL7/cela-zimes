#!/usr/bin/env bash
# Datubāzes testi (A08, A09): uzbūvē visu shēmu no supabase/*.sql tukšā lokālā PostgreSQL un palaiž visus SQL scenārijus.
# 2. daļa (A09): otra datubāze tieši pēc supabase/ORDER.txt — supabase/status.sql ir aktuāls un saka „VISS KĀRTĪBĀ”,
# vecie faili atsakās palaisties atkārtoti, jaunākie (22–26) palaižas atkārtoti bez izmaiņām.
# NEKAD nelaid pret Supabase / produkciju — skripts izveido un izdzēš datubāzi.
#
# Lietošana:   PGHOST=localhost PGUSER=postgres PGPASSWORD=… bash tests/run-sql.sh
# Vajag:       psql (PostgreSQL ≥ 15) ar superlietotāja tiesībām (izveido lomas authenticated / anon / service_role).
# Rezultāts:   izdrukā PASS / FAIL katram scenārijam; beigās „SQL testi: N izdevās, M neizdevās”; kods 1, ja kaut kas neizdevās.
set -u
cd "$(dirname "$0")/.."
DB="${CZ_TEST_DB:-cz_test}"
export PGDATABASE=postgres

# Shēmas faili tādā secībā, kādā tie palaisti produkcijā (katrs balstās uz iepriekšējiem), un scenāriji tajā vietā,
# kur tie rakstīti. Jaunu shēmas failu pievieno pirms scenārijiem, kas no tā atkarīgi.
# s: — shēmas fails (supabase/), t: — scenārijs (tests/), p: — paralēlais tests (2 sesijas)
STEPS=(
  s:rides.sql s:rides-2-chat-trip.sql s:rides-3-pay.sql s:rides-4-expire.sql s:rides-5-reoffer.sql s:rides-6-price.sql s:rides-7-account.sql
  s:radars.sql s:traffic.sql s:traffic-2-helpers.sql s:reports.sql
  s:rides-8-refund.sql s:rides-9-ratings.sql s:rides-10-declined.sql s:stats-f16.sql s:rides-11-paymark.sql s:rides-12-webhook.sql
  s:stats-2-f23.sql s:coins-1.sql s:coins-2-presence.sql
  s:rides-13-guard.sql s:rides-14-accept.sql s:rides-15-trip.sql s:rides-16-checkout.sql
  # Drošības labojumi jāvar palaist atkārtoti (A01–A04) — otrreiz
  s:rides-13-guard.sql s:rides-14-accept.sql s:rides-15-trip.sql s:rides-16-checkout.sql
  # Kopbraucienu scenāriji — katrs savā transakcijā (rollback), datubāzē neko neatstāj
  t:rides-guard-test.sql t:rides-accept-test.sql t:rides-trip-test.sql t:rides-checkout-test.sql
  p:rides-accept-parallel.sh
  # Monētu scenāriji atstāj datus; coins-test rakstīts pirms coins-3 (8 tēli), skins-test balstās uz coins-test pirkumiem
  t:coins-test.sql t:presence-test.sql
  s:coins-3-skins.sql
  t:skins-test.sql
  # A09: migrāciju uzskaite (palaižama atkārtoti)
  s:rides-17-migrations.sql s:rides-17-migrations.sql
  # A11: regulāra vecu datu tīrīšana (pg_cron — testos aizstājējs no supabase-stub.sql)
  s:cleanup-1.sql s:cleanup-1.sql
  t:cleanup-test.sql
  # A15: konta dzēšana — pārbaudes un anonīms brauciena ieraksts otram (palaižama atkārtoti)
  s:account-1-delete.sql s:account-1-delete.sql
  t:account-delete-test.sql
  # A16: citu braucēju punkti — atsevišķa izvēle, ~150 m, redz tikai braucot (palaižama atkārtoti)
  s:presence-2-privacy.sql s:presence-2-privacy.sql
  t:presence-privacy-test.sql
  # B02 (audits 2): atvērtie braucieni — šoferiem aptuveni, precīzi tikai pieņemtajam šoferim (palaižama atkārtoti)
  s:rides-18-open-privacy.sql s:rides-18-open-privacy.sql
  t:open-privacy-test.sql
  # B03 (audits 2): kopbrauciena maksa — ceļa izdevumu daļa (palaižama atkārtoti)
  s:rides-19-cost-share.sql s:rides-19-cost-share.sql
  t:cost-share-test.sql
  # B07 (audits 2): nelietotu anonīmu kontu dzēšana (palaižama atkārtoti)
  s:account-2-anon-cleanup.sql s:account-2-anon-cleanup.sql
  t:anon-cleanup-test.sql
  t:account-delete-test.sql
  # B08 (audits 2): radaru ziņojumi un balsis tikai ar kontu, viena balss no konta (palaižama atkārtoti)
  s:radars-2-votes.sql s:radars-2-votes.sql
  t:radar-votes-test.sql
  # B09 (audits 2): profilus (vārds, auto) redz tikai brauciena otra puse (palaižama atkārtoti)
  s:rides-20-profiles-privacy.sql s:rides-20-profiles-privacy.sql
  t:profiles-privacy-test.sql
  t:open-privacy-test.sql
  # B10 (audits 2): šofera Stripe kontu piesaista tikai ride-pay (service_role) (palaižama atkārtoti)
  s:rides-21-driver-accounts.sql s:rides-21-driver-accounts.sql
  t:driver-accounts-test.sql
  t:account-delete-test.sql
  t:anon-cleanup-test.sql
  # B12 (audits 2): lietotnes kļūdu pieraksts (palaižama atkārtoti)
  s:client-errors.sql s:client-errors.sql
  t:client-errors-test.sql
)

fail=0; pass=0
die() { echo "KĻŪDA: $*" >&2; exit 1; }
command -v psql >/dev/null || die "psql nav atrasts"

psql -X -q -v ON_ERROR_STOP=1 -c "drop database if exists \"$DB\"" -c "create database \"$DB\"" >/dev/null 2>&1 || die "neizdevās izveidot datubāzi $DB"
export PGDATABASE="$DB"
psql -X -q -v ON_ERROR_STOP=1 -f tests/sql/supabase-stub.sql >/dev/null || die "supabase-stub.sql"

run_test() {
  local t=$1 out p f e
  out=$(psql -X -v ON_ERROR_STOP=0 -f "tests/$t" 2>&1)
  p=$(grep -c 'NOTICE:  PASS' <<<"$out"); f=$(grep -c 'NOTICE:  FAIL' <<<"$out")
  e=$(grep -E '^psql:.*ERROR' <<<"$out" | wc -l)
  pass=$((pass + p)); fail=$((fail + f + e))
  if [ "$f" -eq 0 ] && [ "$e" -eq 0 ] && [ "$p" -gt 0 ]; then echo "  ✓ $t — $p"
  else
    echo "  ✗ $t — $p izdevās, $f neizdevās, $e kļūdas"
    grep -E 'NOTICE:  FAIL|ERROR' <<<"$out" | sed 's/^/      /' | head -20
    [ "$p" -eq 0 ] && fail=$((fail + 1))
  fi
}
run_parallel() {
  local out rc p f
  out=$(bash "tests/$1" "$DB" 2>&1); rc=$?
  p=$(grep -c '^PASS' <<<"$out"); f=$(grep -c '^FAIL' <<<"$out")
  pass=$((pass + p)); fail=$((fail + f))
  if [ $rc -eq 0 ] && [ "$p" -gt 0 ]; then echo "  ✓ $1 — $p"
  else echo "  ✗ $1"; sed 's/^/      /' <<<"$out"; [ "$f" -eq 0 ] && fail=$((fail + 1)); fi
}
for step in "${STEPS[@]}"; do
  kind=${step%%:*}; f=${step#*:}
  case $kind in
    s) out=$(psql -X -q -v ON_ERROR_STOP=1 -f "supabase/$f" 2>&1) || { echo "$out" | tail -5; die "shēma: $f"; }
       echo "  ✓ shēma: $f" ;;
    t) run_test "$f" ;;
    p) run_parallel "$f" ;;
  esac
done

PGDATABASE=postgres psql -X -q -c "drop database if exists \"$DB\"" >/dev/null 2>&1

# ---------- 2. daļa (A09): tieši produkcijas secībā (supabase/ORDER.txt) ----------
ok_()  { pass=$((pass + 1)); echo "  ✓ $1"; }
bad_() { fail=$((fail + 1)); echo "  ✗ $1"; [ -n "${2:-}" ] && sed 's/^/      /' <<<"$2" | head -15; }
ODB="${DB}_order"
export PGDATABASE=postgres
psql -X -q -v ON_ERROR_STOP=1 -c "drop database if exists \"$ODB\"" -c "create database \"$ODB\"" >/dev/null 2>&1 || die "neizdevās izveidot $ODB"
export PGDATABASE="$ODB"
psql -X -q -v ON_ERROR_STOP=1 -f tests/sql/supabase-stub.sql >/dev/null || die "supabase-stub.sql ($ODB)"
mapfile -t ORDER < <(grep -vE '^[[:space:]]*(#|$)' supabase/ORDER.txt | awk '{print $2}')
for f in "${ORDER[@]}"; do
  out=$(psql -X -q -v ON_ERROR_STOP=1 -f "supabase/$f" 2>&1) || { echo "$out" | tail -5; die "ORDER.txt: $f"; }
done
ok_ "ORDER.txt — visi ${#ORDER[@]} faili tukšā datubāzē pēc kārtas"
status_check() {   # $1 — gaidītais: ok | <teksts, kam jābūt rezultātā>
  local out; out=$(psql -X -q -At -F ' | ' -v ON_ERROR_STOP=1 -f supabase/status.sql 2>&1)
  if [ "$1" = ok ]; then [ "$out" = "VISS KĀRTĪBĀ | datubāze atbilst supabase/ORDER.txt | " ] && return 0
  else grep -qF "$1" <<<"$out" && return 0; fi
  echo "$out"; return 1
}
gen=$(bash tests/gen-status.sh 2>&1) && [ "$gen" = "$(cat supabase/status.sql)" ] && ok_ "supabase/status.sql ir aktuāls" \
  || bad_ "supabase/status.sql nav aktuāls — palaid: PGDATABASE=<uzbūvēta datubāze> bash tests/gen-status.sh > supabase/status.sql" "$(diff <(echo "$gen") supabase/status.sql | head -10)"
out=$(status_check ok) && ok_ "status.sql: VISS KĀRTĪBĀ" || bad_ "status.sql atrada problēmas" "$out"
last="${ORDER[${#ORDER[@]}-1]}"
for f in "${ORDER[@]:21}"; do   # 22–…: drošības labojumi, uzskaite, tīrīšana — drīkst palaist atkārtoti
  # Faili ar cz_migration_begin (27–…) — atkārtoti tikai pēdējais; vecākie atsakās (MIGRATIONS.md: „kamēr nav jaunāku”)
  if grep -q "^select public.cz_migration_begin(" "supabase/$f" && [ "$f" != "$last" ]; then
    out=$(psql -X -q -v ON_ERROR_STOP=1 -f "supabase/$f" 2>&1)
    if [ $? -ne 0 ] && grep -q "atkārtoti to palaist nedrīkst" <<<"$out"; then ok_ "atkārtoti: $f atsakās (ir jaunāks)"
    else bad_ "atkārtoti: $f NEatteicās, lai gan ir jaunāks fails" "$out"; fi
    continue
  fi
  out=$(psql -X -q -v ON_ERROR_STOP=1 -f "supabase/$f" 2>&1) && ok_ "atkārtoti: $f" || bad_ "atkārtoti: $f" "$out"
done
out=$(status_check ok) && ok_ "status.sql pēc atkārtošanas: VISS KĀRTĪBĀ" || bad_ "status.sql pēc atkārtošanas" "$out"
for f in $(grep -lE "cz_migrations where seq > [0-9]+\)" supabase/*.sql); do   # vecie faili ar aizsardzību
  out=$(psql -X -q -v ON_ERROR_STOP=1 -f "$f" 2>&1)
  if [ $? -ne 0 ] && grep -q "atkārtoti to palaist nedrīkst" <<<"$out"; then ok_ "aizsardzība: $(basename "$f") atsakās"
  else bad_ "aizsardzība: $(basename "$f") NEatteicās" "$out"; fi
done
out=$(status_check ok) && ok_ "status.sql pēc atteikumiem: nekas nav mainījies" || bad_ "status.sql pēc atteikumiem" "$out"
out=$(PGOPTIONS='-c cz.allow_rerun=on' psql -X -q -v ON_ERROR_STOP=1 -f supabase/rides-2-chat-trip.sql 2>&1) || bad_ "piespiedu atkārtošana (cz.allow_rerun)" "$out"
out=$(status_check "ride_driver_update(oid uuid, p_trip text, p_lat double precision, p_lng double precision, p_heading real) | cita versija") \
  && ok_ "status.sql pamana vecu funkcijas versiju (rides-2 pēc rides-15)" || bad_ "status.sql nepamanīja vecu versiju" "$out"
PGDATABASE=postgres psql -X -q -c "drop database if exists \"$ODB\"" >/dev/null 2>&1
echo
echo "SQL testi: $pass izdevās, $fail neizdevās"
[ "$fail" -eq 0 ]
