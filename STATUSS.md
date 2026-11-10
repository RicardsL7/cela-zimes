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
- Pamanīts (nav labots; sk. A10 — datu noplūdes nav): Supabase noklusējuma dēļ `ride_driver_acct`, `traffic_report`, `report_type_ttl`, `coin_trust_factor` var izsaukt arī anon (faili atsauc tikai `public`).
- Produkcijā: pēc 22–25 palaist arī `rides-17-migrations.sql`, tad `status.sql` (ar īpašnieka atļauju).


## A10 — drošības politika (CSP), bez sveša JavaScript, rāmja aizsardzība (audits 08.11.2026)

- GitHub Pages neļauj iestatīt HTTP galvenes, tāpēc CSP ir `<meta http-equiv="Content-Security-Policy">` katras lapas
  (`index.html`, `index-gl.html`, `admin.html`, `privacy.html`, `terms.html`) `<head>` sākumā, uzreiz pēc `charset`:
  - `script-src 'self'` — bez `unsafe-inline` / `unsafe-eval` / CDN; vienīgais iekļautais skripts (MapLibre imports) pārcelts uz `maplibre-load.js`;
  - `connect-src` — tikai Supabase projekts un lietotnes izmantotie serveri (OpenFreeMap, OSM, Overpass, Mapillary, Photon,
    Nominatim, OSRM, Open-Meteo); `admin.html` — tikai Supabase; juridiskās lapas — neko;
  - `worker-src 'self'`, `object-src 'none'`, `frame-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `upgrade-insecure-requests`;
  - `style-src` atļauj `'unsafe-inline'` (lietotne plaši lieto `style="…"`) un Google Fonts; `img-src https:` (Mapillary foto, zīmju attēli).
  - `<meta name="referrer" content="strict-origin-when-cross-origin">`.
- SRI vietā — **MapLibre no pašas lapas** (`vendor/maplibre-gl-6.15.0/`): SRI moduļa `import` un MapLibre worker (no CDN
  tas tiek palaists caur `blob:` ar vēl vienu `import`) nevar pārbaudīt. `vendor/vendor.lock` — arhīvs no github.com
  (oficiālais `dist.zip`, tas pats, ko lietoja kartes tests) un katra faila SHA-256; GitHub Actions „Bibliotēkas (vendor)”
  (`.github/workflows/vendor.yml`, `tools/vendor.sh`) lejupielādē, pārbauda un saglabā failus. Worker tagad no tās pašas adreses.
- `guard.js` (pirms visiem pārējiem): lapa rāmī (iframe) tiek paslēpta un mēģina atvērties pa visu logu — `frame-ancestors`
  / `X-Frame-Options` meta tagā nedarbojas.
- Android lietotne (Capacitor, `server.url`) ievieto savu skriptu tieši pēc `<head>` — pirms CSP meta taga, tāpēc to CSP
  neietekmē; tests pārbauda, ka `<head>` paliek bez atribūtiem un CSP ir pirmais pēc `charset`.
- Testi: `tests/run.js` +4 (CSP katrā lapā; katrs serveris, ko JS izsauc, ir `connect-src`; vendor/ SHA-256 = vendor.lock;
  kartes tests) — 165/165. `tests/map-smoke.js`: CSP spēkā — 0 pārkāpumu kartē (stils, flīzes, glyph, ikonas, maršruts,
  stila maiņa), worker ielādēts no `vendor/`, admin/privacy/terms bez pārkāpumiem, lapa svešā rāmī — `display: none`.
  Pārbaudīts arī pretēji: izņemot serveri no CSP, abi testi krīt.
- Nav iespējams bez cita hostinga (lēmums īpašniekam): HTTP galvenes (`frame-ancestors`, `X-Frame-Options`, CSP Report-Only
  ziņojumi). Iespēja — Cloudflare priekšā growlab.cc (Transform Rules / Workers pievieno galvenes; tā pati CSP).
- A09 piezīme pārbaudīta: `traffic_report` anon izsaukt NEVAR (`stats-f16` atsauc); `ride_driver_acct` bez pieslēgšanās
  atgriež tukšu (`auth.uid()`), `report_type_ttl` / `coin_trust_factor` — tikai aprēķini bez datiem. Datu noplūdes nav;
  tiesību sakārtošana (atsaukt anon palīgfunkcijām) — atsevišķs mazs darbs.
- Versijas: `guard.js?v=151`, `maplibre-load.js?v=151`, `app-gl.js?v=151`.

## A11 — regulāra vecu datu tīrīšana un brīdinājums par kļūmēm (audits 08.11.2026)

- Problēma: veci dati tika dzēsti tikai tad, kad kāds rakstīja jaunus (`report_create`, `traffic_report`, `presence_update`);
  ja neviens neraksta — dati palika ilgāk, nekā solīts `privacy.html` 9. punktā.
- `supabase/cleanup-1.sql` (ORDER.txt Nr. 27; pirmā migrācija ar `cz_migration_begin/done`):
  - `cz_cleanup()` — ziņojumi (ar atzīmēm, kaskādē) derīguma beigas + 2 d., ātruma mērījumi 28 d., mērījumu skaitītāji 1 d.,
    vieta citu kartē 5 min bez atjaunošanas, konta pārneses kodi pēc derīguma, Stripe notikumu ID 90 d., novecojuši braucieni
    (`ride_expire`), pg_cron vēsture 7 d. Katrs solis savā blokā — kļūda vienā neaptur pārējos, tiek pierakstīta.
  - pg_cron darbs `cz-cleanup` ik 5 min (tātad vieta kartē pazūd ≤ 10 min — kā solīts); fails pats ieslēdz pg_cron.
  - `cz_cleanup_runs` — katra palaišana (laiks, cik izdzēsts, kļūdas), 7 dienas; lietotnei neredzama.
  - `cz_cleanup_status()` (tikai īpašniekam) — `admin.html` augšā sarkans brīdinājums, ja darbs nav ieplānots vai pēdējā
    veiksmīgā > 20 min (ar pēdējo kļūdu); ja strādā — piezīme apakšā (cik 24 h izdzēsts). Fails vēl nav palaists → paskaidrojums.
  - `cz_health()` (anon, bez datiem) — `.github/workflows/monitor.yml` „Uzraudzība” reizi stundā; ja tīrīšana nestrādā →
    darbs neizdodas → GitHub e-pasts. Kamēr fails produkcijā nav palaists — tikai brīdinājums.
  - `status.sql` (ģenerēts) — jauna pārbaude „plānotājs … nav ieplānots”.
- Testi: `tests/cleanup-test.sql` (34: ko dzēš / ko atstāj katrā tabulā, kaskāde, braucieni, pieraksts, tiesības, kļūda vienā
  solī, brīdinājums pēc 20 min, darbs noņemts); `supabase-stub.sql` — pg_cron aizstājējs; SQL 247/247, JS 167/167.
- Privātuma politika nav mainīta (termiņi tie paši — tagad tos ievēro arī tad, ja neviens neraksta).
- Versija: `admin.js?v=152`.
- Produkcijā: pēc 22–26 palaist `cleanup-1.sql`, tad `status.sql` (ar īpašnieka atļauju).
- 08.11.2026 produkcijā palaisti 22–27 (rides-13 … cleanup-1). Pirmajā `status.sql` palaišanā produkcijā pgcrypto funkcijas
  rādījās kā „trūkst”: Supabase pgcrypto ir shēmā `extensions`, bet testu aizstājējs to lika `public`. Labots
  (`tests/sql/supabase-stub.sql` — `with schema extensions`), `status.sql` pārģenerēts; lietotnes SQL pgcrypto nelieto.

## A12 — paneļi ar tastatūru un ekrāna lasītāju (audits 08.11.2026)

- Problēma: atvērtā panelī (iestatījumi, „Ziņot”, „Kopā”, Garāža …) tastatūras fokuss palika fonā; Esc strādāja tikai iestatījumos.
- `sheets.js` (jauns, ielādējas pirms `auth.js`): vēro paneļu atribūtu `hidden` (MutationObserver) — atvēršanas vietas kodā nav jāmaina.
  - `role="dialog"`; modālajiem (iestatījumi, Ziņot, „Kā ieslēgt?”, Garāža, Kopā) `aria-modal="true"`.
  - Atverot fokuss — uz paneļa virsrakstu (ekrāna lasītājs nolasa nosaukumu); ja kods jau fokusēja lauku panelī — atstāj.
  - Modālajiem fons ekrāna lasītājam paslēpts (`aria-hidden`), Tab / Shift+Tab riņķo panelī. Pilnekrāna pārklājumiem
    (piekrišana, Garāžas pirkums) fons arī `inert`.
  - Esc aizver augšējo paneli (caur tā pogu „Aizvērt”); piekrišanu — ne. Ja raksta meklēšanā ārpus paneļa — Esc pieder meklēšanai.
  - Aizverot fokuss atgriežas uz pogas, ar ko atvēra (arī ja atvēra ar peli/pirkstu), citādi uz paneļa pogu rīkjoslā.
  - Rīkjoslas pogām `aria-controls` + `aria-expanded` (atvērts / aizvērts).
  - Ja panelī nomainās saturs un fokuss pazūd (piekrišanas solis „Nepiekrītu”, Garāžas dialogs) — fokuss atpakaļ panelī.
- Apzināti: stāvēšanas un vietu paneļi ir ne-modāli (tajos vietu izvēlas, pieskaroties kartei); arī modālo paneļu laikā karti
  var pavilkt — tāpēc `inert` fonam tikai pilnekrāna pārklājumiem (ne paneļiem, kas aizņem ekrāna apakšu).
- Testi: kartes testā (Chromium) ar tastatūru — iestatījumi, Ziņot, stāvēšana, Garāžas pirkuma dialogs, piekrišanas ekrāns
  jaunam lietotājam (fokuss, fons, Tab 40×, Esc, fokuss atpakaļ, aria-expanded); pretēji pārbaudīts — bez `sheets.js` tests krīt.
  `tests/run.js` +2 (169/169).
- Versijas: `sheets.js?v=153`, `style-gl.css?v=153`.

## A13 — ārējo servisu kvotas: mērīšana, rinda, pauze, fona cilnes (audits 08.11.2026)

- `netguard.js` (jauns, pirmais skripts): visi lapas `fetch` iet caur to.
  - Mēra katram serverim (šodien / 7 d., kļūdas, 429/503, aizturēti, vidējais laiks) — iestatījumos ar `?dev=1`
    („Tīkla pieprasījumi šajā ierīcē”), konsolē `czNet.stats()`; glabā tikai šajā ierīcē (localStorage, 7 dienas).
  - Bezmaksas serveriem rinda pēc noteikumiem (Nominatim ≤ 1/s un 1 vienlaikus, OSRM ≤ 1/s, Overpass ≤ 2 vienlaikus) un
    pauze pēc 429/503/502/504 vai kļūmes: 5 s → 10 s → … ≤ 5 min (Retry-After ≤ 10 min; Overpass pēc 429 ≥ 30 s).
    Pauzē pieprasījumi uzreiz atgriež kļūdu — serveris netiek dauzīts. Bez interneta pauzi neliek.
  - Supabase un pārējos tikai skaita (maksājumus/kontus neaptur).
- Overpass: agrāk katrs vaicājums gāja abiem serveriem reizē (2× slodze); tagad veselākajam, otram — tikai pēc 4 s vai kļūdas.
- **Atrasta kļūda:** ja Mapillary flīze neielādējās (serveris / internets), lietotne to mēģināja atkal ik 100 ms — kartes testā
  512 pieprasījumi minūtē. Tagad pauze 5 s … 2 min (testā — 7).
- Nominatim tikai pēc „Meklēt” (tā noteikumi aizliedz meklēšanu rakstīšanas laikā); rakstot — Photon.
- Fona cilnē nepieprasa: laikapstākļi, „Kopā” bez aktīva brauciena (aktīvā — vieta jāsūta arī fonā); atgriežoties — uzreiz.
  Ziņojumi, sastrēgumi, citi braucēji fonā neaptaujāja jau agrāk.
- `README.md` — „Mērogošana un ārējie servisi”: slodze uz lietotāju stundā katram servisam un kur kura servisa robeža.
  Galvenais: **Overpass publiskais serveris lietotnei kopā atļauj ~100 vaicājumus dienā** — jau ar dažiem desmitiem aktīvu
  lietotāju jāpāriet uz iepriekš sagatavotiem datiem (kā `data/osm/cameras.json`) vai savu serveri. Mērķa lietotāju skaits —
  īpašnieka lēmums.
- Testi: `run.js` +7 (pauze, pieaugums, Retry-After, Nominatim rinda, Supabase neaptur, atcelšana rindā, katram CSP serverim
  ierobežojums, Overpass/Mapillary/fona cilnes) — 176/176; kartes testā — netguard ieslēgts un skaita.
- Avoti: Overpass — wiki.openstreetmap.org/wiki/Overpass_API; OSRM — github.com/Project-OSRM/osrm-backend/wiki/API Usage Policy;
  Photon — github.com/komoot/photon/wiki; OpenFreeMap — openfreemap.org; Nominatim — operations.osmfoundation.org/policies/nominatim.
- Versijas: `netguard.js?v=154`, `app-gl.js?v=154`, `rides-ui.js?v=154`, `style-gl.css?v=154`.

## A14 — Android: lockfile, parakstīts laidiens, ierīces tests, saites lietotnē (audits 08.11.2026)

- **Atkarības:** `mobile/package-lock.json` (precīzas versijas + kontrolsummas) — to uztur GitHub Actions
  „Android atkarības (lockfile)” (`android-lock.yml`, bez instalēšanas skriptiem); `android.yml` būvē ar `npm ci`
  (bez lockfile — skaidra kļūda). Node 22. Jauns spraudnis `@capacitor/app` (saites lietotnē).
- **Parakstīts laidiens:** ja GitHub Secrets ir `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
  `ANDROID_KEY_PASSWORD` — parakstīts APK (telefonam, atjauninās virs vecā) un AAB (Google Play); versionCode = būvējuma
  numurs. Atslēgas failu darbplūsma izdzēš arī kļūdas gadījumā; atslēgu izveido tikai īpašnieks (`mobile/README.md`).
  Bez atslēgas — testa APK kā līdz šim (brīdinājums Actions).
