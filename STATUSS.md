# Ceļa Zīmes — statuss

## v131 — iestatījumu panelis (2026-11-03)

**Kas mainīts** (tikai struktūra, izskats un piekļuve; funkcionalitāte un saglabātās vērtības `cz.*` tās pašas):
- Panelis „Iestatījumi” ir bottom sheet ar vilkšanas rokturi; aizveras ar „Gatavs”, Esc vai velkot uz leju (> 90 px).
- Grupas pēc svarīguma: **Braukšana** (brīdinājumi, ātruma brīdinājums, zīmju saraksts — paslēpts brīdinājumu režīmā kā līdz šim) → **Sastrēgumi** (rādīt; „Dalīties ar ātrumu anonīmi” ar īsu rindu + „Vairāk” ar pilno tekstu; „Šobrīd palīdz”) → **Izskats** (kartes stils un marķieru animācija — segmentu pogas, bultas krāsas 42 px ar ķeksīti) → **Konts un privātums** (Konts un dati, Lietošanas noteikumi, Privātuma politika — pilna platuma rindas ar ›) → **Par lietotni** (Datu avoti atverami) → **Izstrādātājam** (`#devBox`, nemainīts, pašā apakšā).
- Rindas ≥ 56 px, visa rinda ir pieskāriena laukums; slēdži 52 × 32; segmentu pogas ≥ 44 px, aktīvā — akcenta fons ar baltu tekstu (tumšajā tēmā tumšāks zils, kontrasts 4,8:1).
- Ikonas — inline SVG ar `currentColor`.
- **Piekļuve ar 1 pieskārienu:** `#settingsBtn` pārcelts no ⋯ izvēlnes uz meklēšanas joslu (zobrata/slīdņu ikona labajā malā). Labās puses FAB pogu skaits nemainās; ⋯ izvēlnē paliek „Zīmes” (`#toggleSigns`) ar sarkano punktu, kā līdz šim.
- Versijas: `style-gl.css?v=131`, `app-gl.js?v=131` abos index failos.

**Pārbaude:** `node tests/run.js` — 131/131. Iestatījumu panelis pārbaudīts 320, 375 un 430 px platumā, gaišajā un tumšajā tēmā, ar un bez izstrādātāja bloka: nekas neiziet ārpus ekrāna, visas rindas ≥ 56 px. Kontrasts (WCAG AA): teksts 14,5 / 15,4; paskaidrojumi 5,0 / 6,9; aktīvā segmenta poga 6,5 / 4,8.

## v132 — noņemta ⋯ poga

- Kartes labajā pusē vairs nav ⋯ un „Zīmes / Brīdin.” pogas — tā dublēja slēdzi „Rādīt brīdinājumus kartē” iestatījumos (Braukšana).
- Sarkanais punkts (brīdinājumi izslēgti) tagad ir uz iestatījumu pogas meklēšanas joslā.
- Saglabātā vērtība cz.signsOn nemainās.
- Versijas: style-gl.css v132, app-gl.js v132. Testi: 131/131.

## v133 — vietu kontakti pēc kategorijām, poga „Zvanīt 112”

- Īpašnieka lēmums (03.11.2026), places.js `PLACE_CONTACT_RULES`:
  - nekā: degviela, kafija, pārtikas veikali, iepirkšanās, parki;
  - tikai saite: stāvvieta;
  - tālrunis + saite: elektroauto uzlāde, ēdiens, auto mazgātavas, aptiekas, medicīniskā palīdzība, viesnīcas;
  - tikai tālrunis: ārkārtas palīdzība.
- Lietotņu (App Store / Google Play) pogas vairs nerāda nevienā kategorijā. Meklēšanas rezultātiem (bez kategorijas) — tālrunis un saite.
- „Ārkārtas palīdzība” sarakstā augšā liela sarkana poga „Zvanīt 112” (tel:112).
- Versijas: places.js v133, style-gl.css v133, app-gl.js v133. Testi: 131/131.

## v134 — nobrauktā maršruta daļa kļūst blāva (kā Waze)

