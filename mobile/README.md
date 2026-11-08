# Ceļa Zīmes — Android lietotne (audits A14)

Capacitor apvalks ap **https://growlab.cc** ar fona GPS (spraudnis `@capacitor-community/background-geolocation`).
Lietotne ielādē to pašu vietni — jauna vietnes versija lietotnē parādās uzreiz; APK jābūvē no jauna tikai, ja mainās
šī mape (atļaujas, spraudņi, versija).

| Fails | Kas |
|---|---|
| `package.json` / `package-lock.json` | atkarības; lockfile atjauno GitHub Actions „Android atkarības (lockfile)”, būvē ar `npm ci` |
| `capacitor.config.json` | lietotnes ID `cc.growlab.celazimes`, adrese https://growlab.cc |
| `scripts/patch-android.js` | atļaujas (vieta, fona vieta, paziņojumi), App Links uz growlab.cc, versija, paraksts |
| `scripts/device-test.sh` | ierīces tests (emulatorā GitHub Actions vai ar `adb` pievienotā telefonā) |
| `www/index.html` | rāda tikai bez interneta |

Būvē `.github/workflows/android.yml`: testa APK → **ierīces tests Android 14 emulatorā** → laidienu lapa
https://github.com/RicardsL7/cela-zimes/releases/download/android-test/cela-zimes.apk (tikai, ja tests izdevās).

## Parakstīts laidiens (vienreiz — to dara tikai īpašnieks)

Bez paraksta katrs būvējums ir parakstīts ar citu testa atslēgu: telefons jauno versiju neuzinstalē virs vecās, un
saites (e-pasta pieslēgšanās, Google, Stripe) atveras pārlūkā, nevis lietotnē. Parakstīšanas atslēga to atrisina.

1. Savā datorā (vajag Java; Android Studio to satur) izveido atslēgu — paroles izdomā pats:
   ```
   keytool -genkeypair -v -keystore cela-zimes-release.jks -alias celazimes -keyalg RSA -keysize 4096 -validity 10000
   ```
2. **Saglabā `cela-zimes-release.jks` un paroles drošā vietā** (paroļu pārvaldnieks + rezerves kopija). Ja atslēga pazūd,
   lietotni vairs nevar atjaunināt — jāizdod jauna. Nekad neliec to repozitorijā, e-pastā vai čatā.
3. Pārvērt failu tekstā (base64):
   - Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cela-zimes-release.jks")) | Set-Clipboard`
   - macOS / Linux: `base64 -w0 cela-zimes-release.jks` (macOS: `base64 -i cela-zimes-release.jks`)
4. GitHub → repozitorijs → **Settings → Secrets and variables → Actions → New repository secret** — četri:
   `ANDROID_KEYSTORE_BASE64` (3. solis), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`celazimes`), `ANDROID_KEY_PASSWORD`.
5. **Actions → Android APK → Run workflow.** Darbplūsma uzbūvē parakstītu APK un AAB, un pati ieliek
   `.well-known/assetlinks.json` (sertifikāta SHA-256 — publisks), lai growlab.cc saites atvērtu lietotni.
6. Telefonā **vienreiz izdzēs veco testa lietotni** (cits paraksts) un uzinstalē jauno. Turpmāk atjauninās virs.

## Google Play (kad būs Play konts)

- Play Console → izveido lietotni `cc.growlab.celazimes` → augšupielādē `cela-zimes.aab`
  (Actions → Android APK → pēdējā palaišana → Artifacts → `android`).
- Ieslēdzot Play App Signing, Google lietotni pārparaksta ar savu atslēgu: Play Console → App integrity → nokopē
  **App signing key SHA-256** un pievieno to `.well-known/assetlinks.json` (otrs ieraksts `sha256_cert_fingerprints`
  sarakstā), citādi saites Play versijā atvērsies pārlūkā.
- Vajag arī: privātuma politikas adrese (https://growlab.cc/privacy.html), fona atrašanās vietas pamatojums un video
  (Play prasa lietotnēm ar `ACCESS_BACKGROUND_LOCATION` / atrašanās vietas priekšplāna servisu), satura vērtējums.

## Ierīces tests ar roku (telefonā, pirms laidiena)

- [ ] Uzinstalējas; atjauninās virs iepriekšējās versijas (parakstīts laidiens).
- [ ] Atrašanās vieta: „Atļaut, kamēr lieto lietotni”; navigācija ar izslēgtu ekrānu turpinās, paziņojums redzams.
- [ ] Pieslēgšanās ar e-pasta saiti: saite no e-pasta atver **lietotni** un tā ir pieslēgta.
- [ ] Pieslēgšanās ar Google: atveras pārlūks, pēc tam atgriežas **lietotnē** pieslēgtā.
- [ ] Kopbrauciena maksājums (Stripe testa režīms): pēc samaksas atgriežas lietotnē, maksājums redzams.
- [ ] Bez interneta: lietotne parāda „Nav interneta savienojuma”, pēc tam atkal strādā.
- [ ] Ekrāna lasītājs (TalkBack): paneļi nolasās, Esc / atpakaļ aizver (A12).
- [ ] Vismaz divi telefoni (piem. jaunāks Android 14+ un vecāks Android 10–12).

Automātiski (emulatorā) tiek pārbaudīts: instalēšana, atļaujas, App Links filtrs, palaišana bez avārijas, growlab.cc
ielāde, spraudņi un tas, ka growlab.cc saite atveras lietotnē. Īstu GPS, e-pastu, Google un Stripe emulators nepārbauda.