- **Saites lietotnē (e-pasta pieslēgšanās, Google, Stripe atgriešanās):** Android App Links — `patch-android.js` pievieno
  `https://growlab.cc` filtru (autoVerify); `.well-known/assetlinks.json` darbplūsma izveido pati no parakstīšanas
  sertifikāta (`_config.yml` — GitHub Pages to publicē); `app-native.js` lietotnē ielādē atvērto adresi (tikai savu
  domēnu; to pašu otrreiz ne; žurnālā bez atslēgām), un auth.js / rides-ui.js to apstrādā kā pārlūkā.
  Darbojas pēc parakstīta laidiena (verificēts domēns); līdz tam saites atveras pārlūkā kā agrāk.
- **Ierīces tests:** `android.yml` darbs „device” — Android 14 emulatorā `mobile/scripts/device-test.sh`: instalēšana,
  atļaujas, App Links filtrs, palaišana bez avārijas, growlab.cc ielāde, spraudņi, growlab.cc saite atveras lietotnē.
  Laidienu lapā APK nonāk tikai, ja tests izdevās; ekrānuzņēmumi un logcat — artefakts `device-test`.
  Ar roku (telefonā) — saraksts `mobile/README.md` (īsts GPS, e-pasts, Google, Stripe, TalkBack, 2 telefoni).
