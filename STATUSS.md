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

## v135 — mazāki luksofori kartē

- Luksoforu ikonas kartē ~35 % mazākas (`TRAFFIC_LIGHT_SCALE = 0.65` signs-gl.js `signsIconSize`); pārējās zīmes nemainītas.
- Versijas: signs-gl.js v135. Testi: 133/133.

## v136 — luksofori vēl mazāki

- `TRAFFIC_LIGHT_SCALE` 0.65 → 0.45 (≈ puse no sākotnējā izmēra). signs-gl.js v136. Testi: 133/133.

## v137 — luksofori mazāki arī brīdinājumu režīmā

- v135/v136 mainīja tikai „Zīmes” režīma slāni (signs-gl.js). Brīdinājumu režīmā luksoforus zīmē `alerts` slānis (app-gl.js `alertIconSize`) — tagad arī tur tiek lietots `TRAFFIC_LIGHT_SCALE` (0,45).
- Versijas: app-gl.js v137. Testi: 134/134.
