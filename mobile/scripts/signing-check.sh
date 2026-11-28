#!/usr/bin/env bash
# B19: parakstīšanas atslēgas pārbaude PIRMS būvēšanas (GitHub Actions → android.yml, solis „Parakstīšanas atslēga”).
# Mērķis — skaidra kļūda latviski, ja kāds no GitHub Secrets ir ielikts nepareizi (nevis neskaidra Gradle kļūda vēlāk).
# Ievade (vides mainīgie; vērtības šeit NEKAD neizdrukā):
#   KS_B64   — ANDROID_KEYSTORE_BASE64 (faila .jks saturs base64; atstarpes un rindiņu pārnesumi tiek izmesti)
#   KS_PASS  — ANDROID_KEYSTORE_PASSWORD
#   KEY_ALIAS — ANDROID_KEY_ALIAS (ja tukšs — celazimes)
#   KEY_PASS — ANDROID_KEY_PASSWORD (ja tukšs — tā pati, kas KS_PASS; jaunais keytool (PKCS12) prasa tikai vienu paroli)
#   KS_FILE  — kur ierakstīt atkodēto atslēgas failu (darbplūsma to izdzēš beigās)
#   CERT_OUT — kur ierakstīt sertifikāta SHA-256 (publisks — tas pats ir growlab.cc/.well-known/assetlinks.json)
# Izvade: 0 — atslēga derīga (vai atslēgas nav vispār: 2 → būvē tikai testa APK); 1 — kļūda (::error:: ar paskaidrojumu).
# KEYTOOL — keytool ceļš (testiem; pēc noklusējuma keytool no PATH).
set -u
KEYTOOL=${KEYTOOL:-keytool}
KS_B64=${KS_B64:-}; KS_PASS=${KS_PASS:-}; KEY_ALIAS=${KEY_ALIAS:-}; KEY_PASS=${KEY_PASS:-}
KS_FILE=${KS_FILE:?KS_FILE}; CERT_OUT=${CERT_OUT:-}
err() { echo "::error title=Android paraksts::$1"; exit 1; }

if [ -z "$KS_B64" ]; then
  if [ -n "$KS_PASS$KEY_ALIAS$KEY_PASS" ]; then
    err "GitHub Secrets ir parole vai alias, bet nav ANDROID_KEYSTORE_BASE64 (atslēgas faila). Ieliec to (mobile/README.md, 3.–4. solis) vai izdzēs pārējos."
  fi
  echo "::warning::Parakstīšanas atslēgas nav (mobile/README.md) — būvē tikai testa APK; telefons to nevarēs atjaunināt virs iepriekšējās versijas"
  exit 2
fi
[ -n "$KS_PASS" ] || err "Nav ANDROID_KEYSTORE_PASSWORD (atslēgas faila parole, ko izdomāji, veidojot atslēgu)."
[ -n "$KEY_ALIAS" ] || KEY_ALIAS=celazimes
[ -n "$KEY_PASS" ] || KEY_PASS=$KS_PASS

umask 077
printf '%s' "$KS_B64" | tr -d ' \t\r\n' | base64 -d > "$KS_FILE" 2>/dev/null \
  || err "ANDROID_KEYSTORE_BASE64 nav derīgs base64 teksts. Pārvērt .jks failu vēlreiz (mobile/README.md, 3. solis) un ielīmē visu tekstu."
[ "$(wc -c < "$KS_FILE")" -ge 500 ] || err "ANDROID_KEYSTORE_BASE64 ir pārāk īss — tas nav viss atslēgas fails. Ielīmē visu 3. soļa tekstu."