- Testi: `run.js` +5 (181/181), t.sk. `patch-android.js` uz parauga Android projekta un `app-native.js` (vm).
- **Ierīces tests atrada kļūdu:** lietotne ielādē dzīvo lapu (`server.url`), kurā nav `@capacitor/core`, tāpēc
  `Capacitor.registerPlugin` tur neeksistē — ir tikai `Capacitor.Plugins.*`, ko ievieto Android apvalks. Gan saišu
  apstrāde (`app-native.js`), gan **fona GPS (v146, `nativeGeo` app-gl.js)** klusām nestrādāja — lietotne lietoja parasto
  pārlūka GPS. Tagad abi lieto `registerPlugin`, ja ir, citādi `Capacitor.Plugins.*`; `addWatcher` id der gan tieši,
  gan kā Promise. Ierīces tests pārbauda arī `[cz-native] gatavs` (app-native.js lietotnē redz spraudni).
- Versija: `app-native.js?v=156`, `app-gl.js?v=156`; Android `versionName` 0.2.0.

## A15 — konta dzēšana neizdzēš otra dalībnieka braucienu un maksājumu (audits 08.11.2026)

- **Problēma:** dzēšot kontu, datubāze kaskādē izdzēsa arī otra cilvēka datus — pasažiera braucienu ar šoferu
  piedāvājumiem, šofera braucienus ar pasažieru maksājuma ierakstiem (`ride_payments` — saite ar Stripe), čatu, vērtējumus.
  Kontu varēja dzēst arī brauciena vidū vai nepabeigtas atmaksas laikā.
