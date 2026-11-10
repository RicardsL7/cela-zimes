# Ceļa Zīmes

Navigācijas lietotne Latvijai: karte ar ceļa zīmēm, ātruma ierobežojumiem, radariem un brīdinājumiem uz ceļa,
maršruts ar navigāciju, stāvvietas, sastrēgumi un kopbraucieni („Kopā”) ar kartes maksājumiem.

- **Lietotne:** https://growlab.cc (GitHub Pages no šī repozitorija `main` zara; `CNAME`)
- **Android testa lietotne:** https://github.com/RicardsL7/cela-zimes/releases/download/android-test/cela-zimes.apk
- **Izmaiņu žurnāls:** [`STATUSS.md`](STATUSS.md) · kopbraucieni: [`RIDES.md`](RIDES.md) ·
  konti un e-pasts: [`AUTH-IESTATIJUMI.md`](AUTH-IESTATIJUMI.md) · datubāze: [`supabase/MIGRATIONS.md`](supabase/MIGRATIONS.md)

## Kā tas uzbūvēts

Statiska lapa (HTML + JavaScript bez būvēšanas soļa) + Supabase (datubāze, konti, servera funkcijas) + Stripe (maksājumi).

| Daļa | Kas |
|---|---|
| Karte | MapLibre GL 6 no `vendor/` (ne CDN; `index.html` / `index-gl.html` — abi vienādi), OpenFreeMap vektoru flīzes |
| Zīmes, ātrumi | OpenStreetMap (Overpass), Mapillary ielu foto (`mly-config.js` — publiskais klienta žetons) |
| Meklēšana, maršruts | Photon / Nominatim, OSRM |
| Konti, kopbraucieni, ziņojumi, sastrēgumi | Supabase: PostgreSQL ar RLS (`supabase/*.sql`), anonīmi konti + e-pasts / Google |
| Maksājumi | Stripe Connect; servera funkcijas `supabase/functions/ride-pay` un `stripe-webhook` |
| Android | `mobile/` — Capacitor apvalks ap growlab.cc ar fona GPS; APK būvē un emulatorā pārbauda GitHub Actions (`android.yml`); paraksts, Play, ierīču tests — [`mobile/README.md`](mobile/README.md) |

Galvenie faili: `app-gl.js` (karte, GPS, navigācija, brīdinājumi), `signs-gl.js` / `signs.js` (zīmes), `nav.js` (maršruts),
`roads-gl.js` (ceļu indekss), `alerts.js` / `reports.js` (brīdinājumi, ziņojumi), `rides.js` / `rides-ui.js` (kopbraucieni),
`auth.js` (konts, piekrišanas), `traffic*.js` (sastrēgumi), `park*.js` / `parking.js` (stāvēšana), `garage.js` / `skins*.js`
(Garāža), `admin.html` (īpašnieka statistika), `terms.html` / `privacy.html`.
Vecā Leaflet versija (`app.js`, `basemap.js`, `roads.js`, `signlayer.js`, `style.css`) netiek lietota.

## Kā palaist savā datorā

```
python -m http.server 8000
```
Pārlūkā atver **http://localhost:8000** (atrašanās vietai vajag `localhost` vai `https://`). Ja dators nezina atrašanās
vietu: iestatījumi → **Testa režīms** → noklikšķini uz ceļa kartē. Lai apturētu serveri — `Ctrl + C`.
Kopbraucieni lokāli lieto to pašu Supabase projektu (`rides-config.js`: URL + publiskā atslēga; tukšas vērtības →
demo režīms tikai šajā pārlūkā).

## Datubāze un serveris

- Shēmu maina tikai `supabase/*.sql` faili, ko īpašnieks palaiž Supabase SQL redaktorā **secībā no `supabase/ORDER.txt`**.
  Vai produkcija sakrīt ar repozitoriju — `supabase/status.sql` (tikai lasa). Viss par migrācijām, jaunu projektu un
  rezerves kopijām — [`supabase/MIGRATIONS.md`](supabase/MIGRATIONS.md).