- Nobrauktā daļa aiz bultas vairs nav spilgta: to zīmē kā blāvu, caurspīdīgu līniju (`route-done-line`, necaurredzamība 0,22) zem galvenā maršruta, tā saplūst ar ceļu.
- Griezums seko bultai arī tad, kad GPS ir vājš vai bulta nav piesaistīta maršrutam (līdz 70 m no tā) — spilgtā līnija vairs neizlien aiz bultas.
- nav.js: `routeDone(route, along)`.
- Versijas: nav.js v134, app-gl.js v134. Testi: 132/132.

## v138 — radari ir acs

- Radaru (stacionāro un mobilo) marķieris tagad ir acs: tumšajā kartē sarkana varavīksnene, gaišajā — zila. Tumšajā kartei acij ir gaiša apmale, lai neizplūst.
- Kustīgie riņķi ap marķieri (pulse slāņi) nemainīti — acs centrs tajā pašā vietā (32; 24,5), smaile (32, 61).
- alerts.js `radarEyeSvg`; versija alerts.js v138. Testi: 132/132.

## v139 — ceļa remontdarbi: strādnieks

- „Ceļa remontdarbi” marķieris kartē tagad ir strādnieks ar oranžu ķiveri un saulesbrillēm apaļajā spraudē (īpašnieka izvēle 03.11.2026). Spraudas galva un smaile tajā pašā vietā kā citiem brīdinājumiem.
- alerts.js `roadWorkerPin`; versija alerts.js v139. Testi: 132/132.

## v140 — remontdarbu spraude: lielāks aplis, mazāka adata

- Aplis r 21 → 23 (centrs 32;28), adata īsāka un šaurāka; smaile tajā pašā vietā (32, 61). alerts.js v140. Testi: 132/132.

## v141 — luksofori uz pusi mazāki (šoreiz arī brīdinājumu režīmā)

- Iemesls, kāpēc v135–v137 neko nemainīja: brīdinājumu režīmā visām zīmēm ir `pin`, un izmēra izteiksmē `['has', 'pin']` tika pārbaudīts pirms luksofora. Tagad luksofora pārbaude ir pirmā.
- `TRAFFIC_LIGHT_SCALE = 0.5` (signs-gl.js `signsIconSize`, app-gl.js `alertIconSize`). Citas zīmes un spraudas nemainītas.
- Versijas: signs-gl.js v141, app-gl.js v141. Testi: 132/132.

## v142 — punkti ↔ ikonas: agrāk un 2× ātrāk

- Attālinot ikonas pārvēršas punktos jau pie tuvinājuma 14,3 (bija 12,6), tuvinot atpakaļ — 14,7 (bija 13). Tas ir apmēram uz pusi mazāk attālināšanas no parastā braukšanas tuvinājuma.
- Pārejas animācija 2× ātrāka: „Uzlēciens” 170 ms (bija 340), „Pārveidošanās” 280 ms (bija 560).
- Radaru punkti/marķieri pāriet tajā pašā attālumā (RADAR_ICON_FROM/FULL +1,7).
- Versija: app-gl.js v142. Testi: 132/132.

## v143 — punkti vēl agrāk un mazāki

- Ikonas → punkti attālinot pie 15,2 (v142: 14,3), atpakaļ ikonās pie 15,6. Zemāk par ātras braukšanas kameras tuvinājumu (15,8), tāpēc braucot ikonas paliek redzamas.
- Brīdinājumu punkti ~1/3 mazāki (`dotRadius`); radaru punktiem savs slānis — izmērs nemainīts. Radari pāriet pie 14,6–15,6.
- Versija: app-gl.js v143. Testi: 132/132.

## v144 — dzelzceļa pārbrauktuve: Andreja krusts

- Pārbrauktuves marķieris tagad ir sarkanbaltais Andreja krusts (īpašnieka izvēle 04.11.2026), bez spraudas — kā luksofors, novietots tieši uz vietas (enkurs centrā) gan zīmju, gan brīdinājumu slānī.
- alerts.js `railCrossSvg`, `ALERT_STANDALONE` (+ 'rail'); signs-gl.js un app-gl.js — enkurs centrā luksoforam un pārbrauktuvei.
- Versijas: alerts.js v144, signs-gl.js v144, app-gl.js v144. Testi: 132/132.

## v145 — satiksmes ierobežojumi vairs nerādās kartē