- **Īpašnieka lēmums (08.11.2026):** „anonīms ieraksts” + jauna privātuma politikas un noteikumu versija.
- **`supabase/account-1-delete.sql` (Nr. 28):**
  - `account_delete_check()` / `delete_my_account()` — nedzēš, ja ir aktīvs brauciens, maksājuma lapa atvērta < 24 h
    vai samaksāts brauciens atcelts pirms iekāpšanas, bet atmaksa nav pabeigta (`account_busy`); viena dzēšana vienlaikus.
  - Trigeris `profiles_erase_rides` (darbojas arī, ja lietotāju dzēš Supabase panelī) + ārējās atslēgas `ON DELETE SET NULL`:
    braucieni bez vēstures — dzēsti; ar vēsturi — otram paliek bez dzēstā ID, adreses, piezīmes, precīzām koordinātām
    (~1 km) un pēdējām atrašanās vietām; maksājuma ieraksts paliek. Dzēstā čata ziņas, tālrunis, profils, Stripe piesaiste,
    vērtējumi par viņu — dzēsti; viņa doto vērtējumu zvaigznes paliek bez komentāra un autora. Ja abi dzēsuši — brauciens dzēsts.
  - Vērtēt dzēstu lietotāju nevar (`other_deleted`); ziņot par braucienu — var.
  - `status.sql` tagad pārbauda arī ārējo atslēgu darbību (CASCADE / SET NULL).
