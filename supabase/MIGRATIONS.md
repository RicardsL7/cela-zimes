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
| 27 | cleanup-1.sql | A11: vecu datu tīrīšana ik 5 min (pg_cron), uzraudzība | jā (kamēr nav jaunāku) |

**Produkcijā:** palaisti visi 1–27 (22–27 — 08.11.2026, ar īpašnieka atļauju). Jaunus failus — tikai pēc kārtas no `ORDER.txt`.

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
2. SQL Editor: visi faili no `ORDER.txt` pēc kārtas (1 → 27); beigās `status.sql` → „VISS KĀRTĪBĀ”. (`cleanup-1.sql` pats
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

## Datu rezerves kopija

- **Galvenais veids:** Supabase → Database → Backups (maksas plānos — automātiski katru dienu; atjauno Supabase pats,
  ieskaitot kontus). Bezmaksas plānā automātisku kopiju nav — tad vismaz reizi nedēļā pašam (zemāk).
- **Pašam** (savā datorā; datubāzes parole — Supabase → Project Settings → Database). Paroli un kopiju **nekad** neliec
  repozitorijā — tajā ir lietotāju personas dati; glabā šifrētā vietā.
  - tikai shēma (salīdzināšanai): `pg_dump "<connection string>" --schema-only --schema=public > shema.sql`
  - viss: `pg_dump "<connection string>" --format=custom --schema=public --schema=auth > cela-zimes.dump`
- **Atjaunošana no paša kopijas** jaunā projektā: `ORDER.txt` failus **nepalaid** — atjauno visu kopiju
  (`pg_restore --no-owner -d "<jaunā connection string>" cela-zimes.dump`): pg_restore vispirms izveido tabulas,
  tad ieliek datus un tikai pēc tam trigerus un politikas, tāpēc trigeri datus nemaina. **Neizmanto `--data-only`**
  uz jau izveidotas shēmas — tad trigeri (piem. A03 gaitas aizsardzība) mainītu atjaunotos datus.
  Pēc tam `status.sql`. Kontu (`auth`) atjaunošana ārpus Supabase rīkiem ir sarežģīta — ja vajag, labāk ar Supabase atbalstu.