- Vecus datus (privātuma politikas termiņi) ik 5 min dzēš datubāzes plānotājs (`supabase/cleanup-1.sql`, pg_cron);
  vai tas strādā — `admin.html` un GitHub Actions „Uzraudzība” (reizi stundā; ja nestrādā — e-pasts no GitHub).
- Konta dzēšana (`supabase/account-1-delete.sql`, A15): nav iespējama aktīva brauciena, atvērtas maksājuma lapas vai
  nepabeigtas atmaksas laikā; otram brauciena dalībniekam paliek anonīms brauciena ieraksts (datums, cena, maksājums,
  maršruts ~1 km) — sīkāk `supabase/MIGRATIONS.md` un `privacy.html` 9. punkts.
- Citi braucēji kartē (`supabase/presence-2-privacy.sql`, A16): tikai ar slēdzi „Rādīt mani citu kartē” (noklusēti
  izslēgts), ~150 m, pēc ~1 min braukšanas; redz tikai pieteikušies lietotāji, kuri paši brauc ≤ 15 km attālumā.
- Kopbrauciena maksa (`supabase/rides-19-cost-share.sql`, B03): tikai ceļa izdevumu daļa — attālums × 1,3 × 12 c/km,
  vismaz 2 € (datubāze lielāku cenu atsaka). Īsti maksājumi (`PAY_LIVE`) — tikai pēc jurista un grāmatveža apstiprinājuma.
- Servera funkcijas: `ride-pay`; `stripe-webhook` ar izslēgtu JWT pārbaudi (`--no-verify-jwt`). Pēdējā izvietošana —
  08.11.2026 (audits B01), kods sakrīt ar šo repozitoriju. Slepenās atslēgas
  (Stripe, `service_role`) — tikai Supabase Secrets, **nekad** šajā repozitorijā vai pārlūkā.

## Drošība pārlūkā (audits A10)

- Katrai lapai ir **CSP** (`<meta http-equiv="Content-Security-Policy">` `<head>` sākumā): JavaScript tikai no pašas lapas
  (bez iekļauta koda un `eval`), tīkla pieprasījumi tikai uz uzskaitītajiem serveriem (`connect-src`), bez rāmjiem un spraudņiem.
  **Jauns serveris** (`fetch`) → jāpievieno `connect-src` visās lapās; `tests/run.js` to pārbauda, kartes tests pārbauda,
  ka CSP pārkāpumu nav.
- **Trešo pušu JavaScript nav**: MapLibre ir mapē `vendor/` — versija un SHA-256 failā `vendor/vendor.lock`. Lai mainītu
  versiju: atjauno `vendor/vendor.lock` (un ceļus `index*.html`, `maplibre-load.js`) → GitHub Actions „Bibliotēkas (vendor)”
  lejupielādē, pārbauda un saglabā failus. Ar roku `vendor/` failus nelabo.
- `guard.js` — lapa svešā rāmī (iframe) netiek rādīta (pretklikšķu viltība).
- **Ko GitHub Pages neļauj:** HTTP galvenes (`Content-Security-Policy` ar `frame-ancestors`, `X-Frame-Options`, CSP
  ziņojumi `report-to`). Meta tags to nespēj. Ja vajag pilnu aizsardzību — vietne aiz Cloudflare (vai cita hostinga), kas
  pievieno galvenes; šī CSP tad pārceļama galvenē bez izmaiņām.

## Mērogošana un ārējie servisi (A13)

**Ko lietotne dara pati** (`netguard.js` — visi lapas `fetch` pieprasījumi):
- skaita pieprasījumus katram serverim šajā ierīcē (šodien / 7 dienas, kļūdas, 429/503, vidējais laiks) — iestatījumos ar
  `?dev=1` („Tīkla pieprasījumi šajā ierīcē”) vai konsolē `window.czNet.stats()`;