- **Edge funkcijas** (jāizvieto): `ride-pay` `close` pārbauda `account_delete_check` pirms Stripe konta slēgšanas (409);
  `stripe-webhook` un `sync` — ja pasažieris dzēsts, maksājumu pieraksta šofera vārdā.
- **Lietotne v157** (`rides.js`, `rides-ui.js`, `auth.js`): dzēšot — vispirms pārbaude (nepabeigtu atmaksu mēģina pabeigt
  uzreiz), iemesli latviski; tad Stripe konts, tad dzēšana. Ja datubāzē vēl nav Nr. 28 — nedzēš (vecā versija dzēstu otra
  datus) un iesaka rakstīt atbalstam. Vēsturē — „Dzēsts lietotājs”, bez vērtēšanas formas.
- **Politika:** `privacy.html` un `terms.html` versija 2026-11-08 (visiem vienreiz piekrišanas logs) — kas paliek otram,
  kad kontu nevar dzēst.
- Testi: `tests/account-delete-test.sql` (42), `run.js` +6 (187/187), `run-sql.sh` 290/290; vecākie migrāciju faili
  ar `cz_migration_begin` (27) tagad paši atsakās palaisties pēc 28 (pārbaudīts).

## A16 — citu braucēju punkti kartē vairs nav publiski izsekojami (audits 08.11.2026)

- **Problēma:** braucēja punkts (~20 m, ik 20 s, virziens, tēls) bija nolasāms jebkuram, arī bez konta, 55 × 60 km
  laukumā; rādīšana ieslēdzās kopā ar ātruma dalīšanu. Punktus varēja savienot ceļā un atrast mājas / darbu.
- **Īpašnieka lēmums (08.11.2026):** atsevišķs slēdzis; ~150 m + pēc 1 min; redz tikai braucot, ap sevi.
- **`supabase/presence-2-privacy.sql` (Nr. 29):** piekrišana `show_on_map` (≥ 2026-11-08) — ātruma dalīšana vairs
  neieslēdz; ~150 m; redzams pēc ≥ 60 s nepārtrauktas braukšanas; atjaunošana ≥ 25 s; līdzšinējie punkti dzēsti.
  `presence_nearby(mana vieta, ātrums)` — tikai `authenticated`, tikai ≥ 15 km/h, ≤ 15 km, ≥ 12 s; pirmās 60 s / 200 m —
  tukšs; lēciens > 250 km/h — no jauna; skatītāja vieta (~50 m) `presence_viewers`, dzēsta apstājoties / pēc 10 min
  (arī `cz_cleanup`). Vecā publiskā `presence_nearby(laukums)` dzēsta.
- **Lietotne v158** (`presence.js`, `reports.js`, `traffic-gl.js`, `garage.js`, `auth.js`, `admin.js`): iestatījumos
  „Rādīt mani citu kartē” (noklusēti izslēgts, piekrišana serverī); citus rāda tikai braucot (sava vieta, nevis kartes
  laukums), bez konta — nerāda; ātruma dalīšanas teksts vairs nesola vietu citu kartē (versija nemainās — šaurāk).
- **Politika** `privacy.html` 2026-11-08b (vēlreiz piekrišanas logs): §6 vieta citu kartē un citu redzēšana, §8 termiņi.
- **Atlikušais risks:** viltots „brauciens” ar daudziem anonīmiem kontiem joprojām var redzēt punktus ap sevi (≤ 15 km,
  ~150 m, ne biežāk kā ik 12 s) — daudz grūtāk nekā līdz šim, bet ne neiespējami.
- Testi: `tests/presence-privacy-test.sql` (27), `run.js` +4 (191/191), `run-sql.sh` 318/318.

## B01 (audits 2) — produkcija panākta (08.11.2026)

