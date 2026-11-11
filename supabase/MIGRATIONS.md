# Datubāze: migrācijas, pārbaude, atjaunošana (audits A09)

Datubāze ir Supabase (PostgreSQL). Shēmu maina tikai SQL faili šajā mapē, ko īpašnieks palaiž
**Supabase → SQL Editor** (ielīmē visu failu → Run). Lietotne (pārlūks) shēmu mainīt nevar.

- **`ORDER.txt`** — vienīgais pareizais secības saraksts (numurs + fails). Tukšā datubāzē palaiž visus pēc kārtas.
- **`status.sql`** — tikai lasošs vaicājums: vai datubāze sakrīt ar repozitoriju. Ģenerēts (nelabo ar roku).
- **`rides-17-migrations.sql`** — tabula `cz_migrations` (kurš fails palaists un kad) un aizsardzība pret vecu failu
  atkārtotu palaišanu.
- Automātiskā pārbaude: `tests/run-sql.sh` (arī GitHub Actions „Testi”) katrai izmaiņai uzbūvē datubāzi no nulles
  pēc `ORDER.txt`, pārbauda, ka `status.sql` ir aktuāls un saka „VISS KĀRTĪBĀ”, un ka vecie faili atsakās palaisties.

## Faili

„Atkārtot” — vai failu drīkst palaist vēlreiz, kad jau palaisti jaunāki. Pārbaudīts automātiski: katru failu palaižot
atkārtoti pilnā datubāzē un salīdzinot visas funkcijas, politikas, trigerus, tiesības un kolonnas.
**Aizsargāts** — fails pats atsakās, ja `cz_migrations` rāda, ka jau palaisti jaunāki (pēc `rides-17`).

