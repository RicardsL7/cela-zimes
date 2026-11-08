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
| Karte | MapLibre GL 6 (`index.html` / `index-gl.html` — abi vienādi), OpenFreeMap vektoru flīzes |
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
- Servera funkcijas izvieto īpašnieks (`ride-pay`; `stripe-webhook` ar `--no-verify-jwt`). Slepenās atslēgas
  (Stripe, `service_role`) — tikai Supabase Secrets, **nekad** šajā repozitorijā vai pārlūkā.

## Testi

GitHub tos palaiž automātiski katrai izmaiņai (cilne **Actions** → „Testi”). Lokāli:

- **Lietotnes loģika** (Node.js ≥ 22.13, Linux / macOS / Windows): `node tests/run.js`
- **Datubāze** (vajag lokālu PostgreSQL ≥ 15 un `psql`; **nekad pret Supabase**):
  `PGHOST=localhost PGUSER=postgres PGPASSWORD=… bash tests/run-sql.sh` — uzbūvē visu shēmu no `supabase/*.sql`,
  palaiž drošības scenārijus, pārbauda `supabase/status.sql` un veco failu aizsardzību.
- **Karte** (Playwright + Chromium): `node tests/map-smoke.js . <maplibre dist mape> /tmp/karte` — sk. faila sākumu.

## Ierobežojumi

- Zīmes ir tikai tās, kas ievadītas OpenStreetMap vai atrastas Mapillary; laukos to ir mazāk.
- Bezmaksas serveri (OpenFreeMap, Overpass, OSRM, Nominatim, Photon) domāti nelielai lietošanai — pie liela lietotāju
  skaita vajadzēs savus vai maksas.
- Maksājumi pašlaik darbojas Stripe testa režīmā.
