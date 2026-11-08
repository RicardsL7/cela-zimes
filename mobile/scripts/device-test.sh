#!/usr/bin/env bash
# A14: Android lietotnes ierīces tests emulatorā (GitHub Actions → android.yml, darbs „device”).
# Lietošana: bash mobile/scripts/device-test.sh <apk> [izvades mape]   (vajag adb un palaistu emulatoru vai telefonu)
# Pārbauda: instalēšana; atļaujas (vieta, fona vieta, paziņojumi); App Links filtrs growlab.cc; palaišana bez avārijas;
# ielādē https://growlab.cc; Capacitor spraudņi (BackgroundGeolocation, App); https://growlab.cc saite atveras lietotnē
# (app-native.js žurnālā „[cz-native] gatavs” un „[cz-native] appUrlOpen”). Izvadē: package.txt, logcat*.txt, start.png, link.png.
# Testa (debug) APK — tikai tajā Capacitor raksta žurnālu (logcat), ko tests lasa.
set -u
APK=${1:?apk}; OUT=${2:-device-test}; PKG=cc.growlab.celazimes
mkdir -p "$OUT"
fail=0
ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; fail=1; }

adb wait-for-device
for i in $(seq 1 60); do [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break; sleep 2; done
adb install -r -g "$APK" > "$OUT/install.txt" 2>&1 && ok "instalēts" || { cat "$OUT/install.txt"; bad "instalēšana neizdevās"; exit 1; }

adb shell dumpsys package "$PKG" > "$OUT/package.txt"
grep -q "versionName=" "$OUT/package.txt" && echo "    $(grep -m1 -o 'versionName=[^ ]*' "$OUT/package.txt") $(grep -m1 -o 'versionCode=[0-9]*' "$OUT/package.txt")"
for p in ACCESS_FINE_LOCATION FOREGROUND_SERVICE_LOCATION POST_NOTIFICATIONS INTERNET; do
  grep -q "android.permission.$p" "$OUT/package.txt" && ok "atļauja $p" || bad "nav atļaujas $p"
done
grep -q "growlab.cc" "$OUT/package.txt" && ok "App Links filtrs (https://growlab.cc)" || bad "nav App Links filtra growlab.cc"
adb shell pm get-app-links "$PKG" > "$OUT/app-links.txt" 2>&1 || true

# Palaišana
adb logcat -c
adb shell am start -W -n "$PKG/.MainActivity" > "$OUT/start.txt" 2>&1
sleep 35
adb shell pidof "$PKG" > /dev/null && ok "lietotne darbojas pēc 35 s" || bad "lietotne nedarbojas (avārija?)"
adb exec-out screencap -p > "$OUT/start.png" 2>/dev/null || true
adb logcat -d > "$OUT/logcat.txt"
grep -q "FATAL EXCEPTION" "$OUT/logcat.txt" && { grep -A15 "FATAL EXCEPTION" "$OUT/logcat.txt" | head -30; bad "avārija (FATAL EXCEPTION)"; } || ok "bez avārijām"
grep -q "https://growlab.cc" "$OUT/logcat.txt" && ok "ielādē https://growlab.cc" || bad "nav pazīmju, ka ielādē https://growlab.cc"
grep -q "BackgroundGeolocation" "$OUT/logcat.txt" && ok "spraudnis BackgroundGeolocation" || bad "nav spraudņa BackgroundGeolocation"
grep -Eq "plugin instance: App\b|Registering plugin.*App[^a-zA-Z]|App\.getLaunchUrl|appUrlOpen" "$OUT/logcat.txt" && ok "spraudnis App" || echo "  · spraudņa App pieraksts žurnālā nav atrasts (pārbauda saites tests)"
# app-native.js lapā redz Capacitor un spraudni App (lapa nāk no growlab.cc bez @capacitor/core — tikai Capacitor.Plugins)
grep -q "\[cz-native\] gatavs" "$OUT/logcat.txt" && ok "app-native.js lietotnē darbojas (Capacitor.Plugins.App)" \
  || { grep -E "cz-native|Capacitor/Console" "$OUT/logcat.txt" | tail -8; bad "app-native.js lietotnē nedarbojas (nav [cz-native] gatavs)"; }

# Saite uz growlab.cc → lietotnē (appUrlOpen → app-native.js)
adb logcat -c
adb shell am start -W -a android.intent.action.VIEW -d "https://growlab.cc/?czapptest=1" "$PKG" > "$OUT/link.txt" 2>&1
sleep 20
adb logcat -d > "$OUT/logcat-link.txt"
adb exec-out screencap -p > "$OUT/link.png" 2>/dev/null || true
grep -Eq "\[cz-native\] (appUrlOpen|launchUrl) https://growlab.cc/ \?…" "$OUT/logcat-link.txt" && ok "https://growlab.cc saite atveras lietotnē ($(grep -Eo 'cz-native\] (appUrlOpen|launchUrl)' "$OUT/logcat-link.txt" | head -1 | cut -d' ' -f2))" \
  || { cat "$OUT/link.txt"; grep -E "cz-native|Capacitor|ActivityTaskManager: START" "$OUT/logcat-link.txt" | tail -25; bad "saite neatvērās lietotnē (nav [cz-native] appUrlOpen)"; }
adb shell pidof "$PKG" > /dev/null && ok "lietotne darbojas pēc saites" || bad "lietotne nedarbojas pēc saites"
grep -q "FATAL EXCEPTION" "$OUT/logcat-link.txt" && bad "avārija pēc saites" || true

echo
[ $fail -eq 0 ] && echo "Ierīces tests: viss kārtībā" || echo "IERĪCES TESTS NEIZDEVĀS"
exit $fail