| Nr. | Fails | Ko dara | Atkārtot |
|---:|---|---|---|
| 1 | rides.sql | kopbraucieni: profili, kontakti, pieprasījumi, piedāvājumi, RLS | jā (nemaina) |
| 2 | rides-2-chat-trip.sql | čats, brauciena gaita | **nē — aizsargāts** (vecs `ride_driver_update`, atceltu A03) |
| 3 | rides-3-pay.sql | kartes maksājumi (Stripe Connect) | **nē — aizsargāts** (vecas cenu funkcijas) |
| 4 | rides-4-expire.sql | novecojušu braucienu tīrīšana | jā (nemaina) |
| 5 | rides-5-reoffer.sql | atkārtots piedāvājums | jā (nemaina) |
| 6 | rides-6-price.sql | cena | jā (nemaina) |
| 7 | rides-7-account.sql | piekrišanas, kontu apvienošana un dzēšana | **nē — aizsargāts** |
| 8 | radars.sql | kopīgie radari | **nē — aizsargāts** |
| 9 | traffic.sql | sastrēgumu karte | **nē — aizsargāts** |
| 10 | traffic-2-helpers.sql | „Šobrīd palīdz: N” | **nē — aizsargāts** |
| 11 | reports.sql | ziņojumi uz ceļa | **nē — aizsargāts** (atkārtoti arī krīt ar kļūdu) |
| 12 | rides-8-refund.sql | atmaksas | **nē — aizsargāts** |
| 13 | rides-9-ratings.sql | vērtējumi, vēsture | **nē — aizsargāts** |
| 14 | rides-10-declined.sql | noraidītie piedāvājumi | jā (nemaina) |
| 15 | stats-f16.sql | statistika | **nē — aizsargāts** |
| 16 | rides-11-paymark.sql | maksājuma statusa pieraksts | jā (nemaina) |
| 17 | rides-12-webhook.sql | Stripe notikumu uzskaite | jā (nemaina) |
| 18 | stats-2-f23.sql | statistika 2 | jā (nemaina) |
| 19 | coins-1.sql | ziņojumu apstiprinājumi, monētas, Garāža | **nē — aizsargāts** (atkārtoti krīt ar kļūdu) |
| 20 | coins-2-presence.sql | citi braucēji kartē | jā (nemaina) |
| 21 | coins-3-skins.sql | tēli | jā (nemaina) |
| 22 | rides-13-guard.sql | A01: dalībniekus nevar nomainīt | jā |
| 23 | rides-14-accept.sql | A02: pieņemšana vienā transakcijā | jā |
| 24 | rides-15-trip.sql | A03: gaita tikai uz priekšu | jā |
| 25 | rides-16-checkout.sql | A04: viena maksājuma lapa | jā |
| 26 | rides-17-migrations.sql | A09: migrāciju uzskaite | jā |
| 27 | cleanup-1.sql | A11: vecu datu tīrīšana ik 5 min (pg_cron), uzraudzība | **nē — aizsargāts** (pēc 28) |
| 28 | account-1-delete.sql | A15: konta dzēšana — pārbaudes; otram dalībniekam paliek anonīms brauciena ieraksts | **nē — aizsargāts** (pēc 29) |
| 29 | presence-2-privacy.sql | A16: citu braucēju punkti — atsevišķa izvēle, ~150 m, redz tikai braucot ≤ 15 km | **nē — aizsargāts** (pēc 30) |
| 30 | rides-18-open-privacy.sql | B02: atvērtie braucieni šoferiem aptuveni (~1 km, bez vārda/adreses/piezīmes) | **nē — aizsargāts** (pēc 31) |
| 31 | rides-19-cost-share.sql | B03: kopbrauciena maksa ≤ ceļa izmaksas (attālums × 1,3 × 12 c/km, ≥ 2 €) | **nē — aizsargāts** (pēc 32) |
| 32 | account-2-anon-cleanup.sql | B07: anonīmi konti, kas 180 d. nav pieslēgušies, tiek dzēsti katru nakti | **nē — aizsargāts** (pēc 33) |
| 33 | radars-2-votes.sql | B08: radaru ziņojumi un „nav radara” tikai ar kontu, viena balss no konta, limiti; balsis 30 d. | **nē — aizsargāts** (pēc 34) |
| 34 | rides-20-profiles-privacy.sql | B09: profilu (vārds, auto) redz tikai brauciena otra puse, ne visi lietotāji | **nē — aizsargāts** (pēc 35) |
| 35 | rides-21-driver-accounts.sql | B10: šofera Stripe kontu piesaista tikai ride-pay (service_role); klients neraksta | **nē — aizsargāts** (pēc 36) |
| 36 | client-errors.sql | B12: lietotnes kļūdu pieraksts (client_error), saraksts admin.html, 30 d. | jā (kamēr nav jaunāku) |

**Produkcijā:** palaisti visi 1–36 (22–31 — 08.11.2026, 32–35 — 10.11.2026, 36 — 11.11.2026, ar īpašnieka atļauju; pēc tam `status.sql` — VISS KĀRTĪBĀ). Jaunus failus — tikai pēc kārtas no `ORDER.txt`.
Faili ar `cz_migration_begin` (27–…) atkārtoti palaižami tikai, kamēr nav palaists jaunāks (tad tie paši atsakās).

## Lietotnes kļūdu pieraksts (B12)

- `client-errors.sql` (Nr. 36): tabula `client_errors` (viena rinda dienā katrai atšķirīgai kļūdai + skaitītājs `n`), bez
  lietotāja ID, IP un vietas. `client_error(p)` — `anon` un `authenticated` (lietotne `errlog.js`); teksts attīrīts arī serverī
  (`cz_scrub`: e-pasti, JWT, atslēgas/ID, URL parametri, koordinātas, garas ciparu virknes); ≤ 300 jaunas kļūdas dienā.
- `admin_client_errors(dienas)` — tikai `is_app_admin()` (admin.html → „Kļūdas”). Glabā 30 dienas (pg_cron „cz-client-errors” 02:51 UTC).

## Šofera Stripe konta piesaiste (B10)

- `rides-21-driver-accounts.sql` (Nr. 35): politika „driver_accounts insert own” dzēsta, `anon`/`authenticated` nav INSERT
  un UPDATE. Ierakstu veido `driver_account_link(user, acct)` — izpildīt var tikai `service_role` (ride-pay ar iebūvēto
  servisa atslēgu), tikai pēc tam, kad Stripe izveidojis kontu ar metadatiem `cz_user` = lietotājs. Viens Stripe konts —
  vienam lietotājam. Lasīt un dzēst savu ierakstu — kā līdz šim.