- bezmaksas serveriem ievēro to noteikumus (rinda: Nominatim ≤ 1/s, OSRM ≤ 1/s, Overpass ≤ 2 vienlaikus) un pēc „par daudz”
  vai kļūmes ieturē pauzi (5 s → 10 s → … ≤ 5 min; Overpass pēc 429 — vismaz 30 s), pauzes laikā serveri netraucē;
- Overpass jautā vienam serverim (veselākajam), otram — tikai ja pirmais 4 s neatbild vai kļūdās (agrāk — abiem reizē);
  B05: šobrīd ir tikai viens — overpass-api.de (ES); Krievijā bāzētais maps.mail.ru izņemts, rezervei — savs serveris;
- fona cilnē neaptaujā: ziņojumi, sastrēgumi, citi braucēji, laikapstākļi, „Kopā” (bez aktīva brauciena; braucienā vieta
  jāsūta arī fonā). Atgriežoties cilnē — dati atjaunojas uzreiz.
- Jau agrāk: kešatmiņa (OSM šūnas 3 d., meklēšana 1 d., laikapstākļi 10 min), vienādu pieprasījumu apvienošana, meklēšana
  pēc 300 ms pauzes rakstīšanā.

**Aptuvenā slodze uz vienu lietotāju, kam lietotne atvērta** (aprēķināts no koda intervāliem; īstos skaitļus rāda
`window.czNet.stats()` un Supabase → Reports):

| Serviss | Pieprasījumi stundā | No kā atkarīgs |
|---|---|---|
| Supabase (mūsu) | ~280; ar „Palīdzēt citiem” ~580; aktīvā kopbraucienā vadītājam +~1400 | citi braucēji ik 20 s, ziņojumi ik 60 s, sastrēgumi ik 90 s, mērījumi ik 30 s, kopbrauciens ik 5 s |
| Overpass (zīmes, vietas, stāvēšana) | 0 pazīstamā vietā; līdz ~60 braucot pa jaunām vietām | jaunas ~1 km šūnas (kešs 3 d.) |
| Photon / Nominatim (meklēšana) | dažas | tikai meklējot; Nominatim — tikai ja Photon neatbild |
| OSRM (maršruts) | dažas | maršruts un pārrēķins, nobraucot no tā |
| Open-Meteo | ≤ 6 | ik 10 min vai pēc 15 km |
| OpenFreeMap flīzes | daudz (worker) | kartes pārvietošana; ierobežojumu nav |

**Kur ir robeža** (publisko serveru noteikumi — `STATUSS.md` A13 avoti; lietotāju skaiti — orientējoši):
- **Overpass** (overpass-api.de): lietotnei visu lietotāju kopsummā regulāri ~100 vaicājumi dienā; komerciālai lietošanai —
  savs vai maksas serveris. **Jau dažiem desmitiem aktīvu lietotāju dienā** jāplāno: zīmju un ātrumu dati iepriekš sagatavoti
  (kā `data/osm/cameras.json` — GitHub Actions katru nakti) vai savs Overpass serveris.
- **Nominatim**: absolūti ≤ 1 pieprasījums sekundē visai lietotnei, meklēšana rakstīšanas laikā aizliegta — lietojam tikai
  kā rezervi Photon, tikai nospiežot „Meklēt”, ar rindu.
- **Photon** (komoot): „saprātīgā apjomā”, lielu lietošanu ierobežo — virs dažiem simtiem lietotāju — savs Photon.
- **OSRM demo / routing.openstreetmap.de**: bez garantijām, pārmērīgu lietošanu bloķē — virs ~100 aktīvu lietotāju — savs
  OSRM vai maksas maršrutēšana.
- **Supabase**: ~0,08–0,16 pieprasījumi sekundē uz lietotāju → 100 vienlaicīgi ≈ 8–16/s (bezmaksas plāns), 1000 ≈ 80–160/s
  (maksas datora izmērs un retāka „citi braucēji” aptauja), 10 000 — jāpārskata arhitektūra (piem. Realtime).
