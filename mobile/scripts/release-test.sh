#!/usr/bin/env bash
# B19: parakstītā laidiena ierīces tests emulatorā (GitHub Actions → android.yml, darbs „device”, pēc device-test.sh).
# Lietošana: bash mobile/scripts/release-test.sh <jaunais cela-zimes.apk> [iepriekšējais publicētais apk] [izvades mape]
# Pārbauda to, ko telefons dara, atjauninot no laidienu lapas:
#   1) atjaunināšana — iepriekšējā publicētā versija, tad jaunā virsū (adb install -r): tam vajag to pašu parakstu un
#      lielāku versionCode. Ja iepriekšējā bija testa (nav parakstīta) versija — paziņo (telefonā vecā vienreiz jāizdzēš).
#   2) palaišana bez avārijas, nav testa (debuggable) būvējums;
#   3) App Links (growlab.cc → lietotne) verifikācijas stāvoklis — tikai informācijai (vajag publicētu assetlinks.json).
# Parakstītā laidienā Capacitor žurnālu neraksta, tāpēc growlab.cc ielādi un spraudņus pārbauda device-test.sh (testa APK).
set -u
NEW=${1:?apk}; PREV=${2:-}; OUT=${3:-device-test/release}; PKG=cc.growlab.celazimes
WAIT=${CZ_WAIT:-30}
mkdir -p "$OUT"
fail=0
ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; fail=1; }

adb wait-for-device
adb uninstall "$PKG" > /dev/null 2>&1 || true   # device-test.sh uzinstalēja testa APK (cits paraksts)

if [ -n "$PREV" ] && [ -f "$PREV" ]; then
  if ! adb install "$PREV" > "$OUT/install-prev.txt" 2>&1; then
    echo "  · iepriekšējo versiju neizdevās uzinstalēt emulatorā — atjaunināšanas tests izlaists"; tail -2 "$OUT/install-prev.txt"
  elif adb shell dumpsys package "$PKG" | grep -q "DEBUGGABLE"; then
    echo "  · iepriekšējā publicētā versija bija testa (nav parakstīta) — telefonā to vienreiz jāizdzēš; atjaunināšanas tests — no nākamā laidiena"
    adb uninstall "$PKG" > /dev/null 2>&1 || true
  else
    adb install -r "$NEW" > "$OUT/install.txt" 2>&1; r=$(cat "$OUT/install.txt")
    if echo "$r" | grep -q "Success"; then ok "atjauninās virs iepriekšējās publicētās versijas (tas pats paraksts, lielāks versionCode)"
    else
      if echo "$r" | grep -q "UPDATE_INCOMPATIBLE"; then bad "PARAKSTS ATŠĶIRAS no iepriekšējā laidiena — telefoni nevarēs atjaunināt! (vai GitHub Secrets ir cita atslēga?)"
      elif echo "$r" | grep -q "VERSION_DOWNGRADE"; then bad "versionCode nav lielāks par iepriekšējo — telefoni neatjauninās"
      else echo "$r" | tail -3; bad "atjaunināšana neizdevās"; fi
      adb uninstall "$PKG" > /dev/null 2>&1 || true
    fi
  fi
else
  echo "  · iepriekšējās publicētās versijas nav — atjaunināšanas tests izlaists"
fi

if ! adb shell pm list packages "$PKG" | grep -q "package:$PKG"; then
  adb install "$NEW" > "$OUT/install.txt" 2>&1 && ok "instalēts" || { cat "$OUT/install.txt"; bad "instalēšana neizdevās"; echo "IERĪCES TESTS (LAIDIENS) NEIZDEVĀS"; exit 1; }
fi
adb shell dumpsys package "$PKG" > "$OUT/package.txt"
echo "    $(grep -m1 -o 'versionCode=[0-9]*' "$OUT/package.txt") $(grep -m1 -o 'versionName=[^ ]*' "$OUT/package.txt")"
grep -q "DEBUGGABLE" "$OUT/package.txt" && bad "laidiens ir testa (debuggable) būvējums" || ok "nav testa (debuggable) būvējums"
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS > /dev/null 2>&1 || true

adb logcat -c
adb shell am start -W -n "$PKG/.MainActivity" > "$OUT/start.txt" 2>&1
sleep "$WAIT"
adb shell pidof "$PKG" > /dev/null && ok "parakstītais laidiens darbojas pēc ${WAIT} s" || bad "parakstītais laidiens nedarbojas (avārija?)"
adb exec-out screencap -p > "$OUT/start.png" 2>/dev/null || true
adb logcat -d > "$OUT/logcat.txt"
if grep -q "FATAL EXCEPTION" "$OUT/logcat.txt"; then grep -A15 "FATAL EXCEPTION" "$OUT/logcat.txt" | head -30; bad "avārija (FATAL EXCEPTION)"; else ok "bez avārijām"; fi

adb shell pm verify-app-links --re-verify "$PKG" > /dev/null 2>&1 || true
sleep "${CZ_WAIT_LINKS:-10}"
adb shell pm get-app-links "$PKG" > "$OUT/app-links.txt" 2>&1 || true
if grep -q "growlab.cc: verified" "$OUT/app-links.txt"; then ok "App Links verificēts — growlab.cc saites atver lietotni"
else echo "  · App Links vēl nav verificēts ($(grep -o 'growlab.cc: [a-z_]*' "$OUT/app-links.txt" | head -1)) — pirmajā laidienā tas ir normāli: assetlinks.json publicējas pēc šī būvējuma; pārbaudi telefonā (mobile/README.md)"; fi

echo
[ $fail -eq 0 ] && echo "Ierīces tests (parakstītais laidiens): viss kārtībā" || echo "IERĪCES TESTS (LAIDIENS) NEIZDEVĀS"
exit $fail