- ride-pay (B10 versija) strādā arī pirms šī faila (ja funkcijas nav — vecais ceļš). Ieteicamā secība: izvietot ride-pay,
  tad palaist Nr. 35. Vecā ride-pay pēc Nr. 35 jaunu šofera kontu saglabāt nevarētu.

## Kopbraucienu profilu redzamība (B09)

- `rides-20-profiles-privacy.sql` (Nr. 34): politika `profiles_read` = `profile_visible(id)` (agrāk `true` — jebkurš konts
  varēja izlistēt visus vārdus un auto). Redz: savu profilu; pasažieris — šoferus, kas piedāvāja braucienu viņa
  pieprasījumam; šoferis — pasažieri, kurš pieņēma viņa piedāvājumu (`was_accepted`, arī pēc atcelšanas).
- Indeksi `ride_offers (driver_id)`, `ride_requests (user_id)` — politiku pārbauda katrai rindai.
- Servera funkcijas (vēsture, administrators, kontu apvienošana) ir security definer — tās neietekmē. Lietotne nav jāmaina.
- Pārbaude: `select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'profiles_read';` → `profile_visible(id)`.

## Radaru ziņojumi un balsis (B08)

- `radars-2-votes.sql` (Nr. 33): `radar_report` un `radar_bad` — tikai `authenticated` (anon tiesības atņemtas);
  `radar_list` — kā līdz šim arī bez konta. Tabula `radar_votes` (mly_id, user_id, g/b) — viena balss no konta katram
  radaram; glabā 30 dienas (pg_cron „cz-radar-votes” 02:37 UTC), kontu dzēšot — uzreiz (on delete cascade).
- Limiti no konta: ≤ 120 ziņojumi stundā (citādi pieprasījums atgriež 0), ≤ 100 jauni radari diennaktī, ≤ 100 „nav radara”
  stundā; kopējie griesti 50 000 radaru paliek.
- Lietotne (app-gl.js v165) konta nav — izveido anonīmo neredzami (CAPTCHA bez loga); vecas lietotnes versijas bez
  konta saņem 401/403 un vienkārši neziņo (radaru saraksts strādā).

## Nelietoti anonīmi konti un CAPTCHA (B07)

- `account-2-anon-cleanup.sql` (Nr. 32): `cz_anon_cleanup()` katru nakti 02:23 UTC (pg_cron „cz-anon-cleanup”) dzēš anonīmus
  kontus bez e-pasta, kas 180 dienas nav pieslēgušies (jaunākais no izveides, pieslēgšanās un `auth.sessions` atjaunošanas).
  Nedzēš, ja ir aktīvs brauciens / nepabeigts maksājums / šofera Stripe konts. Dzēšana — `account_erase()` (tā pati, ko
  izmanto `delete_my_account`). Palaišanas — `cz_cleanup_runs` (admin.html).
- Pirms palaišanas var paskatīties, cik kontu tiktu dzēsti — vaicājums faila beigās (neko nedzēš).
- CAPTCHA (Cloudflare Turnstile) — nav SQL: `rides-config.js` → `captchaSiteKey`, tad Supabase → Authentication →
  Attack Protection → CAPTCHA. Secība svarīga: vispirms lietotne, tad Supabase (citādi jauni konti neizdodas).

## Kopbrauciena maksa — ceļa izdevumu daļa (B03)

- `rides-19-cost-share.sql` (Nr. 31): `ride_fare_cap_cents` = attālums taisnā līnijā × 1,3 × 12 c/km, vismaz 2 €
  (funkcija `ride_cost_cap`; agrāk — 300 € jebkuram braucienam). Trigeris `ride_offer_price_check` atsaka lielāku cenu.