- Brīdinājumu režīmā zīmes ar tipu „Satiksmes ierobežojums” (laika ierobežojumi, piem. „P–Pk 7–10, 16–20”) kartē vairs nezīmē — ne ikonas, ne punktus (īpašnieka lēmums 05.11.2026).
- Dati paliek: kartīte „Pēc N m …” braucot tos joprojām rāda ar attālumu un aprakstu.
- signs-gl.js `hideOnMap`; app-gl.js `signs.hideOnMap`. Versijas: signs-gl.js v145, app-gl.js v145. Testi: 132/132.

## v146 — Android izmēģinājuma lietotne (GPS arī ar izslēgtu ekrānu)

- `mobile/` — Capacitor 7 apvalks ap https://growlab.cc (appId `cc.growlab.celazimes`), spraudnis `@capacitor-community/background-geolocation` (priekšplāna serviss ar paziņojumu, `useLegacyBridge`, lai fonā neapstājas pēc 5 min).
- app-gl.js: `nativeGeo()` / `startNativeGps()` — Android lietotnē vieta nāk no telefona (darbojas arī ar izslēgtu ekrānu); pārlūkā viss kā līdz šim.
- `.github/workflows/android.yml` — GitHub pats uzbūvē APK pēc katras izmaiņas `mobile/` un ieliek to izlaidumā `android-test`:
  https://github.com/RicardsL7/cela-zimes/releases/download/android-test/cela-zimes.apk
- Nav pārbaudīts telefonā. Zināmi ierobežojumi: pieteikšanās ar Google lietotnē var nestrādāt (Google aizliedz iebūvētos pārlūkus), e-pasta saite atveras pārlūkā; ikona — Capacitor noklusējuma.
- Versija: app-gl.js v146. Testi: 132/132.

## A01 — tālruņa noplūde kopbraucienos (audits 07.11.2026)

- Kļūda: pasažieris ar tiešu REST pieprasījumu varēja piedāvājumā nomainīt šoferi uz jebkuru lietotāju, atzīmēt to kā pieņemtu un redzēt šī cilvēka tālruni.
- Labojums `supabase/rides-13-guard.sql` (divi slāņi):
  - trigeris `ride_guard_participants`: klients nevar mainīt `ride_offers.driver_id/request_id/id` un `ride_requests.user_id/id`; servera funkcijas (kontu apvienošana u.c.) var;
  - kolonnu tiesības: `authenticated` drīkst UPDATE tikai `status` abās tabulās, `anon` — neko (aizliedz arī pasažierim tieši mainīt `trip`, daļa no A03).
- Lietotnes kods nemainās (tā jau sūta tikai `{status}`).
- Pārbaude: `tests/rides-guard-test.sql` lokālā PostgreSQL ar pilnu shēmu — pirms labojuma uzbrukums izdodas (FAIL), pēc labojuma 30/30 PASS (uzbrukumi noraidīti; pieņemšana, tālrunis saskaņotam pārim, šofera/pasažiera RPC, atcelšana un kontu apvienošana strādā). JS: 133/133.
- Produkcijā: jāpalaiž `rides-13-guard.sql` Supabase SQL redaktorā (ar īpašnieka atļauju), pēc tam faila beigās esošais pārbaudes vaicājums.

## A02 — viens šoferis vienam pieprasījumam (audits 07.11.2026)

- Kļūda: pieņemšana bija trīs atsevišķi pieprasījumi no pārlūka (pieņemt → „matched” → noraidīt pārējos). Divās cilnēs vai pēc tīkla kļūmes vienam pieprasījumam varēja būt divi pieņemti šoferi (lokāli pierādīts: 2) vai pieņemts piedāvājums ar atvērtu pieprasījumu.
- Labojums `supabase/rides-14-accept.sql` (palaist PĒC rides-13-guard.sql):
  - `ride_offer_accept(oid)` — viss vienā transakcijā, pieprasījums bloķēts (`for update`); otrs vienlaicīgs mēģinājums saņem `request_not_open`; atkārtots klikšķis uz to pašu piedāvājumu ir drošs (`already: true`);
  - unikāls indekss `ride_offers_one_accepted` — ne vairāk kā viens pieņemts piedāvājums uz pieprasījumu (ja datubāzē jau ir pārkāpumi, indekss netiek veidots un tiek parādīts saraksts);
  - trigeris `ride_guard_status`: klients tieši drīkst tikai piedāvājumam pending→declined, pending/accepted/declined→cancelled; pieprasījumam open/matched→cancelled. Pieņemt / „matched” / atvērt no jauna — tikai servera funkcijas.