# Parole un alias (keytool kļūdas tekstā vērtību nav; GitHub tās tik un tā aizklāj)
out=$("$KEYTOOL" -list -v -keystore "$KS_FILE" -storepass "$KS_PASS" -alias "$KEY_ALIAS" 2>&1); rc=$?
if [ $rc -ne 0 ]; then
  if echo "$out" | grep -qiE "password was incorrect|password is incorrect|tampered"; then
    err "ANDROID_KEYSTORE_PASSWORD nav pareiza šim atslēgas failam (vai ANDROID_KEYSTORE_BASE64 ir no cita faila)."
  elif echo "$out" | grep -qiE "Alias <.*> does not exist|does not exist"; then
    names=$("$KEYTOOL" -list -keystore "$KS_FILE" -storepass "$KS_PASS" 2>/dev/null | sed -n 's/^\([^,]*\), .*\(PrivateKeyEntry\|keyEntry\).*/\1/p' | tr '\n' ' ')
    err "Atslēgas failā nav alias ar nosaukumu no ANDROID_KEY_ALIAS. Failā ir: ${names:-—}. Ieliec ANDROID_KEY_ALIAS tieši tā (vai izdzēs, ja tas ir celazimes)."
  elif echo "$out" | grep -qiE "Unrecognized keystore format|Invalid keystore format|not a valid keystore|DerInputStream|toDerInputStream"; then
    err "ANDROID_KEYSTORE_BASE64 nav atslēgas fails (.jks). Pārvērt tieši cela-zimes-release.jks (mobile/README.md, 3. solis)."
  else
    echo "$out" | grep -i "keytool error" | head -3
    err "Atslēgas failu neizdevās atvērt (sk. keytool kļūdu augstāk)."
  fi
fi
echo "$out" | grep -q "Entry type: PrivateKeyEntry" || err "Alias nav privātā atslēga (PrivateKeyEntry) — ar to nevar parakstīt. Izveido atslēgu ar mobile/README.md 1. soļa komandu."

# Atslēgas parole (JKS var būt cita nekā faila parolei; PKCS12 — vienāda)
if echo "$out" | grep -qi "Keystore type: PKCS12" && [ "$KEY_PASS" != "$KS_PASS" ]; then
  err "Šim atslēgas failam (PKCS12) abas paroles ir vienādas: ANDROID_KEY_PASSWORD jābūt tādai pašai kā ANDROID_KEYSTORE_PASSWORD (vai izdzēs ANDROID_KEY_PASSWORD)."
fi
if ! "$KEYTOOL" -certreq -keystore "$KS_FILE" -storepass "$KS_PASS" -alias "$KEY_ALIAS" -keypass "$KEY_PASS" -file /dev/null > /dev/null 2>&1; then
  err "ANDROID_KEY_PASSWORD nav pareiza (atslēgas parole). Ja, veidojot atslēgu, prasīja tikai vienu paroli — izdzēs ANDROID_KEY_PASSWORD."
fi

# Sertifikāts: SHA-256 (App Links) un derīguma termiņš (Google Play prasa līdz vismaz 22.10.2033)
FP=$(echo "$out" | sed -n 's/^[[:space:]]*SHA256: *//p' | head -1)
echo "$FP" | grep -Eq '^([0-9A-F]{2}:){31}[0-9A-F]{2}$' || err "Neizdevās nolasīt sertifikāta SHA-256."
until=$(echo "$out" | sed -n 's/^Valid from: .* until: //p' | head -1)
if [ -n "$until" ] && end=$(date -u -d "$until" +%s 2>/dev/null); then
  [ "$end" -gt "$(date -u +%s)" ] || err "Sertifikāta derīgums beidzies ($until) — ar to nevar parakstīt."
  [ "$end" -ge "$(date -u -d 2033-10-22 +%s)" ] || echo "::warning::Sertifikāts derīgs tikai līdz $until — Google Play prasa vismaz līdz 22.10.2033 (izveido ar -validity 10000)."
fi
[ -z "$CERT_OUT" ] || echo "$FP" > "$CERT_OUT"
echo "Parakstīšanas atslēga derīga: alias $KEY_ALIAS, sertifikāta SHA-256 $FP${until:+, derīgs līdz $until}"
exit 0
