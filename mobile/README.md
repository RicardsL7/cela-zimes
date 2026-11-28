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
| `scripts/signing-check.sh` | parakstīšanas atslēgas (GitHub Secrets) pārbaude pirms būvēšanas — skaidras kļūdas latviski |
| `scripts/verify-release.sh` | parakstītā APK / AAB pārbaude pēc būvēšanas (paraksts, atslēga, versija) |
| `scripts/release-test.sh` | parakstītā laidiena ierīces tests: atjaunināšana virs iepriekšējās versijas, palaišana, App Links |
| `www/index.html` | rāda tikai bez interneta |

Būvē `.github/workflows/android.yml`: testa APK → **ierīces tests Android 14 emulatorā** → laidienu lapa
https://github.com/RicardsL7/cela-zimes/releases/download/android-test/cela-zimes.apk (tikai, ja tests izdevās).

## Parakstīts laidiens (vienreiz — to dara tikai īpašnieks)

Bez paraksta katrs būvējums ir parakstīts ar citu testa atslēgu: telefons jauno versiju neuzinstalē virs vecās, un
saites (e-pasta pieslēgšanās, Google, Stripe) atveras pārlūkā, nevis lietotnē. Parakstīšanas atslēga to atrisina.
Atslēgu, paroles un GitHub Secrets veido un ievada **tikai īpašnieks** (ne Claude, ne kāds cits).

1. **Izveido atslēgu savā datorā.** Vajag `keytool` (nāk ar Java):
   - Windows ar Android Studio — PowerShell:
     ```
     & "C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe" -genkeypair -v -storetype PKCS12 -keystore cela-zimes-release.jks -alias celazimes -keyalg RSA -keysize 4096 -validity 10000
     ```
   - Bez Android Studio — uzinstalē Java (piem. „Eclipse Temurin 21”), tad jebkurā terminālī:
     ```
     keytool -genkeypair -v -storetype PKCS12 -keystore cela-zimes-release.jks -alias celazimes -keyalg RSA -keysize 4096 -validity 10000
     ```
   Tas prasīs **vienu paroli** (izdomā garu, piem. 4 nejaušus vārdus) un vārdu / organizāciju (var rakstīt savu vārdu
   un „Ceļa Zīmes”; tas ir sertifikātā, nav slepens). `-validity 10000` — derīga ~27 gadus (Google Play prasa līdz 2033+).
2. **Saglabā `cela-zimes-release.jks` un paroli drošā vietā** — paroļu pārvaldnieks + rezerves kopija (piem. USB zibatmiņa
   vai šifrēts mākonis). Ja atslēga vai parole pazūd, telefoni lietotni vairs neatjauninās — būs jāizdod jauna lietotne.
   Nekad neliec atslēgu repozitorijā, e-pastā vai čatā (arī Claude).
3. **Pārvērt failu tekstā (base64)** — tajā pašā mapē, kur fails:
   - Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\cela-zimes-release.jks")) | Set-Clipboard`
     (teksts tagad ir starpliktuvē — neielīmē to nekur citur kā 4. solī)
   - macOS: `base64 -i cela-zimes-release.jks | pbcopy`; Linux: `base64 -w0 cela-zimes-release.jks`
4. **GitHub → repozitorijs → Settings → Secrets and variables → Actions → New repository secret:**

   | Nosaukums | Vērtība | |
   |---|---|---|
   | `ANDROID_KEYSTORE_BASE64` | 3. soļa teksts (ielīmē visu) | obligāts |
   | `ANDROID_KEYSTORE_PASSWORD` | 1. soļa parole | obligāts |
   | `ANDROID_KEY_ALIAS` | `celazimes` | nav obligāti (noklusējums `celazimes`) |
   | `ANDROID_KEY_PASSWORD` | tā pati parole | nav obligāti (noklusējums — tā pati, kas faila parolei) |

5. **Actions → Android APK → Run workflow.** Darbplūsma:
   - vispirms pārbauda atslēgu (`scripts/signing-check.sh`) — ja kāds Secrets ir nepareizs, kļūda latviski pasaka, kurš
     (nepareiza parole, cits alias, nepilns base64, nav atslēgas faila, derīgums beidzies);
   - uzbūvē parakstītu APK un AAB un pārbauda tos (`scripts/verify-release.sh`): derīgs paraksts (v2), tieši šī atslēga,
     nav testa būvējums, pareizs versionCode;
   - emulatorā (`scripts/release-test.sh`) — **Atjaunināšanas tests**: uzinstalē iepriekšējo publicēto versiju un jauno
     virsū (vajag to pašu parakstu un lielāku versionCode), palaiž, pārbauda avārijas un App Links;
   - ieliek `.well-known/assetlinks.json` (sertifikāta SHA-256 — publisks), lai growlab.cc saites atvērtu lietotni;
   - publicē APK laidienu lapā tikai, ja viss izdevās.