- Lietotne: rides.js izsauc `ride_offer_accept`; ja funkcijas serverī vēl nav (404 PGRST202), izmanto veco ceļu — tāpēc lietotne strādā gan pirms, gan pēc SQL palaišanas. Pogas „Pieņemt/Noraidīt” uz laiku atslēdzas, kļūda parādās saprotamā tekstā (`rideErrorText`); arī „Atcelt” kļūda vairs neiestrēgst.
- Pārbaude lokālā PostgreSQL: `tests/rides-accept-test.sql` 32/32, `tests/rides-accept-parallel.sh` (divas sesijas vienlaikus) 6/6, `tests/rides-guard-test.sql` (A01) 30/30 ar abiem labojumiem. JS: 136/136.
- Versija: rides.js v147, rides-ui.js v147.
- Produkcijā: jāpalaiž `rides-14-accept.sql` (pēc `rides-13-guard.sql`) ar īpašnieka atļauju, pēc tam faila beigās esošais pārbaudes vaicājums.

## A03 — brauciena gaita tikai uz priekšu (audits 07.11.2026)

- Kļūda (lokāli pierādīta): šoferis pabeigtu braucienu varēja pārtīt atpakaļ (done → arrived), jaunu piedāvājumu izveidot uzreiz ar trip='onboard', un iesākta brauciena vidū atcelt to (pieprasījums atvērās no jauna, pasažierim esot mašīnā). Automātiskā atmaksa paļaujas uz to, vai pasažieris bija iekāpis — tātad to varēja apiet.
- Labojums `supabase/rides-15-trip.sql` (palaist PĒC rides-13 un rides-14):
  - `onboard_at` / `done_at` — iekāpšanas un pabeigšanas laiku uzliek datubāze vienu reizi; pēc tam to nevar mainīt neviens (arī servera funkcijas); esošajiem braucieniem aizpilda;
  - trigeris `ride_guard_trip`: gaita tikai uz priekšu un tikai saskaņotam piedāvājumam, „Pabeigts” tikai pēc „Pasažieris iekāpa”; jauns piedāvājums vienmēr sākas ar tukšu gaitu; pēc iekāpšanas lietotne braucienu atcelt nevar (ne šoferis, ne pasažieris — trigeris `ride_requests_guard_started`);
  - `ride_driver_update`: gaitu maina tikai, kamēr pieprasījums saskaņots; pieprasījumu 'done' liek tikai tiešām pabeigtam;
  - `ride_refund_candidates`: „atcelts pirms iekāpšanas” = `onboard_at` nav uzlikts;
  - īpašniekam ar roku labot: `set local cz.trip_repair = 'on'` (lietotnes lietotājiem nedarbojas).
- Lietotne: tas pats noteikums demo krātuvē (`rideTripCheck`); saprotami kļūdu teksti; pasažiera „Jā, atcelt” kļūda neiestrēgst. Servera funkcija ride-pay nav jāmaina (tā skatās trip, kas vairs neiet atpakaļ).
- Pārbaude lokālā PostgreSQL: `tests/rides-trip-test.sql` 39/39; A02 32/32, paralēlais 6/6, A01 30/30 ar visiem trim labojumiem. JS: 138/138.
- Versija: rides.js v148, rides-ui.js v148 (arī admin.html).
- Produkcijā: jāpalaiž `rides-15-trip.sql` (pēc `rides-13-guard.sql` un `rides-14-accept.sql`) ar īpašnieka atļauju, pēc tam faila beigās esošais pārbaudes vaicājums.

## A04 — viena maksājuma lapa braucienam (audits 07.11.2026)

