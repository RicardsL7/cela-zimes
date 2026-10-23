# Ceļa Zīmes

Navigācijas karte Latvijai, kas rāda ceļa zīmes uz ceļa. Zīmes var izslēgt ar vienu pogu
vai pa kategorijām (ātrums, STOP, luksofori, pārejas, kameras u.c.).

## Kā palaist datorā

1. Atver mapi `cela-zimes` VS Code.
2. Terminal → New Terminal un ieraksti:
   ```
   python -m http.server 8000
   ```
3. Pārlūkā atver **http://localhost:8000**
4. Atļauj atrašanās vietu. Ja dators to nezina, atver iestatījumus
   (poga "Iestat.") → ieslēdz **Testa režīmu** un noklikšķini uz ceļa kartē.

Lai apturētu serveri: terminālī nospied `Ctrl + C`.

## Kā tas strādā

| Daļa | No kurienes |
|---|---|
| Karte | OpenStreetMap |
| Ceļa zīmes un ātruma ierobežojumi | OpenStreetMap, caur Overpass API |
| Adrešu meklēšana | Nominatim (OpenStreetMap) |
| Maršruts | OSRM |

Faili:
- `index.html` — lapas struktūra
- `style.css` — izskats
- `signs.js` — kā OSM dati pārvēršas zīmēs un to ikonas
- `app.js` — karte, GPS, zīmju ielāde, slēdži, maršruts

## Ierobežojumi

- Zīmes rāda tikai tās, kas ir ievadītas OpenStreetMap. Rīgā to ir daudz,
  laukos mazāk. Ātruma ierobežojumi nāk no ceļu datiem.
- Bezmaksas serveri (OpenStreetMap karte, Overpass, OSRM, Nominatim) domāti nelielai lietošanai.
  Ja lietotni lietos daudz cilvēku, vajadzēs savu serveri vai maksas pakalpojumu.
- Telefonā GPS strādā tikai caur `https://`. Vienkāršākais veids: GitHub Pages.