- `ride_requests_open` / `ride_requests_coarse` atdod arī `cap_cents` (precīzs maksimums, lai gan vieta noapaļota).
- Jau nosūtītie piedāvājumi netiek mainīti. Pārbaude: `select ride_cost_cap(56.9496, 24.1052, 56.5047, 21.0108);` → 3044.
- Kāpēc: maksa par pārvadājumu „profesionālas darbības veidā” ir komercpārvadājums (Autopārvadājumu likums, 1. p. 26. p.)
  ar licencēm un ATD/VID prasībām (MK Nr. 541). Galīgo vērtējumu sniedz jurists — sk. dokumentu
  „Maksājumu juridiskā sagatavošana”. Pirms `PAY_LIVE` — tā kontrolsaraksts.

## Atvērtie braucieni (B02)

- `rides-18-open-privacy.sql`: tabulu `ride_requests` redz tikai pasažieris un šoferis, kura piedāvājums pieņemts
  (`ride_request_exact` — `was_accepted`). Šoferu sarakstam — `ride_requests_open(laukums)` un `ride_requests_coarse(id)`:
  ~1 km (1/100°, 1/60°), apdzīvotā vieta (`ride_area`), laiks, vietas, statuss, pasažiera vērtējums; bez vārda,
  adreses, piezīmes un konta ID; tikai `authenticated`.

## Citi braucēji kartē (A16)

- `presence-2-privacy.sql`: rāda tikai ar piekrišanu `user_consents.kind = 'show_on_map'` (versija ≥ 2026-11-08; slēdzis
  „Rādīt mani citu kartē”, noklusēti izslēgts) — ātruma dalīšana to vairs neieslēdz. Vieta ~150 m, punkts pēc ≥ 60 s
  braukšanas, atjaunošana ≥ 25 s, apstājoties dzēsts.
- `presence_nearby(p_lat, p_lng, p_speed_kmh)` — tikai `authenticated`, tikai braucot (≥ 15 km/h), ≤ 15 km ap sevi,
  ≥ 12 s starp pieprasījumiem; pirmās 60 s / 200 m — tukšs; lēciens > 250 km/h — no jauna. Skatītāja vieta (~50 m) —
  `presence_viewers`, dzēsta apstājoties vai pēc 10 min (`cz_cleanup`). Vecā `presence_nearby(laukums)` dzēsta.

## Konta dzēšana (A15)

- `account_delete_check()` — vai pieteikušos lietotāju drīkst dzēst; `delete_my_account()` bez tās nedzēš (kļūda `account_busy`):
  aktīvs brauciens; maksājuma lapa atvērta < 24 h; samaksāts brauciens atcelts pirms iekāpšanas, bet atmaksa nav pabeigta.
  `ride-pay` darbība `close` (šofera Stripe konta slēgšana) to pārbauda pirms slēgšanas.
- Profila dzēšana jebkurā veidā (arī Supabase panelī) — trigeris `profiles_erase_rides`: braucieni bez vēstures dzēsti,
  ar vēsturi — otram paliek bez dzēstā ID, adreses, piezīmes, precīzām koordinātām (~1 km) un pēdējām atrašanās vietām;
  dzēstā čata ziņas un vērtējumi par viņu — dzēsti. Ja abi dalībnieki dzēsuši kontu — brauciens dzēsts pilnībā.
  Ārējās atslēgas `ride_requests.user_id`, `ride_offers.driver_id`, `ride_ratings.rater_id` — `ON DELETE SET NULL`
  (`status.sql` pārbauda arī ārējo atslēgu darbību).

## Kā palaist migrāciju produkcijā

1. Palaid `status.sql` — redzi, kas trūkst. (Pirms `rides-17` būs rindas „migrācija … nav atzīmēts” — tas ir normāli.)
2. Palaid trūkstošos failus **pēc kārtas no `ORDER.txt`**, katru atsevišķi (New query → ielīmē visu → Run).
   Ja kāds atgriež kļūdu — apstājies; nākamo nepalaid.
3. Katra faila beigās ir „PĀRBAUDE PĒC PALAIŠANAS” — palaid to.
4. Beigās vēlreiz `status.sql` → jābūt vienai rindai **VISS KĀRTĪBĀ**.