- Pēc īpašnieka lūguma produkcijā palaisti SQL **28** (`account-1-delete.sql`) un **29** (`presence-2-privacy.sql`).
  Pirms tam pārbaudīts stāvoklis (1–27, ārējās atslēgas CASCADE, vecā `presence_nearby` bija publiska); pēc tam
  `status.sql` — **VISS KĀRTĪBĀ**; ārējās atslēgas — SET NULL; vecā publiskā `presence_nearby(laukums)` dzēsta, jaunā —
  tikai pieteikušies; `cz_cleanup` un `cz_health` strādā; braucienu skaits nemainījās (28).
- Edge funkcijas izvietotas no repozitorija (sha256 sakrīt): `ride-pay` (iepriekš bija 29.10. versija — bez A04 dubultā
  maksājuma, A05 atmaksu un A15 labojumiem) un `stripe-webhook` (iepriekš 28.10. versija). Pirms izvietošanas —
  `deno check`. `stripe-webhook` JWT pārbaude izslēgta (Stripe sūta bez JWT), startē bez kļūdām; `ride-pay` bez
  pieteikšanās atbild 401.
- Nav pārbaudīts: īsts maksājums / atmaksa Stripe testa režīmā (audits B18) un konta dzēšana ar īstu kontu dzīvajā vietnē.

## B02 (audits 2) — atvērtie braucieni vairs neatklāj precīzu adresi un vārdu (08.11.2026)

- **Problēma:** jebkurš pieteicies konts (arī tikko izveidots anonīms) nolasīja visus atvērtos pieprasījumus ar precīzām
  koordinātām, adresi, piezīmi un pasažiera vārdu; arī jebkurš piedāvājums atvēra visu.
- **`supabase/rides-18-open-privacy.sql` (Nr. 30):** `requests_read` — tikai pasažieris un šoferis ar pieņemtu
  piedāvājumu (`was_accepted`). Šoferu sarakstam `ride_requests_open(laukums)` un `ride_requests_coarse(id)`: ~1 km,
  apdzīvotā vieta, laiks, vietas, statuss, pasažiera vērtējums — bez vārda, adreses, piezīmes, konta ID; ne anon.
- **Lietotne v159** (`rides.js`, `rides-ui.js`): saraksts no jaunās funkcijas (pirms SQL Nr. 30 — vecais ceļš);
  kartītē „Pasažieris”, vieta „Ap Rīga (~1 km)”, vērtējums un paskaidrojums; gaidošie piedāvājumi — aptuveni,
  pieņemtie — precīzi (navigācija pie pasažiera kā līdz šim). Pasažiera formā paskaidrots, ko šoferi redz.
- **Politika:** `privacy.html` 3. punkts papildināts (redzamība samazinājās — versija nemainās).
- **Produkcijā:** Nr. 30 palaists 08.11.2026 ar īpašnieka atļauju; `status.sql` — VISS KĀRTĪBĀ; `requests_read` =
  `(user_id = auth.uid()) OR ride_request_exact(id)`; `ride_requests_open` — ne anon; braucieni neskarti (28).
- Testi: `tests/open-privacy-test.sql` (14), `run.js` +3 (194/194), `run-sql.sh` 333/333.

## B03 (audits 2) — kopbrauciena maksa = ceļa izdevumu daļa, ne peļņa (08.11.2026)

- **Problēma:** kopš v92 šoferis drīkstēja prasīt līdz 300 € jebkuram braucienam, un lietotne ietur 10 % komisiju.
  Tas izskatās pēc komercpārvadājuma („par maksu profesionālas darbības veidā”, Autopārvadājumu likums 1. p. 26. p.),
  kam vajag licences kartītes, ATD reģistrāciju un datu sūtīšanu VID pēc katra brauciena (MK Nr. 541).
- **Īpašnieka lēmums:** modelis „izdevumu dalīšana”.
- **`supabase/rides-19-cost-share.sql` (Nr. 31):** griesti = attālums × 1,3 × 12 c/km, vismaz 2 € (Rīga → Liepāja ≈ 30,44 €);
  šoferu saraksts atdod `cap_cents`; `ride_fare_cap_cents` — ne anon.
- **Lietotne v160** (`rides.js`, `rides-ui.js`, `auth.js`): tā pati haversina formula (cents sakrīt ar datubāzi), lauks
  „Ceļa izdevumu daļa (neobligāti, līdz X)”, skaidrs paziņojums, ja summa par lielu; noteikumi lietotnē.
- **Noteikumi:** `terms.html` — „Kopbraucieni ir izdevumu dalīšana…”, versija 2026-11-08b (piekrišanas logs no jauna).
- **Juristam un grāmatvedim:** dokuments „Maksājumu juridiskā sagatavošana” (jautājumi, MK 541 prasības, kontrolsaraksts
  pirms `PAY_LIVE`). Īsti maksājumi paliek izslēgti, līdz jurists to apstiprina.