- Kļūda: divi vienlaicīgi „Maksāt ar karti” pieprasījumi (divas cilnes, atkārtots pieprasījums pēc tīkla kļūmes) izveidoja divas Stripe maksājuma sesijas vienam braucienam; datubāzē palika pēdējā, bet apmaksāt varēja abas. Imitācijā pierādīts: 2 sesijas.
- Labojums:
  - `supabase/rides-16-checkout.sql`: `ride_payments.attempt` (mēģinājuma numurs, klients to mainīt nevar), `ride_checkout_begin` un `ride_checkout_save` (rindas bloķēšana; vecāks mēģinājums nepārraksta jaunāku; samaksātu nepārraksta);
  - `supabase/functions/ride-pay/index.ts` (bloks `<checkout-flow>`): jaunu sesiju veido ar Stripe Idempotency-Key `cz-checkout-<brauciens>-<numurs>` — vienlaicīgi pieprasījumi saņem vienu sesiju; atvērtu sesiju atdod atkārtoti; jaunu veido tikai, ja vecā beigusies (citas summas gadījumā veco aizver); ja Stripe par veco sesiju neatbild — jaunu neveido. Stripe kļūdām saglabāts statuss un tips.
  - Lietotne (pārlūks) nemainās — poga jau bija atslēgta klikšķa laikā, atgriešanās adrese vienāda.
- Pārbaude: `tests/rides-checkout-test.sql` 17/17 (lokālā PostgreSQL); JS 147/147, t. sk. 2 un 10 vienlaicīgi pieprasījumi pret Stripe imitāciju → 1 sesija; TypeScript stingrā pārbaude bez kļūdām. Īstā Stripe testa vidē nav pārbaudīts.
- Produkcijā (ar īpašnieka atļauju, šādā secībā): 1) `rides-16-checkout.sql` SQL redaktorā; 2) izvietot servera funkciju `ride-pay` (viens fails index.ts). Vecā ride-pay ar jauno SQL strādā; jaunā ride-pay bez SQL maksājuma lapu neatvērs.

## A05 — daļēja vai gaidoša atmaksa vairs nav „atmaksāts” (audits 07.11.2026)

- Kļūda: abas servera funkcijas atmaksu vērtēja dažādi, un jebkura atmaksa (arī daļēja vai vēl apstrādē esoša) skaitījās pilna: ride-pay 'status' to pierakstīja datubāzē kā „refunded”, „Atmaksāt” pēc daļējas atmaksas atteica („jau atmaksāts”) — pasažieris atlikumu nesaņemtu; gaidoša atmaksa, kas vēlāk neizdodas, palika „atmaksāta”.
- Labojums — viena funkcija `refundState` (bloks `<refund-state>`, burtiski vienāds `ride-pay/index.ts` un `stripe-webhook/index.ts`; tests to pārbauda):
  - skaita atsevišķi: atdots (tikai succeeded), apstrādē (pending / requires_action), neizdevušās; atlikums; stāvoklis none / partial / pending / full;
  - datubāzē „refunded” — tikai, kad visa summa tiešām atdota; nolasa visas atmaksas (arī, ja vairāk par 10);
  - „Atmaksāt”: pilna → „jau atmaksāts”; apstrādē → otru neveido; nav vai daļēja → atmaksā atlikumu; Idempotency-Key `refund-<brauciens>-<atdots>-<neizdevušās>` (vienāds vienlaicīgiem klikšķiem, jauns pēc daļējas vai neizdevušās); kļūdas gadījumā pārbauda vēlreiz (otrs dalībnieks varēja tieši tobrīd atmaksāt);
  - webhook: arī refund.created / refund.updated / refund.failed / charge.refund.updated; samaksāts tiek pierakstīts arī, ja daļēji atmaksāts;
  - lietotne (rides v149): „↩ Atmaksāts”, „↩ Daļēji atmaksāts X no Y” (šoferim poga atmaksā atlikumu), „↩ Atmaksa apstrādē”; atsevišķas ziņas.
- Datubāze nemainās (SQL nav jāpalaiž).
- Pārbaude: JS 152/152 (refundState visi stāvokļi; abu funkciju bloki vienādi; vecās kļūdas imitācija); TypeScript stingrā pārbaude abām funkcijām bez kļūdām. Stripe testa vidē nav pārbaudīts.
- Produkcijā (ar īpašnieka atļauju): izvietot `ride-pay` un `stripe-webhook` (webhook — ar `--no-verify-jwt`, kā līdz šim). Ieteicams Stripe webhook iestatījumos pievienot notikumus refund.updated un refund.failed (bez tiem gaidošas atmaksas stāvokli atjauno lietotne, atverot braucienu).
- Ja datubāzē jau ir maksājumi, kas kļūdas dēļ atzīmēti „refunded”, bet atmaksāti daļēji, — tos jāpārbauda Stripe panelī (atpakaļ uz „paid” statuss automātiski nemainās).

