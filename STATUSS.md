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