- **Produkcijā:** Nr. 31 palaists 08.11.2026 ar īpašnieka atļauju; `status.sql` — VISS KĀRTĪBĀ; Rīga → Liepāja = 3044;
  `ride_fare_cap_cents` un `ride_requests_open` — ne anon; gaidošu piedāvājumu nebija, braucieni neskarti (28).
- Testi: `tests/cost-share-test.sql` (9), `run.js` +3 (197/197), `run-sql.sh` 343/343, kartes tests — kārtībā.

## B04 (audits 2) — ārējie servisi: sagatavota pāreja uz maksas plāniem (10.11.2026)

- **Īpašnieka lēmums:** šobrīd 0 €; maksas servisus pērk kopā ar īsto maksājumu ieslēgšanu (`PAY_LIVE`), jo tieši tad
  lietotne kļūst komerciāla. Cenas un noteikumi — README „Ārējie servisi: pāreja uz komerciālu lietošanu”.
- **`services.js` (jauns, v161):** visu maršruta, meklēšanas un laikapstākļu serveru adreses vienā vietā; citur kodā tās
  vairs nav ierakstītas (`nav.js`, `park-gl.js`, `places.js`, `app-gl.js`).
- **Rezerves maršruta serveris:** ja OSRM demo neatbild, saka „par daudz” vai ir pauzē — `osrmFetch` jautā FOSSGIS
  (routing.openstreetmap.de, tas pats OSRM API). „Nav maršruta” (4xx) rezervei nejautā. Viens serveris — ≤ 12 s.
- **`supabase/functions/weather` (jauna, NAV izvietota):** laikapstākļi ar Open-Meteo maksas atslēgu no Secrets;
  vieta noapaļota ~1 km, 10 min kešs, ≤ 30/min no IP, tikai vajadzīgie lauki; bez atslēgas — 503 (bezmaksas API neizmanto).
  Lietotne to izmantos, tiklīdz `services.js` norādīs uz to (pievieno publisko anon atslēgu galvenē).
- **Atsauces „Datu avoti”:** saites uz OSM autortiesībām un Open-Meteo (CC BY 4.0), FOSSGIS maršruti, „Labot karti”.
- **Blakus atrastas un labotas kļūdas:**
  - A13 „vispirms veselākais Overpass serveris” nestrādāja: `czNet.health` citos skriptos ir netguard.js iekšējais
    objekts (bez `.health`) — tagad `czNetHealth()`. Konsolē statistika: `window.czNet.stats()`.
  - Iestatījumu panelī Tab izkrita no paneļa, ja aizvērtā „Datu avoti” bija saites — fokusa slazds tagad neskaita
    aizvērtas `<details>` saturu (`sheets.js`).
- **Versijas v161:** services, netguard, sheets, nav, places, app-gl, park-gl.
- Testi: `run.js` 203/203 (+6 B04), kartes tests kārtībā, `tests/weather-fn-test.ts` (deno) 12/12.

## B05 (audits 2) — atrašanās vietas vaicājumi vairs neiet uz Krieviju; politikā visi karšu pakalpojumi (10.11.2026)

- **Overpass:** izņemts rezerves serveris maps.mail.ru (VK, Krievija) — no lietotnes (`services.js` → `CZ_SERVICES.overpass`,
  `app-gl.js`), CSP, `netguard.js`, nakts datu skripta `tools/build-osm.mjs` un vecā `app.js`. Paliek overpass-api.de (FOSSGIS,
  Vācija). ES alternatīvu Private.coffee (Austrija) pārbaudīju — 10.11. neatbildēja, OSM forumā (03.2026) minēts kā slēgts,
  tāpēc nav pievienots. Ja overpass-api.de neatbild: Mapillary zīmes, radari (data/osm/cameras.json) un stāvēšanas dati
  (data/osm) strādā; OSM zīmes jaunās vietās ielādēsies, kad serveris atgriezīsies. Rezervei — savs Overpass (B04).
- **jsDelivr (Mapillary zīmju ikonas):** piesaistīts konkrētam commit `1465def…` (agrāk `@master` — saturs varēja mainīties).
  Pārbaudīts: ikona ielādējas. Pašu mitināšana (1543 ikonas, 11 MB) — nav vajadzīga.
- **Privātuma politika 2026-11-10:** 2. punktā visi ārējie pakalpojumi (arī FOSSGIS maršruti, jsDelivr, Overpass, OSM API);
  7. punktā — kur tie atrodas (ES / pietiekama aizsardzība / ASV) un „Lietotne neizmanto serverus Krievijā”.
  `CZ_PRIVACY_VERSION = '2026-11-10'` — lietotāji redzēs piekrišanas logu vēlreiz. Tests pārbauda, ka katrs CSP serveris ir minēts politikā.
