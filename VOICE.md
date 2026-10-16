# Navigācijas balss (latviski)

## Kā tas strādā

```
navigācija (app-gl.js) ──► voice.js: KO teikt un KAD (tīras funkcijas, testi)
                              │  teikums = daļas: "Pēc simt piecdesmit metriem" · "pagriezies pa kreisi" · "tad pa labi"
                              ▼
                           Voice (balsu ķēde)
                              1. RecordedVoice  — Google Chirp 3 HD ieraksti (voice/lv/*.mp3), ja visas daļas ir ierakstītas
                              2. NeuralVoice    — Piper "Rūdolfs"/"Aivars" telefonā (63 MB, bez interneta)
                              3. speechSynthesis — telefona iebūvētā balss (teksts iet caur voiceNormalize)
```

* Balss nesaka ielu nosaukumus un runā uz "tu", tāpēc visu, ko tā jebkad pasaka, var ierakstīt iepriekš.
  Tās ir **131 frāze** (`voicePhraseLibrary()`): attālumi, manevri, "tad …" ķēdes, brīdinājumi un dažas fiksētas frāzes.
* Tests `U` pārbauda, ka katra teikuma daļa, ko navigācija var izveidot, ir bibliotēkā. Ja kāda daļa tomēr
  trūkst, šo teikumu pasaka rezerves balss. Navigācija nekad nepaliek klusa.
* Lapā **nav API atslēgas**. Ieraksti ir parasti statiski faili. Telefons tos saglabā (Cache API, ~2 MB),
  tāpēc tie strādā bez interneta un tiek atskaņoti uzreiz.
* Atskaņošana:
  * Teikumi neiet viens pāri otram, jo tie stāv rindā.
  * To pašu teikumu 4 sekunžu laikā otrreiz nesaka.
  * Teikumu, kas rindā gaidījis ilgāk par 8 s, izlaiž, jo tas vairs neatbilst vietai uz ceļa.
  * Pēc maršruta pārrēķina vecās norādes tiek pārtrauktas, un tiek pateikts "Maršruts pārrēķināts".
  * Kompresors uztur vienmērīgu skaļumu.

## Kāpēc Google Chirp 3 HD (salīdzinājums, 2026. gada oktobris)

| Iespēja | Latviešu valoda | Piezīmes |
|---|---|---|
| **Google Cloud TTS Chirp 3 HD** | `lv-LV` ir oficiālajā sarakstā (nav atzīmēts kā Preview) | 30 balsis. Ātrumu var regulēt (`speakingRate` 0,25–2). Latviešu valodai **nav** pauzes kontroles un pielāgotas izrunas. SSML ir Preview. Cena $30 / 1 M rakstzīmju, pirmais 1 M mēnesī bez maksas. |
| Microsoft Azure AI Speech | Neironu balsu sarakstu latviešu valodai no dokumentācijas nevarēju apstiprināt (jāpārbauda ar `voices/list` savā reģionā) | Bez maksas 0,5 M rakstzīmju mēnesī. |
| ElevenLabs | Latviešu valoda (`lv`) ir tikai modelim **Eleven v3** (Multilingual v2 un Flash v2.5 to neatbalsta) | Abonements. Augstāka aizkave. |
| Piper (Rūdolfs/Aivars) | Jā, CC0 licence | Darbojas telefonā, bez maksas, bet mazāk dabiski. Paliek kā rezerves balss. |
| Telefona balss | Atkarīgs no telefona | Pēdējā rezerve. |

Izvēlējos Google Chirp 3 HD:
* Latviešu valoda ir oficiāli atbalstīta.
* Visas frāzes var ģenerēt vienreiz, ietilpstot bezmaksas limitā (viena balss ≈ 3 300 rakstzīmes).
* Nav vajadzīgs serveris, un braukšanas laikā nav aizkaves.

**Konkrēto balsi (no 30) vēl neesmu izvēlējies.** Es tās nevaru noklausīties, tāpēc izvēle notiek ar
paraugiem (skat. zemāk). Ierakstus neesmu ģenerējis, un to skanējumu neesmu pārbaudījis.

## Izvēlētā balss: ElevenLabs "Ilze" (Eleven v4)

Balsi izvēlējās lietotājs, noklausoties ElevenLabs: **Ilze – Calm, Warm, Unhurried**.
Balss ID ir `4nP0MRk3S5Qj1fGfXf51`, modelis `eleven_v4` (atbalsta latviešu valodu `lv`).

1. ElevenLabs → Settings → API Keys → izveido atslēgu. Pietiek ar tiesībām "Text to Speech".
2. Projekta mapē palaid:
   ```
   set ELEVENLABS_API_KEY=tava-atslēga        (cmd)
   node tools/gen-voice.mjs ilze
   ```
   Tas izveido `voice/lv/` (131 frāze, ≈ 3 300 rakstzīmes). Ja temps šķiet par ātru, palaid
   `node tools/gen-voice.mjs ilze --rate 0.92`.
3. Augšupielādē `voice/lv/`. Aplikācija pati pārslēgsies uz "Ilze (ieraksti)".

## Iestatīšana ar Google (alternatīva)

1. Uzinstalē **Node.js 18+** (nodejs.org).
2. Atver Google Cloud Console un izveido projektu (vai izmanto esošu). Tad:
   * ieslēdz **Cloud Text-to-Speech API**;
   * pievieno norēķinu kontu (Google to prasa, bet 1 M rakstzīmju mēnesī ir bez maksas);
   * izveido **API atslēgu** un ierobežo to tikai uz Text-to-Speech API.