Nekad nepalaid vecu failu „lai salabotu” — tas atgriezīs vecākas funkciju versijas. Ja `status.sql` rāda „cita versija”,
palaid **visus failus no tā, kas definē šo funkciju jaunāko versiju, līdz beigām** (vai pajautā).

## Kā uzrakstīt jaunu migrāciju

1. Jauns fails `supabase/<nosaukums>.sql`; `ORDER.txt` beigās jauna rinda ar nākamo numuru.
2. Faila sākumā `select public.cz_migration_begin(<nr>, '<fails>.sql');`, beigās `select public.cz_migration_done(<nr>, '<fails>.sql');`.
3. Rakstīt tā, lai to var palaist atkārtoti (`create … if not exists`, `create or replace`, `drop … if exists`).
4. Pievienot failu `tests/run-sql.sh` sarakstam `STEPS` (un testu, ja maina drošību). `tests/run.js` pārbauda, ka nekas nav aizmirsts.
5. Atjaunot `status.sql`: uzbūvē lokālu datubāzi pēc `ORDER.txt` un palaid
   `PGDATABASE=<datubāze> bash tests/gen-status.sh > supabase/status.sql` (vai skaties CI kļūdas tekstu).

## Jauns Supabase projekts (atjaunošana no nulles)

1. Supabase → New project (reģions ES).
2. SQL Editor: visi faili no `ORDER.txt` pēc kārtas (1 → pēdējais); beigās `status.sql` → „VISS KĀRTĪBĀ”. (`cleanup-1.sql` pats
   ieslēdz plānotāju pg_cron; ja Supabase to neļauj — Integrations → Cron → ieslēgt, un palaist failu vēlreiz.)
3. Authentication: kā aprakstīts `AUTH-IESTATIJUMI.md` (Site URL, Redirect URLs, anonīmie konti, Google, SMTP).
4. Servera funkcijas (Edge Functions): `ride-pay` un `stripe-webhook` (pēdējo — ar `--no-verify-jwt`).
   Secrets (vērtības ievada tikai īpašnieks; nekad repozitorijā): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `PAY_FEE_PERCENT`, `PAY_LIVE`. `SUPABASE_URL` un `SUPABASE_SERVICE_ROLE_KEY` Supabase iedod pats.
5. Stripe: webhook uz `https://<projekts>.supabase.co/functions/v1/stripe-webhook` (notikumi — `stripe-webhook/index.ts` sākumā).
6. `rides-config.js`: jaunā projekta URL un **publishable** (anon) atslēga. Nekad `service_role`.
7. Īpašnieka tiesības statistikai — `stats-f16.sql` sākumā (ar savu e-pastu, SQL redaktorā; repozitorijā neraksta).

## Vecu datu tīrīšana un uzraudzība (A11)

- `cleanup-1.sql`: funkcija `cz_cleanup()` ik 5 minūtes (pg_cron darbs `cz-cleanup`) dzēš datus, kuru glabāšanas laiks
  beidzies (tieši kā `privacy.html` 9. punktā): ziņojumi (ar atzīmēm) — derīguma beigas + 2 dienas, ātruma mērījumi —
  28 dienas, mērījumu skaitītāji — 1 diena, vieta citu kartē — pēc 5 min bez atjaunošanas (tātad ≤ 10 min), konta pārneses
  kodi — pēc derīguma, Stripe notikumu ID — 90 dienas; arī novecojušos braucienus (`ride_expire`) un plānotāja vēsturi (7 dienas).
  Katrs solis atsevišķi — viena kļūda neaptur pārējos.
- Katra palaišana — `cz_cleanup_runs` (7 dienas). Pēdējās: `select started_at, ok, deleted, errors from cz_cleanup_runs order by id desc limit 10;`
- **Brīdinājumi:** `admin.html` augšā sarkans paziņojums, ja tīrīšana nav ieplānota vai pēdējā veiksmīgā > 20 min;
  GitHub Actions „Uzraudzība” reizi stundā izsauc `cz_health()` un, ja tīrīšana nestrādā, darbs neizdodas → GitHub e-pasts.
  `status.sql` rāda „plānotājs … nav ieplānots”, ja darbs pazudis.
