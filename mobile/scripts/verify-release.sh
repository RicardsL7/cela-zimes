#!/usr/bin/env bash
# B19: parakstītā laidiena pārbaude PĒC būvēšanas (GitHub Actions → android.yml) — pirms tas nonāk telefonos.
# Lietošana: bash mobile/scripts/verify-release.sh <cela-zimes.apk> <cela-zimes.aab> <sertifikāta SHA-256 fails>
# Pārbauda: APK paraksts derīgs (v2 shēma — Android 7+), parakstīts tieši ar mūsu atslēgu (tas pats SHA-256, kas
# assetlinks.json), nav testa (debuggable) būvējums, pakotne cc.growlab.celazimes, versionCode = CZ_VERSION_CODE;
# AAB (Google Play) ir parakstīts ar to pašu atslēgu.
# APKSIGNER / AAPT / JARSIGNER / KEYTOOL — rīku ceļi (pēc noklusējuma jaunākie no $ANDROID_HOME/build-tools un jarsigner no PATH).
set -u
APK=${1:?apk}; AAB=${2:?aab}; CERT=${3:?cert}
bt=$(ls -d "${ANDROID_HOME:-/usr/local/lib/android/sdk}"/build-tools/*/ 2>/dev/null | sort -V | tail -1)
[ -x "${bt}aapt" ] && aa="${bt}aapt" || aa="${bt}aapt2"   # aapt2 dump badging — tas pats formāts
APKSIGNER=${APKSIGNER:-${bt}apksigner}; AAPT=${AAPT:-$aa}; JARSIGNER=${JARSIGNER:-jarsigner}; KEYTOOL=${KEYTOOL:-keytool}
fail=0
ok()  { echo "  ✓ $1"; }
bad() { echo "::error title=Android laidiens::$1"; fail=1; }

want=$(tr -d ':\r\n ' < "$CERT" | tr 'A-F' 'a-f')
echo "$want" | grep -Eq '^[0-9a-f]{64}$' || { bad "nav gaidāmā sertifikāta SHA-256 ($CERT)"; exit 1; }

v=$("$APKSIGNER" verify --verbose --print-certs "$APK" 2>&1); rc=$?
[ $rc -eq 0 ] && ok "APK paraksts derīgs" || { echo "$v" | head -5; bad "APK paraksts nav derīgs"; }
echo "$v" | grep -q "Verified using v2 scheme (APK Signature Scheme v2): true" && ok "paraksta shēma v2" || bad "APK nav parakstīts ar v2 shēmu"
got=$(echo "$v" | sed -n 's/^Signer #1 certificate SHA-256 digest: *//p' | head -1 | tr 'A-F' 'a-f')
[ "$(echo "$v" | grep -c '^Signer #[0-9]* certificate SHA-256')" -eq 1 ] || bad "APK ir vairāki parakstītāji"
[ "$got" = "$want" ] && ok "parakstīts ar mūsu atslēgu (SHA-256 sakrīt ar assetlinks.json)" || bad "APK parakstīts ar citu atslēgu nekā GitHub Secrets (gaidīts ${want:0:16}…, ir ${got:0:16}…)"

b=$("$AAPT" dump badging "$APK" 2>&1)
echo "$b" | grep -q "^package: name='cc.growlab.celazimes'" && ok "pakotne cc.growlab.celazimes" || bad "nepareiza pakotne"
vc=$(echo "$b" | sed -n "s/^package: .*versionCode='\([0-9]*\)'.*/\1/p")
[ -z "${CZ_VERSION_CODE:-}" ] || { [ "$vc" = "$CZ_VERSION_CODE" ] && ok "versionCode $vc" || bad "versionCode $vc, gaidīts $CZ_VERSION_CODE"; }
echo "$b" | grep -q "application-debuggable" && bad "laidiens ir testa (debuggable) būvējums" || ok "nav testa (debuggable) būvējums"

j=$("$JARSIGNER" -verify "$AAB" 2>&1); rc=$?
if [ $rc -eq 0 ] && echo "$j" | grep -q "jar verified"; then ok "AAB (Google Play) paraksts derīgs"; else echo "$j" | tail -3; bad "AAB paraksts nav derīgs"; fi
ga=$("$KEYTOOL" -printcert -jarfile "$AAB" 2>&1 | sed -n 's/^[[:space:]]*SHA256: *//p' | head -1 | tr -d ':' | tr 'A-F' 'a-f')
[ "$ga" = "$want" ] && ok "AAB parakstīts ar mūsu atslēgu" || bad "AAB parakstīts ar citu atslēgu (gaidīts ${want:0:16}…, ir ${ga:0:16}…)"

[ $fail -eq 0 ] && echo "Parakstītais laidiens: viss kārtībā" || echo "PARAKSTĪTAIS LAIDIENS NAV KĀRTĪBĀ"
exit $fail