## A06 — noteikumos aizpildīts pakalpojuma sniedzējs un kontakts (audits 07.11.2026)

- `terms.html` un `privacy.html`: sniedzējs / pārzinis — Ričards Liepa, privātpersona, Latvija; kontakts — support.travel24@gmail.com (saite mailto:) visās 4 vietās; noņemtas piezīmes „vēl jāpapildina”; e-pasta sūtītājs — Supabase (kā šobrīd iestatīts).
- Personīgais e-pasts publiski netiek rādīts (tests pārbauda, ka lapās ir tikai atbalsta adrese).
- Dokumentu versijas nemainītas (2026-10-23 / 2026-11-01): aizpildīta tikai identitāte, lietotājiem atkārtoti piekrist nav jāprasa.
- Pārbaude: JS 153/153. Juridiski nav pārbaudīts — pirms īstas naudas ieteicams parādīt juristam; ja Supabase iestatīs citu e-pasta sūtītāju (piem. Resend/Brevo SMTP), tas jāpieraksta privātuma politikas 7. punktā.

## A07 — MapLibre 4.7.1 → 6.15.0 (audits 07.11.2026)

- Ievainojamība GHSA-jrc7-96c5-q579 (CVE-2026-85061, kritiska): `DOM.sanitize()` izlaida katru otro bīstamo atribūtu — kartes autortiesību teksts (attribution) no ārēja stila / flīžu servera (OpenFreeMap) varēja izpildīt JavaScript lietotnē bez neviena klikšķa. Labots ≥ 6.4.1; 4.x/5.x labojuma nav. Lokāli pierādīts ar mūsu lietotni: ar 4.7.1 ļaunprātīgs attribution izpildījās (`__xss=1`), ar 6.15.0 — nē.
- Izvēlēta 6.15.0 (izlaista 18.10.2026, ≥ 2 nedēļas veca; jaunākās 6.16.0 vēl neņemu).
- Izmaiņas:
  - `index.html` / `index-gl.html`: MapLibre 6 ir tikai ES modulis — `<script type="module">` uzliek `window.maplibregl`; visi nākamie skripti `defer` (pārlūks tos izpilda pēc moduļa, tajā pašā secībā); CSS 6.15.0. Darba pavediens (worker) ielādējas no unpkg caur pašas bibliotēkas blob pārvadu.
  - `app-gl.js`: trūkstošie zīmju/brīdinājumu attēli — `setMissingStyleImageResolver` (MapLibre 6), rezervē `styleimagemissing`; `zoomLevelsToOverscale: undefined` (ceļu flīzes kā 4.x — ceļu indeksam tie paši gabali); skaidra ziņa, ja MapLibre neielādējas (nav interneta) vai pārlūkam nav WebGL2 (6.x WebGL1 vairs neatbalsta).
  - `signs-gl.js`: `loadImage` atgriež solījumu (vienu uz attēlu; izpildās arī kļūdas gadījumā).
  - Pārbaudīts, ka kods neizmanto 5.x/6.x noņemto API (map.transform, antialias opcija, `on().on()` ķēdes, setData 2. parametrs, iekļauti skripti).
- Pārbaude: `tests/map-smoke.js` (Playwright, Chromium ar programmatūras WebGL) — 4.7.1 un 6.15.0 salīdzinājums: tie paši slāņi un avoti, kamera, marķieri, popup, maršruts, GPS bulta, brīdinājuma ikonas, stila maiņa — vienādi; ekrānuzņēmumi vienādi; 6.15.0 XSS neizpildās; bez WebGL / bez unpkg — ziņa ekrānā. JS 155/155.
- Nav pārbaudīts: īstā OpenFreeMap karte ar flīzēm un fontiem (testa vidē tīkls bloķēts), īsts telefons / Android lietotne. Pēc izlaišanas vērts atvērt growlab.cc telefonā un pabraukt pa karti.
- Produkcijā nekas nav jāpalaiž — GitHub Pages jau rāda jauno versiju.

## A08 — testi atkārtojami arī Windows; automātiski testi GitHub (audits 07.11.2026)