- **OpenFreeMap**: ierobežojumu nav (tikai bezsaistes lejupielādei); OSM rastra flīzes (izvēle „OSM”) — nav paredzētas
  lietotnēm ar daudz lietotājiem; noklusējums ir OpenFreeMap.

Mērķa lietotāju skaits vēl nav noteikts — kad tas būs, pēc šīs tabulas izvēlas, kuru servisu pirmo pārcelt uz savu/maksas.

### Ārējie servisi: pāreja uz komerciālu lietošanu (B04)

Šobrīd lietotne ir bez maksas, un maksājumi notiek tikai testa režīmā, tāpēc tā lieto bezmaksas publiskos serverus to
noteikumu robežās (`netguard.js`). **Komerciāla tā kļūst, kad ieslēdz īstus maksājumus (`PAY_LIVE`, 10 % komisija)** —
tad vismaz laikapstākļiem jāpāriet uz maksas plānu. Visas adreses ir vienā failā `services.js` (`CZ_SERVICES`); maršrutam
jau ir rezerves serveris (ja OSRM demo neatbild — FOSSGIS). Cenas — 10.11.2026, pirms pirkšanas jāpārbauda.

| Serviss | Tagad | Noteikumi komerciālai lietotnei | Variants, kad vajag | Cena |
|---|---|---|---|---|
| Laikapstākļi | Open-Meteo bezmaksas | Tikai nekomerciāli → **jāmaina pirms `PAY_LIVE`** | Open-Meteo API Standard caur funkciju `weather` | $29/mēn. (1 milj. pieprasījumu) |
| Maršruts | OSRM demo + FOSSGIS rezerve | Atļauts publiskai lietotnei bez maksas sienas, ≤ 1/s, ar atsauci; bez garantijām | GraphHopper Basic vai savs OSRM | €69/mēn. vai serveris |
| Meklēšana | Photon (komoot) + Nominatim | „Saprātīgā apjomā”; Nominatim ≤ 1/s, bez meklēšanas rakstot | Stadia Maps Starter vai savs Photon | $20/mēn. vai serveris |
| Vietas, zīmes | Overpass | Lieliem apjomiem — savs serveris | Savs Overpass (tikai Latvija) | serveris |
| Karte | OpenFreeMap | Atļauts, bez ierobežojuma | — | 0 |

Savs serveris Latvijas datiem (OSRM + Photon + Overpass): Hetzner 8 vCPU / 16 GB ~16–21 €/mēn. + uzturēšana.

**Laikapstākļu ieslēgšana ar atslēgu** (kad pienāk laiks — to dara īpašnieks; kods jau gatavs):
1. open-meteo.com → API Standard → atslēga.
2. Supabase → Edge Functions → Secrets: `OPEN_METEO_KEY` (nekad lapā, JS vai repozitorijā).
3. Izvieto `supabase/functions/weather` ar **Verify JWT izslēgtu** (laikapstākļi vajadzīgi arī bez pieteikšanās).
   Tests: `deno run --allow-env --allow-read tests/weather-fn-test.ts`.
4. `services.js`: `weather: 'https://pkqusuoicxmwcgwsrdqy.supabase.co/functions/v1/weather'`, jauna `?v=` versija
   `index.html` un `index-gl.html`.
Bez atslēgas funkcija atbild 503 un uz bezmaksas API neiet (citādi visi lietotāji nāktu no vienas IP).

## Testi

GitHub tos palaiž automātiski katrai izmaiņai (cilne **Actions** → „Testi”). Lokāli:

- **Lietotnes loģika** (Node.js ≥ 22.13, Linux / macOS / Windows): `node tests/run.js`
- **Datubāze** (vajag lokālu PostgreSQL ≥ 15 un `psql`; **nekad pret Supabase**):
  `PGHOST=localhost PGUSER=postgres PGPASSWORD=… bash tests/run-sql.sh` — uzbūvē visu shēmu no `supabase/*.sql`,
  palaiž drošības scenārijus, pārbauda `supabase/status.sql` un veco failu aizsardzību.