- Versijas v162: services, netguard, mapillary, app-gl, auth (index, index-gl, admin).
- Testi: `run.js` 206/206 (+3 B05), kartes tests kārtībā.

## B07 (audits 2) — viltoti anonīmi konti: CAPTCHA un nelietotu kontu dzēšana (10.11.2026)

- **Īpašnieka lēmumi:** Cloudflare Turnstile tagad; anonīmus kontus dzēst pēc 180 dienām bez lietošanas.
- **`captcha.js` (jauns, v163):** Turnstile žetons jaunam kontam un e-pasta saitei (`auth.js` → `gotrue_meta_security`).
  Cloudflare skripts tiek ielādēts tikai tad, kad vajag žetonu. Braucot (> 10 km/h) un fonā (ātruma dalīšana) — tikai neredzamā
  pārbaude: ja vajag darbību, logs netiek rādīts (kļūda `captcha_needed`, teksts „Kad esi apstājies, mēģini vēlreiz”).
  Kamēr `rides-config.js` → `captchaSiteKey` ir tukšs, nekas nemainās. CSP: `challenges.cloudflare.com` script-src un frame-src
  (index, index-gl, admin).
- **`supabase/account-2-anon-cleanup.sql` (Nr. 32):** `cz_anon_cleanup()` katru nakti (pg_cron „cz-anon-cleanup”, 02:23 UTC) —
  anonīmi konti bez e-pasta, 180 d. bez pieslēgšanās (pēc `auth.sessions`); izlaiž aktīvu braucienu / maksājumu / šofera Stripe
  kontu; ≤ 500 reizē; pieraksts `cz_cleanup_runs`. `account_erase()` — viena dzēšana arī `delete_my_account`.
- **Privātuma politika 2026-11-10b:** Cloudflare (3. un 7. punkts), 180 dienas (8. punkts) — piekrišanas logs vēlreiz.
- Versijas v163: captcha, auth, rides-config, rides-ui, traffic-gl, style-gl, admin.css.
- Testi: `run.js` 213/213 (+7 B07), `run-sql.sh` (+ anon-cleanup-test), kartes tests kārtībā.
- **Produkcijā:** Nr. 32 palaists 10.11.2026 ar īpašnieka atļauju; `status.sql` — VISS KĀRTĪBĀ. growlab.cc (v163): CSP atļauj
  Turnstile, Cloudflare skripts netiek ielādēts, atverot lietotni; ar Cloudflare testa atslēgām žetons iegūts, bez loga — `captcha_needed`.
- **10.11.2026 (v164):** Turnstile logrīks izveidots (growlab.cc, Managed); publiskā Site Key ielikta `rides-config.js` — lietotne sūta žetonu.
- **10.11.2026 — IZDARĪTS:** īpašnieks ieslēdza Supabase CAPTCHA (Turnstile, Secret Key tikai Supabase); anonīmās pieteikšanās
  limits 30 stundā no IP (jau bija). Pārbaude growlab.cc: e-pasta saites pieprasījums ar Turnstile žetonu izdevās.

## B06 (audits 2) — personīgais e-pasts publiskajā Git vēsturē (10.11.2026)

- **Pārbaudīts:** repozitorija failos (arī visā vēsturē) personīgā adrese nav; tā ir tikai commit autora laukā (410 commit),
  jo GitHub web lapa commit veido ar konta galveno e-pastu.
- **Īpašnieks:** GitHub → Settings → Emails — „Keep my email addresses private” un „Block command line pushes that expose my email”.
- **Vecā vēsture netiek pārrakstīta** (īpašnieka lēmums): adrese jau ir publiska, pārrakstīšana prasītu force push un sabojātu kopijas.
- **Aizsardzība nākotnei:** CI darbs „Commit autori” (`tools/check-authors.sh`) — jaunajos commit (push / PR diapazonā) autoram
  un iesniedzējam jābūt `…@users.noreply.github.com` vai `noreply@github.com`; žurnālā raksta tikai domēnu. Tests `run.js`
  pārbauda visus repozitorija failus, ka tajos nav personīgu e-pastu (tikai atbalsta adrese).
- **10.11.2026:** īpašnieks ieslēdza abus GitHub iestatījumus; B06 commit jau ar noreply autoru, CI „Commit autori” zaļš.
- Testi: `run.js` 216/216 (+3 B06).

