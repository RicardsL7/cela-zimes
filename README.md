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
| Android | `mobile/` — Capacitor apvalks ap growlab.cc ar fona GPS; APK būvē GitHub Actions (`android.yml`) |

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
- Servera funkcijas izvieto īpašnieks (`ride-pay`; `stripe-webhook` ar `--no-verify-jwt`). Slepenās atslēgas
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
  `?dev=1` („Tīkla pieprasījumi šajā ierīcē”) vai konsolē `czNet.stats()`;
- bezmaksas serveriem ievēro to noteikumus (rinda: Nominatim ≤ 1/s, OSRM ≤ 1/s, Overpass ≤ 2 vienlaikus) un pēc „par daudz”
  vai kļūmes ieturē pauzi (5 s → 10 s → … ≤ 5 min; Overpass pēc 429 — vismaz 30 s), pauzes laikā serveri netraucē;
- Overpass jautā vienam serverim (veselākajam), otram — tikai ja pirmais 4 s neatbild vai kļūdās (agrāk — abiem reizē);
- fona cilnē neaptaujā: ziņojumi, sastrēgumi, citi braucēji, laikapstākļi, „Kopā” (bez aktīva brauciena; braucienā vieta
  jāsūta arī fonā). Atgriežoties cilnē — dati atjaunojas uzreiz.
- Jau agrāk: kešatmiņa (OSM šūnas 3 d., meklēšana 1 d., laikapstākļi 10 min), vienādu pieprasījumu apvienošana, meklēšana
  pēc 300 ms pauzes rakstīšanā.

**Aptuvenā slodze uz vienu lietotāju, kam lietotne atvērta** (aprēķināts no koda intervāliem; īstos skaitļus rāda
`czNet.stats()` un Supabase → Reports):

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

## Testi

GitHub tos palaiž automātiski katrai izmaiņai (cilne **Actions** → „Testi”). Lokāli:

- **Lietotnes loģika** (Node.js ≥ 22.13, Linux / macOS / Windows): `node tests/run.js`
- **Datubāze** (vajag lokālu PostgreSQL ≥ 15 un `psql`; **nekad pret Supabase**):
  `PGHOST=localhost PGUSER=postgres PGPASSWORD=… bash tests/run-sql.sh` — uzbūvē visu shēmu no `supabase/*.sql`,
  palaiž drošības scenārijus, pārbauda `supabase/status.sql` un veco failu aizsardzību.
- **Karte un lapu drošības politika** (Playwright + Chromium): `node tests/map-smoke.js . /tmp/karte` — sk. faila sākumu.

## Ierobežojumi

- Zīmes ir tikai tās, kas ievadītas OpenStreetMap vai atrastas Mapillary; laukos to ir mazāk.
- Bezmaksas serveri (OpenFreeMap, Overpass, OSRM, Nominatim, Photon) domāti nelielai lietošanai — pie liela lietotāju
  skaita vajadzēs savus vai maksas.
- Maksājumi pašlaik darbojas Stripe testa režīmā.