- `.gitattributes`: visi teksta faili ar LF rindu beigām (arī Windows ar core.autocrlf); attēli/arhīvi — bināri. `tests/run.js` turklāt pats pārvērš CRLF → LF (pārbaudīts: visas repozitorija kopija ar CRLF — 157/157).
- `.github/workflows/tests.yml` („Testi”) — katrai izmaiņai main zarā un katram pull request, bez slepenām atslēgām:
  - JS testi uz ubuntu-latest **un** windows-latest (Node 22);
  - datubāze: PostgreSQL 16 → `tests/run-sql.sh` (visi 25 `supabase/*.sql` produkcijas secībā, drošības labojumi divreiz, 7 SQL scenāriji + 2 sesiju tests) — lokāli 190/190; kļūdas gadījumā kods 1 (pārbaudīts ar apzināti bojātu scenāriju);
  - karte: `tests/map-smoke.js` ar to pašu MapLibre versiju, ko lieto lietotne (no oficiālā GitHub izlaiduma), Chromium; spriedums ar kodu 1; ekrānuzņēmums kā artefakts.
- `tests/sql/supabase-stub.sql` — Supabase lomu / auth aizstājējs tikai testiem. Tests pārbauda, ka run-sql.sh sarakstā ir visi `supabase/*.sql` un visi `tests/*-test.sql` (jauns fails bez testa neaizies nepamanīts).
- README: kā palaist testus lokāli.
- Ieteicams (īpašniekam, GitHub iestatījumos): Settings → Branches → main → „Require status checks to pass” (Testi), lai izmaiņas bez zaļiem testiem nevar ielikt.

## A09 — sakārtotas migrācijas, datubāzes pārbaude, jauns README (audits 08.11.2026)

- `supabase/ORDER.txt` — vienīgais migrāciju secības saraksts (26 faili); `tests/run-sql.sh` 2. daļa uzbūvē datubāzi tieši pēc tā.
- Pārbaudīts automātiski: katru vecāku failu palaižot atkārtoti pilnā datubāzē, 11 faili atjauno vecākas funkciju versijas (piem. `rides-2` atceltu A03 — `ride_driver_update`; `rides-7`, `reports`, `rides-9`, `stats-f16` — vecākus kontu/ziņojumu/statistikas kodus; `reports` un `coins-1` atkārtoti krīt ar kļūdu). Šiem failiem sākumā aizsardzība: ja `cz_migrations` rāda jaunākus — atsakās (`set cz.allow_rerun = 'on'` — apzinātai atkārtošanai). Pārējie paliek palaižami atkārtoti.
- `supabase/rides-17-migrations.sql` — tabula `cz_migrations` (lietotnei neredzama), atzīmē 1–25, palīgfunkcijas `cz_migration_begin/done` nākamajām migrācijām; prasa, lai 1–25 jau palaisti.
- `supabase/status.sql` — ģenerēts (`tests/gen-status.sh`), tikai lasošs „shēmas eksports”: salīdzina visas funkcijas (pēc teksta — neatkarīgi no PostgreSQL versijas), kolonnas, trigerus, politikas, indeksus, RLS, lietotnes tiesības un atzīmētās migrācijas; „VISS KĀRTĪBĀ” vai problēmu saraksts. CI pārbauda, ka tas ir aktuāls, ka uz pareizas datubāzes saka „VISS KĀRTĪBĀ” un ka pamana vecu funkcijas versiju.
- `tests/sql/supabase-stub.sql`: funkciju noklusējuma tiesības kā Supabase (anon/authenticated var izsaukt jaunas funkcijas, ja fails neatsauc).
- `supabase/MIGRATIONS.md` — failu tabula (ko dara, vai drīkst atkārtot), kā palaist migrāciju produkcijā, kā rakstīt jaunu, jauns Supabase projekts no nulles, rezerves kopijas un atjaunošana (ar brīdinājumu par trigeriem).
- `README.md` pārrakstīts (pašreizējā arhitektūra, faili, datubāze, testi, ierobežojumi).
- Pārbaude: SQL 212/212 (t. sk. 11 aizsardzības, status.sql), JS 161/161.
- Pamanīts (nav labots — A10): Supabase noklusējuma dēļ `ride_driver_acct`, `traffic_report`, `report_type_ttl`, `coin_trust_factor` var izsaukt arī anon (faili atsauc tikai `public`).
- Produkcijā: pēc 22–25 palaist arī `rides-17-migrations.sql`, tad `status.sql` (ar īpašnieka atļauju).

