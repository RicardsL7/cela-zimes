#!/usr/bin/env bash
# A10: trešo pušu bibliotēkas lietotnes paša mapē (vendor/), pēc vendor/vendor.lock — ar SHA-256 pārbaudi.
# Lietošana:  bash tools/vendor.sh           — lejupielādē arhīvus, pārbauda, ieliek vendor/<nosaukums>-<versija>/,
#                                              izdzēš vendor/ mapes, kuru vairs nav sarakstā (to dara GitHub Actions)
#             bash tools/vendor.sh --check   — tikai pārbauda, vai vendor/ faili sakrīt ar sarakstu (bez tīkla)
# Kods 1, ja kaut kas nesakrīt (lejupielādētais arhīvs vai fails ar citu SHA-256 netiek saglabāts).
set -euo pipefail
cd "$(dirname "$0")/.."
LOCK=vendor/vendor.lock
MODE=${1:-fetch}
case "$MODE" in fetch|--check) ;; *) echo "Lietošana: bash tools/vendor.sh [--check]" >&2; exit 2 ;; esac
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
sha() { sha256sum "$1" | awk '{print $1}'; }
die() { echo "KĻŪDA: $*" >&2; exit 1; }
fail=0; keep=()
while read -r kind name ver src want _; do
  case "$kind" in ''|\#*) continue ;; esac
  [ -n "${want:-}" ] && [[ "$want" =~ ^[0-9a-f]{64}$ ]] || die "slikta rinda vendor.lock: $kind $name $ver $src"
  [[ "$name-$ver" =~ ^[a-z0-9._-]+$ ]] || die "slikts nosaukums: $name-$ver"
  dir="vendor/$name-$ver"; keep+=("$name-$ver")
  case "$kind" in
    zip)
      [ "$MODE" = --check ] && continue
      [[ "$src" =~ ^https://github\.com/ ]] || die "arhīvs tikai no github.com: $src"
      curl -sSfL --retry 3 -o "$TMP/$name-$ver.zip" "$src" || die "neizdevās lejupielādēt $src"
      got=$(sha "$TMP/$name-$ver.zip"); [ "$got" = "$want" ] || die "$src SHA-256 $got, gaidīts $want"
      mkdir -p "$TMP/$name-$ver"; unzip -q -o "$TMP/$name-$ver.zip" -d "$TMP/$name-$ver"
      echo "  ✓ $src" ;;
    file)
      out="$dir/$(basename "$src")"
      if [ "$MODE" = fetch ]; then
        f="$TMP/$name-$ver/$src"; [ -f "$f" ] || die "arhīvā nav $src (vai zip rinda nav pirms file rindām)"
        got=$(sha "$f"); [ "$got" = "$want" ] || die "$src SHA-256 $got, gaidīts $want"
        mkdir -p "$dir"; cp "$f" "$out"
      fi
      if [ -f "$out" ] && [ "$(sha "$out")" = "$want" ]; then echo "  ✓ $out"
      else echo "  ✗ $out — trūkst vai cits saturs"; fail=1; fi ;;
    *) die "nezināma rinda vendor.lock: $kind" ;;
  esac
done < "$LOCK"
if [ "$MODE" = fetch ]; then
  for d in vendor/*/; do
    [ -d "$d" ] || continue; b=$(basename "$d")
    [[ " ${keep[*]} " == *" $b "* ]] || { rm -rf "$d"; echo "  − izdzēsts $d (nav vendor.lock)"; }
  done
fi
exit $fail
