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