3. Komandrindā projekta mapē iestati atslēgu:
   ```
   set GOOGLE_TTS_API_KEY=tava-atslēga        (Windows cmd)
   $env:GOOGLE_TTS_API_KEY="tava-atslēga"      (PowerShell)
   ```
   Ja API atslēga netiek pieņemta, izmanto `gcloud auth login` un `set GOOGLE_CLOUD_PROJECT=projekta-id`.
   Skripts tad žetonu paņem pats.
4. Apskati, kuras balsis ir pieejamas:
   ```
   node tools/gen-voice.mjs voices
   ```
5. Ģenerē paraugus. Visām Chirp 3 HD balsīm tas aizņem ≈ 10 000 rakstzīmju (bez maksas):
   ```
   node tools/gen-voice.mjs samples
   ```
   Pēc tam atver `voice/samples/index.html` un noklausies (skat. "Kā vērtēt").
6. Ģenerē visu navigācijas balsi ar izvēlēto balsi:
   ```
   node tools/gen-voice.mjs build --voice Charon
   node tools/gen-voice.mjs build --voice Charon --rate 0.95     (nedaudz lēnāk)
   ```
   Tiek izveidota mape `voice/lv/` (manifest.json + ~131 mp3 faili). Ja komandu palaid vēlreiz, tiek
   ģenerētas tikai jaunās vai mainītās frāzes.
7. Augšupielādē mapi `voice/lv/` GitHub repozitorijā. Kad ieraksti ir lapā, aplikācija pati pārslēdzas
   uz tiem. Iestatījumos parādās izvēle "Google … (ieraksti)".

`voice/samples/` nav jāaugšupielādē.

## Kā vērtēt (ieteicams 3–5 latviešu valodas runātāji)

1. Atver `voice/samples/index.html` telefonā. Klausies ar auto skaļruni vai austiņām, nevis datora skaļruņiem.
2. Katrai balsij novērtē no 1 līdz 5:
   * **saprotamība** pie trokšņa (pagriez skaļumu uz pusi un ieslēdz ventilatoru vai mūziku);
   * **izruna**: garumzīmes (ā, ē, ī, ū) un mīkstinājumi (ļ, ņ, ķ, ģ), piemēram "izbrauktuvi", "galamērķī";
   * **dabiskums un temps**: vai nav par ātru un vai nav robotiski.
3. Atlasi 2–3 labākās balsis un noklausies tās vēlreiz pēc kārtas (bez nosaukumiem, ja to var izdarīt).
4. Uzvarētāju ģenerē ar `build`. Ja temps ir par ātru vai par lēnu, maini `--rate` (0,9–1,05).
5. Brauciens: ieslēdz aplikācijas "Testa režīmu" (simulēts brauciens) un noklausies vienu maršrutu ar apli
   un vairākiem pagriezieniem.

## Izmaksas

**Izvēlētā pieeja (ieraksti):** viena balss ≈ 3 300 rakstzīmes, paraugi ≈ 10 000. Abi ietilpst bezmaksas
1 M rakstzīmju mēnesī, tāpēc **$0** neatkarīgi no lietotāju skaita. Katrs lietotājs vienreiz lejupielādē
~2 MB. GitHub Pages ieteicamais limits ir ~100 GB mēnesī, tas ir ap 50 000 jaunu lietotāju mēnesī. Ja
lietotāju būs vairāk, lapu var pārcelt uz citu statisku hostingu.

**Salīdzinājumam — ja katru teikumu ģenerētu braukšanas laikā** (vajadzētu serveri un atslēgu uz servera):
* Pieņēmumi: 5 h navigācijas mēnesī uz lietotāju; ~25 teikumi stundā (pagriezieni un brīdinājumi); ~40 rakstzīmes teikumā.
* Tas ir ≈ 5 000 rakstzīmju uz lietotāju mēnesī.
* Cena: Chirp 3 HD $30 / 1 M pēc bezmaksas 1 M. Kešatmiņu šajā aprēķinā neņem vērā.

| Lietotāji mēnesī | Rakstzīmes | Chirp 3 HD tiešsaistē | Ieraksti |
|---|---|---|---|
| 1 000 | 5 M | ≈ $120 | $0 |
| 10 000 | 50 M | ≈ $1 470 | $0 |
| 100 000 | 500 M | ≈ $14 970 | $0 (+ hostings) |

## Ierobežojumi

* Ielu nosaukumus balss nesaka (tā izvēlēts). Ja tos vajadzēs, vajadzēs serveri, kas ģenerē tiešsaistē
  (atslēga paliek uz servera), un izrunas vārdnīcu. Google latviešu valodai pielāgotu izrunu neatbalsta.
* Joslu norādes netiek runātas, jo maršruta dati par joslām netiek izmantoti.
* Teikums sastāv no 2–3 atsevišķi ierakstītām daļām ar 90 ms pauzi. Tas skan nedaudz mazāk plūstoši nekā
  viens vesels ieraksts, bet ļauj iztikt ar 131 failu tūkstošu vietā.
* Pārlūkā nevar pārvaldīt "audio focus": mūzika netiek automātiski klusināta, kamēr balss runā.

## Faili

* `voice.js` — frāzes, bibliotēka, normalizācija, balsu ķēde (`Voice`)
* `recorded-voice.js` — ierakstu atskaņotājs (`RecordedVoice`)
* `neural-voice.js` — Piper balss telefonā
* `tools/gen-voice.mjs` — ierakstu ģenerēšana (Google TTS)
* `tests/run.js` — testi S, U, V, W (balss)