6. Telefonā **vienreiz izdzēs veco testa lietotni** (cits paraksts) un uzinstalē jauno no
   https://github.com/RicardsL7/cela-zimes/releases/download/android-test/cela-zimes.apk. Turpmāk atjauninās virs.

Ja atslēgu kādreiz nomaina (pazudusi vai nopludināta) — atjaunināšanas tests to atklās („PARAKSTS ATŠĶIRAS”): telefonos
vecā lietotne būs jāizdzēš, un Play versijai jāprasa atslēgas maiņa (Play Console → App integrity → upload key reset).

## Google Play (kad būs Play konts)

- **Konts:** Google Play Console izstrādātāja konts (vienreizēja maksa; personas identitātes pārbaude). **Jauniem
  personīgajiem kontiem** pirms publicēšanas visiem: slēgtais tests ar vismaz **12 testētāji** (pierakstījušies) **14 dienas
  pēc kārtas** — sk. Google „App testing requirements for new personal developer accounts”. Organizācijas kontam (vajag
  D-U-N-S numuru) šīs prasības nav. Noteikumi mainās — pirms reģistrācijas pārbaudi aktuālos.
- Play Console → izveido lietotni `cc.growlab.celazimes` → augšupielādē `cela-zimes.aab`
  (Actions → Android APK → pēdējā palaišana → Artifacts → `android`).
- Ieslēdzot Play App Signing, Google lietotni pārparaksta ar savu atslēgu: Play Console → App integrity → nokopē
  **App signing key SHA-256** un pievieno to `.well-known/assetlinks.json` (otrs ieraksts `sha256_cert_fingerprints`
  sarakstā), citādi saites Play versijā atvērsies pārlūkā.
- Vajag arī: privātuma politikas adrese (https://growlab.cc/privacy.html), fona atrašanās vietas pamatojums un video
  (Play prasa lietotnēm ar `ACCESS_BACKGROUND_LOCATION` / atrašanās vietas priekšplāna servisu), satura vērtējums.

## Ierīces tests ar roku (telefonā, pirms laidiena)

Automātiski (emulatorā) tiek pārbaudīts: instalēšana, atjaunināšana virs iepriekšējās versijas (parakstīts laidiens),
atļaujas, App Links filtrs, palaišana bez avārijas, growlab.cc ielāde, spraudņi un tas, ka growlab.cc saite atveras
lietotnē. Īstu GPS, e-pastu, Google, Stripe un īstu telefonu emulators nepārbauda — to dara šis saraksts.

| # | Kas jādara | Kas jāredz |
|---|---|---|
| 1 | Telefonā atver laidiena saiti (6. solis), lejupielādē, atļauj „instalēt no šī avota”, uzinstalē | Ikona „Ceļa Zīmes”; atveras karte |
| 2 | Pēc nākamā laidiena — uzinstalē jauno virsū (vecā nav jādzēš) | „Atjaunināt”, nevis „Lietotne nav instalēta”; dati (pieslēgšanās) saglabājas |
| 3 | Atrašanās vieta: „Atļaut, kamēr lieto lietotni”; paziņojumi: „Atļaut”. Sāc navigāciju, izslēdz ekrānu uz 2–3 min (braucot vai ejot) | Paziņojums „Navigācija fonā”; ieslēdzot ekrānu, ceļš turpinājies |
| 4 | Iestatījumi → Lietotnes → Ceļa Zīmes → „Atvērt pēc noklusējuma” | „growlab.cc” — verificēts / ieslēgts |
| 5 | Pieslēgšanās ar e-pasta saiti: saiti no e-pasta atver telefonā | Atveras **lietotne** (nevis pārlūks) un ir pieslēgta |
| 6 | Pieslēgšanās ar Google | Atveras pārlūks, pēc tam atgriežas **lietotnē** pieslēgtā |
| 7 | Kopbrauciena maksājums (Stripe testa režīms, sk. `PAYMENTS-TEST.md`) | Pēc samaksas atgriežas lietotnē, maksājums redzams |
| 8 | Lidmašīnas režīms → atver lietotni → izslēdz lidmašīnas režīmu | „Nav interneta savienojuma”, pēc tam atkal strādā |
| 9 | TalkBack (ekrāna lasītājs) | Paneļi nolasās, „atpakaļ” aizver paneli (A12) |
| 10 | Vismaz divi telefoni (piem. jaunāks Android 14+ un vecāks Android 10–12) | 1.–8. abos |

## Rezultāti

| Datums | Telefons (modelis, Android) | Versija (versionCode) | Soļi | Rezultāts | Piezīmes |
|---|---|---|---|---|---|
| — | — | — | — | vēl nav veikts | parakstīšanas atslēga vēl nav izveidota |
