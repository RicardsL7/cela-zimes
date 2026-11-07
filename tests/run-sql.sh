#!/usr/bin/env bash
# Datubāzes testi (A08): uzbūvē visu shēmu no supabase/*.sql tukšā lokālā PostgreSQL un palaiž visus SQL scenārijus.
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
echo
echo "SQL testi: $pass izdevās, $fail neizdevās"
[ "$fail" -eq 0 ]