- **Karte un lapu drošības politika** (Playwright + Chromium): `node tests/map-smoke.js . /tmp/karte` — sk. faila sākumu.

## Radaru saraksts: ziņot un balsot tikai ar kontu (B08)

- Kopīgo radaru sarakstu (`radar_list`) lasa jebkurš, arī bez konta. Ziņot par atrastu radaru (`radar_report`) un atzīmēt
  „nav radara” (`radar_bad`) var tikai ar kontu — ja tā nav, lietotne izveido anonīmo neredzami (CAPTCHA bez loga).
- Serveris skaita vienu balsi no konta katram radaram (`radar_votes`, glabā 30 dienas) un limitē: ≤ 120 ziņojumi stundā,
  ≤ 100 jauni radari diennaktī, ≤ 100 „nav radara” stundā no konta. SQL — `supabase/radars-2-votes.sql` (Nr. 33).

## Viltoti konti: CAPTCHA un nelietotu kontu dzēšana (B07)

- **CAPTCHA (Cloudflare Turnstile)** — `captcha.js`. Supabase Auth ar ieslēgtu CAPTCHA pieņem jauna konta izveidi (`/signup`)
  un e-pasta saites pieprasīšanu (`/otp`) tikai ar žetonu. Cloudflare skripts ielādējas tikai šajos brīžos. Braucot (> 10 km/h)
  vai fonā pārbaude ir tikai neredzamā — ja Cloudflare prasa darbību, lietotne logu nerāda un lūdz mēģināt, kad apstājies.
  **Ieslēgšana (secība svarīga):**
  1. dash.cloudflare.com → Turnstile → Add widget: domēns `growlab.cc`, režīms „Managed” → Site Key un Secret Key.
  2. `rides-config.js` → `captchaSiteKey: '<Site Key>'` (publiska), jauna `?v=` versija trijās lapās; izvieto.
  3. Tikai tad: Supabase → Authentication → Attack Protection → Enable CAPTCHA → Turnstile + **Secret Key**
     (Secret Key — tikai Supabase, nekad lapā vai repozitorijā).
  Ja 3. solis izdarīts pirms 2., jauni konti un e-pasta saites neizdosies.
- **Nelietoti anonīmi konti** — `supabase/account-2-anon-cleanup.sql` (Nr. 32): katru nakti dzēš anonīmus kontus, kas
  180 dienas nav pieslēgušies serverim (sk. MIGRATIONS.md). Kontus ar e-pastu / Google nedzēš.
- **IP limits** — Supabase → Authentication → Rate Limits → „anonymous sign-ins” (ieteicams ≤ 30 stundā no vienas IP).

## Privātums repozitorijā (B06)

- Repozitorijs ir publisks: failos drīkst būt tikai lietotnes atbalsta e-pasts (kā terms.html), ne personīgs (tests to pārbauda visos failos).
- Commit autoram jābūt GitHub noreply adresei: GitHub → Settings → Emails — „Keep my email addresses private” un
  „Block command line pushes that expose my email”. CI darbs „Commit autori” (`tools/check-authors.sh`) atsaka jaunus
  commit ar citu adresi. Vecā vēsture apzināti netiek pārrakstīta (īpašnieka lēmums 10.11.2026).

## Ierobežojumi

- Zīmes ir tikai tās, kas ievadītas OpenStreetMap vai atrastas Mapillary; laukos to ir mazāk.
- Bezmaksas serveri (OpenFreeMap, Overpass, OSRM, Nominatim, Photon) domāti nelielai lietošanai — pie liela lietotāju
  skaita vajadzēs savus vai maksas.
- Maksājumi pašlaik darbojas Stripe testa režīmā.