- GitHub ieplānotos darbus aptur pēc 60 dienām bez izmaiņām repozitorijā — tad Actions → „Uzraudzība” → Enable workflow.

## Datu rezerves kopija un atjaunošana (B13)

- **Kopijas taisa privāts repozitorijs `RicardsL7/cela-zimes-backup`** (īpašnieka lēmums 11.11.2026 — bez maksas, Supabase
  bezmaksas plānā kopiju nav). Katru nakti 03:17: `pg_dump` (public + auth) → pārbaude (≥ 30 tabulas, auth.users, izmērs) →
  šifrēšana AES-256 → Actions artefakts **14 dienas**. Ja neizdodas — GitHub e-pasts. Pirms kopijas pārbauda, ka repozitorijs
  ir privāts. Pēdējā kopija — tā `LAST.md`.
- Secrets (tikai tur): `SUPABASE_DB_URL` (Supabase → Connect → Direct → **Session pooler** → URI ar paroli),
  `BACKUP_PASSPHRASE` (frāze, īpašniekam pierakstīta). **Mainot datubāzes paroli — atjauno `SUPABASE_DB_URL`.**
- Kopiju **nekad** neglabā šajā publiskajā repozitorijā (arī Actions artefakti šeit ir publiski) — `tests/run.js` to pārbauda.
- Kopijā nav: pg_cron darbu (`tools/restore-cron.sql`), Edge Functions koda un Secrets, Authentication iestatījumu.
- **Kad atjaunot:** dati izdzēsti vai sabojāti. Ja problēma ir tikai kodā — atjauno kodu (git), ne datubāzi.
- **Atjaunošana** (vispirms **jaunā** Supabase projektā, ne virs dzīvās datubāzes):
  1. `cela-zimes-backup` → Actions → „Rezerves kopija” → vajadzīgā diena → Artifacts → lejupielādē zip un atver.
  2. Atšifrē: `gpg -d cela-zimes-GGGG-MM-DD.tar.gz.gpg | tar -xzf -` (prasa frāzi) → `cela-zimes.dump`, `counts.txt`.
  3. `pg_restore --no-owner --no-privileges --clean --if-exists -d "<jaunā projekta Session pooler URI>" cela-zimes.dump`
     (kļūdas par Supabase jau izveidotiem `auth` objektiem var ignorēt). pg_restore trigerus izveido pēc datiem, tāpēc tie
     datus nemaina. **Neizmanto `--data-only`** — tad trigeri (piem. A03 gaitas aizsardzība) mainītu atjaunotos datus.
  4. SQL Editor: `tools/restore-cron.sql` → `supabase/status.sql` („VISS KĀRTĪBĀ”; ja „trūkst / cita versija” — kopija vecāka
     par migrāciju: palaid trūkstošos `ORDER.txt` failus); `tools/backup-counts.sql` salīdzini ar `counts.txt`.
  5. Jaunajam projektam — sadaļa „Jauns Supabase projekts” 3.–7. solis (Auth iestatījumi, funkcijas, Secrets, Stripe webhook,
     `rides-config.js` ar jaunā projekta URL un publishable atslēgu, Turnstile Secret Key CAPTCHA iestatījumos).
  6. Lietotnē pārbaude (pieteikšanās, „Kopā”, admin.html bez sarkaniem brīdinājumiem); Stripe Dashboard ir patiesība par maksājumiem.
- **Pārbaudīts lokāli:** `tests/run-sql.sh` katrā CI palaišanā — kopija (pg_dump) → jauna datubāze → `status.sql` VISS KĀRTĪBĀ,
  rindu skaits sakrīt; izdzēsti pg_cron darbi → `tools/restore-cron.sql` → atkal VISS KĀRTĪBĀ.
- Ja nākotnē Supabase Pro — tam ir arī savas ikdienas kopijas (Database → Backups → Restore); šī kopija paliek kā otrā.
